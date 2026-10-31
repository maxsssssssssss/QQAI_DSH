// Temporary operator probe. Uses installed code and real DSH inference with synthetic
// input; all chatlog and memory I/O is redirected into isolated in-memory stores.
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync,
  renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const SCOPE = 'installed chatlog and memory implementation with isolated synthetic state and real DSH inference; no QQ sends or production memory writes'
const MAX_REQUESTS = 6
const digest = (value) => createHash('sha256').update(value).digest('hex')
const clone = (value) => structuredClone(value)
const usageKeys = ['inputTokens', 'outputTokens', 'uncachedInputTokens', 'cacheReadTokens',
  'cacheWriteTokens', 'input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens',
  'total_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']

function captureUsage(record, chunk) {
  for (const usage of [chunk?.usage, chunk?.tokenUsage, chunk?.response?.usage]) {
    if (!usage || typeof usage !== 'object') continue
    for (const key of usageKeys) {
      if (Number.isFinite(usage[key]) && usage[key] >= 0) (record.usage ||= {})[key] = usage[key]
    }
  }
}

function makeMemoryFactory(source, askModel) {
  // The reviewed pinned module imports only these four dependencies. Reject a
  // future import layout instead of accidentally loading its production store.
  const body = source.replace(/^import [^\n]*\n/gm, '').replace(/^export /gm, '')
  if (/^\s*(?:import|export)\s/m.test(body)) throw new Error('Unreviewed memory imports')
  return (dsh, cfg, chatlogs, initial = { items: [] }) => {
    const disk = new Map([['memories.json', clone(initial)]])
    const factory = new Function('randomUUID', 'dataDir', 'readJson', 'writeJson', 'askModel',
      body + '\nreturn createMemoryStore')
    const createMemoryStore = factory(randomUUID, (name) => name,
      (file, fallback) => clone(disk.has(file) ? disk.get(file)
        : typeof fallback === 'function' ? fallback() : fallback),
      (file, value) => { disk.set(file, clone(value)) }, askModel)
    const hub = {
      chatLogDays: () => [...chatlogs.keys()].sort(),
      chatLogOf: (day) => clone(chatlogs.get(day) || []),
      deleteChatLog: (day) => { chatlogs.delete(day) },
    }
    const memory = createMemoryStore({ dsh, getConfig: () => cfg, hub,
      log: { info() {}, warn() {} } })
    return { memory, state: () => clone(disk.get('memories.json')) }
  }
}

function isolatedChatLogger(source, redact, chatlogs) {
  const start = source.indexOf('  function logChat(')
  const end = source.indexOf('\n  /** 有聊天流水的日期', start)
  if (start < 0 || end <= start || source.indexOf('  function logChat(', start + 1) >= 0) {
    throw new Error('Unreviewed chat logger layout')
  }
  const createLogger = new Function('dataDir', 'mkdirSync', 'appendFileSync', 'join', 'redact',
    source.slice(start, end) + '\nreturn logChat')
  return createLogger((name) => name, () => {}, (file, text) => {
    const day = basename(file, '.jsonl')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Unexpected isolated log path')
    const rows = chatlogs.get(day) || []
    for (const line of String(text).split('\n').filter(Boolean)) rows.push(JSON.parse(line))
    chatlogs.set(day, rows)
  }, join, redact)
}

