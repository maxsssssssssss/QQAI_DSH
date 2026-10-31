// Boundary and data-flow regressions of the pinned patched Aurabot implementation.
// Synthetic fixtures are not a substitute for real-model or QQ acceptance.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PATCHES, patchedSource } from '../scripts/patch-plugin-media.mjs'

const root = process.env.AURABOT_SOURCE_ROOT
const chat = { kind: 'private', chatId: 'private:11111', userId: '11111' }
const hintPrefix = '（你记得这些事，方括号里是什么时候的事，聊到相关的就自然用上，别把老事当新事说，也别说「根据记忆」：'
const dataModule = (source) => import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const dayKey = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function patched(t, file) {
  if (!root) { t.skip('Set AURABOT_SOURCE_ROOT to the pinned Aurabot package'); return }
  return patchedSource(await readFile(join(root, file), 'utf8'), PATCHES.find((entry) => entry.file === file))
}

function fact(i, text = `合成档案 MEMO${String(i).padStart(2, '0')} ${'鲸'.repeat(65)}。`) {
  return { id: `synthetic-${i}`, text, about: chat.userId, aboutName: '', tags: [],
    importance: 1, source: 'auto', at: Date.now(), hits: 0 }
}

function hintBody(hint) {
  assert.ok(hint.startsWith(hintPrefix))
  assert.ok(hint.endsWith('）'))
  return hint.slice(hintPrefix.length, -1)
}

async function memoryFixture(t, { items = [], logs = {}, answer = () => '[]' } = {}) {
  const source = await patched(t, 'src/features/memory.js'); if (!source) return
  const disk = new Map([['memories.json', { items: structuredClone(items) }]])
  const calls = []
  const cfg = { ownerQQ: chat.userId, botQQ: '99999', ownerName: '合成主人',
    memory: { enabled: true, recallCount: 10, dailyConsolidate: true, consolidateTimes: ['00:00'] } }
  const askModel = async (_dsh, options) => {
    calls.push(options)
    if (options.system.includes('整理长期记忆')) return answer(options)
    if (options.system.includes('人物小档案')) return '合成档案'
    return '{"insights":[],"style":[]}'
  }
  const make = new Function('randomUUID', 'dataDir', 'readJson', 'writeJson', 'askModel',
    source.replace(/^import .*\n/gm, '').replace(/^export /gm, '') + '\nreturn createMemoryStore')
  const create = make(randomUUID, (name) => name,
    (file, fallback) => structuredClone(disk.has(file) ? disk.get(file) : typeof fallback === 'function' ? fallback() : fallback),
    (file, value) => disk.set(file, structuredClone(value)), askModel)
  const memory = create({ dsh: {}, getConfig: () => cfg,
    hub: { chatLogDays: () => Object.keys(logs), chatLogOf: (day) => (logs[day] || []).slice(),
      deleteChatLog: (day) => { delete logs[day] } }, log: { info() {}, warn() {} } })
  return { memory, cfg, calls, state: () => structuredClone(disk.get('memories.json')) }
}

async function logFixture(t) {
  const source = await patched(t, 'src/chat/hub.js'); if (!source) return
  const start = source.indexOf('  function logChat(')
  const end = source.indexOf('\n  /** 有聊天流水的日期', start)
  assert.ok(start > 0 && end > start)
  const redaction = await dataModule(await readFile(join(root, 'src/core/redact.js'), 'utf8'))
  const rows = []
  const make = new Function('dataDir', 'mkdirSync', 'appendFileSync', 'join', 'redact',
    source.slice(start, end) + '\nreturn logChat')
  const logChat = make((name) => name, () => {}, (_file, line) => rows.push(JSON.parse(line)), join, redaction.redact)
  return { logChat, rows, registerSecret: redaction.registerSecret }
}

test('automatic recall includes complete fifth through eighth facts beyond the old 300-character budget', async (t) => {
  const f = await memoryFixture(t, { items: Array.from({ length: 12 }, (_, i) => fact(i + 1)) }); if (!f) return
  assert.equal(f.memory.recall('合成档案', { about: chat.userId }).length, 10)
  const body = hintBody(f.memory.recallHint(chat, '合成档案'))
  assert.ok(body.length > 300 && body.length <= 1600)
  assert.equal((body.match(/MEMO\d{2}/g) || []).length, 8)
  for (let i = 1; i <= 8; i++) assert.ok(body.includes(`MEMO${String(i).padStart(2, '0')}`))
  assert.ok(!body.includes('MEMO09'))
  for (const line of body.split('；')) assert.ok(line.endsWith('。'), 'every selected fact remains complete')
})

