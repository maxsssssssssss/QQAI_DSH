// Temporary operator probe: real DSH inference, no QQ sends or production mood writes.
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync,
  renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const SCOPE = 'real live DSH askModel and installed mood parser with synthetic input; not a natural QQ activity trigger or production mood/history change'

export default {
  id: 'qqai-mood-probe', name: 'QQAI 临时心情接口验证', version: '0.1.0',
  description: '一次性真实模型验证；不发 QQ、不写生产心情或记忆',
  async setup(api) {
    const file = api.dataDir('result.json')
    chmodSync(dirname(file), 0o700)
    if (existsSync(file)) return { scope: SCOPE, alreadyAttempted: true }
    let marker
    try { marker = openSync(file, 'wx', 0o600) }
    catch (error) {
      if (error?.code === 'EEXIST') return { scope: SCOPE, alreadyAttempted: true }
      throw new Error('Cannot reserve private mood probe result')
    }
    const result = { scope: SCOPE, ok: false, pending: true, startedAt: new Date().toISOString(),
      qqSendRequested: false, productionMoodWritten: false, memoryWritten: false,
      actualRequests: [] }
    try { writeFileSync(marker, JSON.stringify(result)); fsyncSync(marker) }
    finally { closeSync(marker) }
    try {
      const cfg = api.config()
      if (!cfg.mood?.enabled || !cfg.mood?.judge) throw new Error('mood judge not enabled')
      result.sourceSha256 = {
        llm: digest(join(api.core.root, 'src/core/llm.js')),
        companion: digest(join(api.core.root, 'src/features/companion.js')),
      }
      const live = api.dsh.llm || api.dsh.get('llm')
      if (!live || typeof live.stream !== 'function') throw new Error('DSH llm unavailable')
      // Delegate to the live service with its original receiver. No shared method is changed.
      const wrapped = new Proxy(live, { get(target, key) {
        if (key === 'stream') return function (params) {
          result.actualRequests.push({
            provider: params.provider === 'deepseek-official' ? params.provider : 'unexpected',
            model: params.model === 'deepseek-flash' ? params.model : 'unexpected',
            reasoningEffort: params.reasoningEffort === 'off' ? 'off' : 'unexpected-or-absent',
            maxTokens: Number.isFinite(params.maxTokens) ? params.maxTokens : null,
          })
          return Reflect.apply(target.stream, target, [params])
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      const probeDsh = { llm: wrapped, get: (key) => key === 'llm' ? wrapped : api.dsh.get(key) }
      const { askModel } = api.lib('core/llm.js')
      const { parseMoodJudge } = api.lib('features/companion.js')
      const v = 60, scene = '这一轮是主人在跟她说话'
      const out = await askModel(probeDsh, {
        cfg: { model: { ...cfg.model }, mood: { ...cfg.mood } },
        system: '你在判断聊天角色「大肥鱼」聊完一轮后的心情变化。她现在心情 ' + v + '/100（60 是平常）。' + scene + '。只看这一轮真正影响她心情的东西：被夸、被关心、被惦记会开心；被凶、被冷落、被嫌弃会难过；开玩笑的「讨厌~」「笨蛋」不算真骂。只输出 JSON：{"delta": -15~15 的整数, "reason": "十几个字的理由", "confidence": 0~1 你有多确定}。没什么影响就 delta 为 0。',
        text: '主人说：谢谢你一直陪我，和你聊天很开心\n她回：听你这么说，我也很开心呀，会继续陪着你的。',
        maxTokens: 400, temperature: 0.2,
      })
      const parsed = parseMoodJudge(out)
      result.validParsed = Boolean(parsed && Number.isInteger(parsed.delta)
        && parsed.delta >= -15 && parsed.delta <= 15 && Number.isFinite(parsed.confidence)
        && parsed.confidence >= 0 && parsed.confidence <= 1)
      if (result.validParsed) {
        result.delta = parsed.delta
        result.confidence = parsed.confidence
        result.wouldApply = parsed.confidence >= 0.6 && Math.abs(parsed.delta) >= 2
      }
      result.ok = result.validParsed && result.actualRequests.length > 0
        && result.actualRequests.every((r) => r.provider === 'deepseek-official'
          && r.model === 'deepseek-flash' && r.reasoningEffort === 'off' && r.maxTokens === 400)
    } catch {
      result.error = 'mood-probe-failed-private-details-omitted'
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