export default {
  id: 'qqai-memory-limits-probe', name: 'QQAI 临时记忆容量验证', version: '0.1.0',
  description: '一次性真实模型验证；合成数据内存隔离，不发 QQ、不写生产记忆',
  async setup(api) {
    const file = api.dataDir('result.json')
    chmodSync(dirname(file), 0o700)
    if (existsSync(file)) return { scope: SCOPE, alreadyAttempted: true }
    let marker
    try { marker = openSync(file, 'wx', 0o600) }
    catch (error) {
      if (error?.code === 'EEXIST') return { scope: SCOPE, alreadyAttempted: true }
      throw new Error('Cannot reserve private memory probe result')
    }
    const result = { scope: SCOPE, ok: false, pending: true, startedAt: new Date().toISOString(),
      qqSendRequested: false, productionMemoryWritten: false, productionChatlogWritten: false,
      actualRequests: [], requestLimit: MAX_REQUESTS }
    try { writeFileSync(marker, JSON.stringify(result)); fsyncSync(marker) }
    finally { closeSync(marker) }
    try {
      result.stage = 'prepare'
      const liveConfig = api.config()
      if (liveConfig.model?.provider !== 'deepseek-official'
        || liveConfig.model?.model !== 'deepseek-flash'
        || liveConfig.model?.reasoningEffort !== 'off'
        || !liveConfig.memory?.enabled || liveConfig.memory?.recallCount !== 10) {
        throw new Error('Unexpected memory probe configuration')
      }
      // No real owner IDs, cookies, history, or other config fields enter a prompt.
      const cfg = { ownerQQ: '12345', botQQ: '99999', ownerName: '合成验收人物',
        model: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' },
        memory: { enabled: true, recallCount: 10, dailyConsolidate: true,
          consolidateTimes: ['04:00', '16:00'] },
        group: { ownerBrief: { enabled: false } } }
      const memorySource = readFileSync(join(api.core.root, 'src/features/memory.js'), 'utf8')
      const hubSource = readFileSync(join(api.core.root, 'src/chat/hub.js'), 'utf8')
      const llmSource = readFileSync(join(api.core.root, 'src/core/llm.js'))
      result.sourceSha256 = { memory: digest(memorySource), hub: digest(hubSource), llm: digest(llmSource) }
      const live = api.dsh.llm || api.dsh.get('llm')
      if (!live || typeof live.stream !== 'function') throw new Error('DSH llm unavailable')
      const wrapped = new Proxy(live, { get(target, key) {
        if (key === 'stream') return async function* (params) {
          if (result.actualRequests.length >= MAX_REQUESTS) throw new Error('Probe request limit reached')
          const record = {
            provider: params.provider === 'deepseek-official' ? params.provider : 'unexpected',
            model: params.model === 'deepseek-flash' ? params.model : 'unexpected',
            reasoningEffort: params.reasoningEffort === 'off' ? 'off' : 'unexpected-or-absent',
            maxTokens: Number.isFinite(params.maxTokens) ? params.maxTokens : null,
            outputCharacters: 0,
          }
          result.actualRequests.push(record)
          if (record.provider === 'unexpected' || record.model === 'unexpected'
            || record.reasoningEffort !== 'off') throw new Error('Unexpected probe model route')
          for await (const chunk of Reflect.apply(target.stream, target, [params])) {
            if (chunk?.type === 'text-delta') record.outputCharacters += String(chunk.text || '').length
            captureUsage(record, chunk)
            yield chunk
          }
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      const dsh = { llm: wrapped, get: (key) => key === 'llm' ? wrapped : api.dsh.get(key) }
      const { askModel } = api.lib('core/llm.js')
      const { redact } = api.lib('core/redact.js')
      const makeMemory = makeMemoryFactory(memorySource, askModel)
      const chatlogs = new Map()
      const logChat = isolatedChatLogger(hubSource, redact, chatlogs)
      const padding = '这是合成的日常闲聊填充，不包含需要长期记住的事实。'.repeat(40)
      const preference = '绀蓝星砂风铃'
      const longInput = padding + `真正希望长期记住的偏好是：我最喜欢收藏${preference}；以后挑礼物请优先考虑它。`
      logChat('private:12345', '合成验收人物', longInput, '12345')
      logChat('private:12345', '合成验收人物', '补充一条长期习惯：每周二晚固定练习陶笛。', '12345')
      logChat('private:12345', '合成验收人物', '还有一个明确偏好：饮料不加糖，不要为我选甜饮料。', '12345')
      const rows = [...chatlogs.values()].flat()
      result.longChat = { inputCharacters: longInput.length, loggedCharacters: rows[0]?.text?.length || 0,
        targetOffset: longInput.indexOf(preference), targetPastOldLimit: longInput.indexOf(preference) > 800,
        targetPreserved: Boolean(rows[0]?.text?.includes(preference)), rowCount: rows.length }
      if (!result.longChat.targetPastOldLimit || !result.longChat.targetPreserved
        || result.longChat.loggedCharacters < 1000 || result.longChat.loggedCharacters > 2000) {
        throw new Error('Long chat retention probe failed')
      }
      result.stage = 'real-consolidation'
      const extraction = makeMemory(dsh, cfg, chatlogs)
      const consolidated = await extraction.memory.consolidate({ includeToday: true })
      const facts = extraction.state().items || []
      result.consolidation = { ok: consolidated.ok === true, added: Number(consolidated.added) || 0,
        failed: Number(consolidated.failed) || 0, pending: Number(consolidated.pending) || 0,
        activeFacts: facts.filter((m) => !m.invalidAt).length,
        latePreferenceExtracted: facts.some((m) => !m.invalidAt && /星砂/.test(m.text) && /风铃/.test(m.text)) }

      result.stage = 'recall-prompt'
      const labels = ['海棠钟摆', '银砂陶杯', '紫铜棱镜', '雾蓝书签', '松针玻璃球',
        '青柠风车', '赤陶水母', '铂金纸鹤', '乌木小铃', '雪松陀螺']
      const descriptions = [
        '合成验收人物最珍惜的厨房挂饰是海棠钟摆，喜欢它缓慢摆动的样子；希望谈到厨房布置时记得这个选择，不用把它解释成其他用途。',
        '合成验收人物为周末野餐挑选的专用杯子是银砂陶杯，主要用来装温水；准备野餐物品时应沿用这个器具，不要和家里的杯子混淆。',
        '合成验收人物书柜顶层最喜欢陈列紫铜棱镜，欣赏傍晚阳光照射时的颜色；书柜整理方案中应给这个收藏留出一块独立的位置。',
        '合成验收人物读长篇小说习惯使用雾蓝书签，喜欢用它记录每晚停止阅读的位置；讨论阅读习惯时可以记得这个长期的小习惯。',
        '合成验收人物窗台植物旁边摆着松针玻璃球，喜欢在浇水后观察里面的纹理；这是固定的窗台装饰，和其他收藏物放在不同位置。',
        '合成验收人物出门露营时总会带上青柠风车，借风吹转动判断帐篷附近的风向；这是露营清单上的固定小物，平日收在背包侧袋。',
        '合成验收人物最喜欢的展览纪念品是赤陶水母，重视它手工烧制的质感；如果问起最喜欢的展览纪念品，应记住这个具体名字。',
        '合成验收人物给书桌抽屉选定的装饰是铂金纸鹤，喜欢折纸般的线条；整理抽屉时会把这件装饰单独放好，不把它挪到窗台上。',
        '合成验收人物计划为玄关购买乌木小铃，希望每天出门时能听见轻轻一声；这是尚未实施的玄关布置计划，不是已经购买的物品。',
        '合成验收人物准备在明年手工课制作雪松陀螺，想学习保持旋转平衡的方法；这是未来的学习安排，不能说成已经完成的作品。',
      ]
      const at = Date.now()
      const seeded = { items: descriptions.map((text, i) => ({ id: `probe-${i}`, text,
        about: '12345', aboutName: '', importance: 0.8, source: 'tool', at, hits: 0 })) }
      const recall = makeMemory(dsh, cfg, new Map(), seeded)
      const hint = recall.memory.recallHint({ kind: 'private', chatId: 'private:12345', userId: '12345' }, '嗯')
      const present = labels.map((label) => hint.includes(label))
      const contentStart = hint.indexOf('：')
      const body = contentStart >= 0 && hint.endsWith('）') ? hint.slice(contentStart + 1, -1) : ''
      result.recall = { configuredCandidates: cfg.memory.recallCount, seededFacts: descriptions.length,
        includedFacts: present.filter(Boolean).length, fifthThroughEighthPresent: present.slice(4, 8).every(Boolean),
        ninthAndTenthExcluded: present.slice(8).every((value) => !value),
        hintCharacters: hint.length, bodyCharacters: body.length,
        exceedsOldBodyLimit: body.length > 300, withinNewBodyLimit: body.length <= 1600 }
      if (!result.recall.fifthThroughEighthPresent || !result.recall.ninthAndTenthExcluded
        || result.recall.includedFacts !== 8 || !result.recall.exceedsOldBodyLimit
        || !result.recall.withinNewBodyLimit) throw new Error('Expanded recall prompt probe failed')
      result.stage = 'real-recall-answer'
      const answer = await askModel(dsh, { cfg,
        system: '你在回答合成人物的记忆验收问题。只根据附带的记忆回答；不知道就说不知道，不要编造。',
        text: hint + '\n我最喜欢的展览纪念品叫什么？只回答名字。',
        maxTokens: 120, temperature: 0.2 })
      result.recall.seventhFactUsedByModel = answer.includes(labels[6])
      result.ok = result.consolidation.ok && result.consolidation.failed === 0
        && result.consolidation.latePreferenceExtracted && result.recall.seventhFactUsedByModel
        && result.actualRequests.length >= 3 && result.actualRequests.length <= MAX_REQUESTS
        && result.actualRequests.every((r) => r.provider === 'deepseek-official'
          && r.model === 'deepseek-flash' && r.reasoningEffort === 'off')
      result.stage = 'complete'
    } catch {
      result.error = 'memory-limits-probe-failed-private-details-omitted'
    }
    result.pending = false
    result.finishedAt = new Date().toISOString()
    const temp = file + '.complete.tmp'
    const fd = openSync(temp, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(result, null, 2)); fsyncSync(fd) }
    finally { closeSync(fd) }
    renameSync(temp, file)
    const dir = openSync(dirname(file), 'r')
    try { fsyncSync(dir) } finally { closeSync(dir) }
    return { ok: result.ok, scope: SCOPE }
  },
}