test('recall skips an over-budget fact and still includes a later shorter candidate intact', async (t) => {
  // Seed legacy/panel-sized records directly: automatic add normally caps a fact at 200 characters.
  const first = '合成档案 FIRST ' + '甲'.repeat(1000) + ' 第一条结束。'
  const tooLarge = '合成档案 OMIT ' + '乙'.repeat(1800) + ' 超长条结束。'
  const last = '合成档案 LAST ' + '丙'.repeat(100) + ' 最后一条结束。'
  const f = await memoryFixture(t, { items: [fact(1, first), fact(2, tooLarge), fact(3, last)] }); if (!f) return
  const body = hintBody(f.memory.recallHint(chat, '合成档案'))
  assert.ok(body.includes(first))
  assert.ok(body.includes(last))
  assert.ok(!body.includes('OMIT'))
  assert.ok(body.length <= 1600)
  assert.ok(!body.includes('…'), 'budget must not shorten a fact into a potentially different claim')
})

test('a skipped top candidate does not prevent filling eight slots from later retrieved candidates', async (t) => {
  const oversized = fact(0, 'OVERSIZED ' + '巨'.repeat(1800))
  const later = Array.from({ length: 8 }, (_, i) => ({ ...fact(i + 1), importance: 0.8 }))
  const f = await memoryFixture(t, { items: [oversized, ...later] }); if (!f) return
  const query = '给我一些提示'
  assert.equal(f.memory.recall(query, { about: chat.userId })[0].it.id, oversized.id)
  const body = hintBody(f.memory.recallHint(chat, query))
  assert.equal((body.match(/MEMO\d{2}/g) || []).length, 8)
  assert.ok(!body.includes('OVERSIZED'))
  assert.ok(body.includes('MEMO08'))
  assert.ok(body.length <= 1600)
})

test('combined recall budget never cuts a negation or remaining fact in half', async (t) => {
  const items = Array.from({ length: 10 }, (_, i) => fact(i + 1,
    `合成档案 MEMO${String(i + 1).padStart(2, '0')} ${'描述'.repeat(105)} 注意：这件事没有发生。`))
  const f = await memoryFixture(t, { items }); if (!f) return
  const body = hintBody(f.memory.recallHint(chat, '合成档案'))
  const lines = body.split('；')
  assert.ok(lines.length > 4 && lines.length <= 8)
  assert.ok(body.length <= 1600)
  for (const line of lines) assert.ok(line.endsWith('注意：这件事没有发生。'))
})

test('disabled memory does not append the expanded recall block', async (t) => {
  const f = await memoryFixture(t, { items: [fact(1)] }); if (!f) return
  f.cfg.memory.enabled = false
  assert.equal(f.memory.recallHint(chat, '合成档案'), '')
  assert.equal(f.state().items[0].hits, 0)
})

test('chat logging keeps a late fact beyond 500 characters and still caps user and bot rows at 2000', async (t) => {
  const f = await logFixture(t); if (!f) return
  const retained = '铺'.repeat(650) + '合成主人偏好的饮品是松针茶。' + '垫'.repeat(100)
  for (const who of ['synthetic-owner', 'bot']) f.logChat(chat.chatId, who, retained, '11111')
  assert.equal(f.rows.length, 2)
  assert.ok(f.rows.every((row) => row.text === retained))
  f.logChat(chat.chatId, 'synthetic-owner', '文'.repeat(2100), '11111')
  assert.equal(f.rows[2].text.length, 2000)
  assert.equal(f.rows[2].uid, '11111')
})

test('newly retained log text is still processed by the real redactor', async (t) => {
  const f = await logFixture(t); if (!f) return
  const known = 'synthetic-known-secret-for-memory-limit-regression'
  f.registerSecret(known)
  const text = '铺'.repeat(650) + ' password=synthetic-password-value ' + known + ' 安全尾部。'
  f.logChat(chat.chatId, 'synthetic-owner', text, '11111')
  assert.equal(f.rows.length, 1)
  assert.ok(f.rows[0].text.endsWith('安全尾部。'))
  assert.ok(!f.rows[0].text.includes('synthetic-password-value'))
  assert.ok(!f.rows[0].text.includes(known))
  assert.ok(f.rows[0].text.includes('password=***'))
})

test('long chat rows reach the real consolidation function with the late fact intact', async (t) => {
  const logs = await logFixture(t); if (!logs) return
  const lateFact = '合成主人喜欢松针茶。'
  logs.logChat(chat.chatId, 'synthetic-owner', '这是一段无关铺垫。'.repeat(90) + lateFact, '11111')
  logs.logChat(chat.chatId, 'synthetic-owner', '这是合成测试资料。', '11111')
  logs.logChat(chat.chatId, 'synthetic-owner', '请记住饮品偏好。', '11111')
  const f = await memoryFixture(t, { logs: { [dayKey()]: logs.rows }, answer: ({ text }) => {
    assert.ok(text.includes(lateFact))
    return JSON.stringify([{ text: lateFact, about_qq: '11111', importance: 0.8 }])
  } }); if (!f) return
  const result = await f.memory.consolidate({ includeToday: true })
  assert.equal(result.ok, true)
  assert.equal(f.calls.filter((call) => call.system.includes('整理长期记忆')).length, 1)
  assert.equal(f.state().items.length, 1)
  assert.equal(f.state().items[0].text, lateFact)
  assert.equal(f.state().processed[dayKey()], 3)
})

test('redaction happens before clipping a known synthetic secret across the 2000-character boundary', async (t) => {
  const f = await logFixture(t); if (!f) return
  const secret = 'synthetic-secret-straddling-new-log-boundary'
  f.registerSecret(secret)
  f.logChat(chat.chatId, 'synthetic-owner', '铺'.repeat(1990) + secret + ' 尾部。', '11111')
  assert.equal(f.rows.length, 1)
  assert.ok(f.rows[0].text.length <= 2000)
  assert.ok(f.rows[0].text.includes('***'))
  assert.ok(!f.rows[0].text.includes('synthetic-'))
})

test('expanded logs are extracted in bounded batches without dropping any part of a large conversation', async (t) => {
  const rows = Array.from({ length: 45 }, (_, i) => ({
    chatId: chat.chatId, who: 'synthetic-owner', uid: chat.userId, t: Date.now(),
    text: `ROW${String(i).padStart(3, '0')} ` + '铺'.repeat(1900) + ' 完整行尾。',
  }))
  const f = await memoryFixture(t, { logs: { [dayKey()]: rows } }); if (!f) return
  const result = await f.memory.consolidate({ includeToday: true })
  assert.equal(result.ok, true)
  const extraction = f.calls.filter((call) => call.system.includes('整理长期记忆'))
  assert.ok(extraction.length >= 3, 'over 80k characters must not become one extraction request')
  assert.ok(extraction.every((call) => call.text.length <= 40000))
  assert.ok(extraction.every((call) => call.maxTokens === 1500))
  const seen = extraction.flatMap((call) => call.text.match(/ROW\d{3}/g) || [])
  assert.deepEqual(seen, rows.map((_, i) => `ROW${String(i).padStart(3, '0')}`))
  assert.ok(extraction.every((call) => call.text.endsWith('完整行尾。')))
  assert.equal(f.state().processed[dayKey()], rows.length)
})

test('a legacy row longer than the batch budget remains whole and does not consume later rows', async (t) => {
  const texts = ['LEGACY_HEAD ' + '旧'.repeat(41000) + ' LEGACY_TAIL', 'LATER_ROW_ONE', 'LATER_ROW_TWO']
  const rows = texts.map((text) => ({ chatId: chat.chatId, who: 'synthetic-owner', uid: chat.userId, t: Date.now(), text }))
  const f = await memoryFixture(t, { logs: { [dayKey()]: rows } }); if (!f) return
  const result = await f.memory.consolidate({ includeToday: true })
  assert.equal(result.ok, true)
  const extraction = f.calls.filter((call) => call.system.includes('整理长期记忆'))
  assert.equal(extraction.length, 2)
  assert.ok(extraction[0].text.includes(texts[0]))
  assert.ok(extraction[1].text.includes(texts[1]) && extraction[1].text.includes(texts[2]))
  assert.equal(f.state().processed[dayKey()], 3)
})
