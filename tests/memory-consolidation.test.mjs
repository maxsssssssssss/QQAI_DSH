// These are fault-injection unit tests of the actual pinned upstream module.
// They do not stand in for real DeepSeek or QQ memory acceptance.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PATCHES, patchedSource } from '../scripts/patch-plugin-media.mjs'

const memoryPatch = PATCHES.find((p) => p.file === 'src/features/memory.js')
const dayKey = (offset = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const row = (id = '11111', text = '合成测试偏好海盐汽水') => ({
  chatId: `private:${id}`, who: 'synthetic-owner', uid: id, text, t: Date.now(),
})

async function fixture(t, logs, answer) {
  if (!process.env.AURABOT_SOURCE_ROOT) {
    t.skip('Set AURABOT_SOURCE_ROOT to the reviewed pinned package')
    return
  }
  const raw = await readFile(join(process.env.AURABOT_SOURCE_ROOT, memoryPatch.file), 'utf8')
  const patched = patchedSource(raw, memoryPatch)
  // The public module imports only these store/model functions and randomUUID.
  // In-memory storage is cloned at each boundary to model its JSON persistence.
  const body = patched.replace(/^import .*\n/gm, '').replace(/^export /gm, '')
  const create = new Function('randomUUID', 'dataDir', 'readJson', 'writeJson', 'askModel', body + '\nreturn createMemoryStore')
  const disk = new Map()
  const calls = []
  const deleted = []
  const factCalls = []
  const cfg = { ownerQQ: '11111', botQQ: '99999', ownerName: '合成测试主人',
    memory: { enabled: true, dailyConsolidate: true, consolidateTimes: ['00:00'], recallCount: 6 } }
  const askModel = async (_, options) => {
    calls.push(options)
    if (options.system.includes('整理长期记忆')) {
      factCalls.push(options)
      return answer(options, factCalls.length)
    }
    if (options.system.includes('人物小档案')) return '合成测试档案'
    return '{"insights":[],"style":[]}'
  }
  const factory = create(randomUUID, (name) => name,
    (file, fallback) => structuredClone(disk.has(file) ? disk.get(file) : typeof fallback === 'function' ? fallback() : fallback),
    (file, value) => disk.set(file, structuredClone(value)), askModel)
  const memory = factory({ dsh: {}, getConfig: () => cfg,
    hub: { chatLogDays: () => Object.keys(logs), chatLogOf: (day) => (logs[day] || []).slice(),
      deleteChatLog: (day) => { deleted.push(day); delete logs[day] } },
    log: { info() {}, warn() {} } })
  return { memory, logs, factCalls, calls, deleted, cfg,
    seedState: (state) => disk.set('memories.json', structuredClone(state)),
    state: () => structuredClone(disk.get('memories.json') || { items: [] }) }
}

test('API failure keeps old log and cursor; the scheduled tick retries successfully', async (t) => {
  const yesterday = dayKey(-1)
  let attempts = 0
  const f = await fixture(t, { [yesterday]: [row(), row(), row()] }, () => {
    if (++attempts === 1) throw new Error('temporary provider outage')
    return '[{"text":"合成测试主人喜欢海盐汽水","importance":0.8}]'
  })
  if (!f) return
  await f.memory.tick()
  assert.equal(f.factCalls.length, 1)
  assert.equal(f.logs[yesterday].length, 3)
  assert.equal(f.state().processed?.[yesterday] || 0, 0)
  assert.equal(f.state().processedByChat?.[yesterday]?.['private:11111'] || 0, 0)
  assert.equal(f.state().runs?.['00:00'], undefined)
  assert.equal(f.state().lastConsolidate.failed, 1)
  await f.memory.tick()
  assert.equal(f.factCalls.length, 2)
  assert.equal(f.logs[yesterday], undefined)
  assert.equal(f.state().items.length, 1)
  assert.equal(f.state().items[0].source, 'auto')
  assert.equal(f.state().runs['00:00'], dayKey())
})

test('fewer than three owner messages accumulate across dates without being consumed', async (t) => {
  const before = dayKey(-2), yesterday = dayKey(-1), today = dayKey()
  const f = await fixture(t, { [before]: [row()], [yesterday]: [row()] }, () => '[]')
  if (!f) return
  const first = await f.memory.consolidate({ includeToday: true })
  assert.equal(first.ok, true)
  assert.equal(first.pending, 1)
  assert.equal(first.failed, 0)
  assert.equal(f.factCalls.length, 0)
  assert.deepEqual(f.deleted, [])
  assert.equal(f.state().processed?.[before] || 0, 0)
  assert.equal(f.state().processed?.[yesterday] || 0, 0)
  f.logs[today] = [row()]
  const second = await f.memory.consolidate({ includeToday: true })
  assert.equal(second.ok, true)
  assert.equal(second.pending, 0)
  assert.equal(f.factCalls.length, 1)
  assert.deepEqual(f.deleted, [before, yesterday])
  assert.equal(f.state().processed[today], 1)
})

test('a successful empty fact result advances its chat only and is not repeated when another chat fails', async (t) => {
  const yesterday = dayKey(-1)
  let badAttempts = 0, goodAttempts = 0
  const lines = [row('11111'), row('22222'), row('11111'), row('22222'), row('11111'), row('22222')]
  const f = await fixture(t, { [yesterday]: lines }, ({ text }) => {
    if (text.includes('(22222)')) {
      if (++badAttempts === 1) throw new Error('temporary failure')
    } else goodAttempts++
    return '[]'
  })
  if (!f) return
  const first = await f.memory.consolidate({ includeToday: true })
  assert.equal(first.ok, false)
  assert.equal(f.logs[yesterday].length, 6)
  assert.equal(f.state().processed[yesterday], 1)
  assert.equal(f.state().processedByChat[yesterday]['private:11111'], 5)
  assert.equal(f.state().processedByChat[yesterday]['private:22222'], undefined)
  assert.equal((await f.memory.consolidate({ includeToday: true })).ok, true)
  assert.equal(goodAttempts, 1)
  assert.equal(badAttempts, 2)
  assert.equal(f.logs[yesterday], undefined)
})

test('valid [] consumes a completed current-day batch without inventing memories', async (t) => {
  const today = dayKey()
  const f = await fixture(t, { [today]: [row(), row(), row()] }, () => '[]')
  if (!f) return
  assert.equal((await f.memory.consolidate({ includeToday: true })).ok, true)
  assert.equal(f.state().processed[today], 3)
  assert.deepEqual(f.state().items, [])
  assert.equal(f.logs[today].length, 3)
  await f.memory.consolidate({ includeToday: true })
  assert.equal(f.factCalls.length, 1)
})

test('missing, malformed, or structurally invalid fact output remains retryable', async (t) => {
  for (const output of ['', 'not JSON', '[broken]', '[null]', '[{"unexpected":"field"}]']) {
    const yesterday = dayKey(-1)
    const f = await fixture(t, { [yesterday]: [row(), row(), row()] }, () => output)
    if (!f) return
    const result = await f.memory.consolidate({ includeToday: true })
    assert.equal(result.ok, false, output)
    assert.equal(result.failed, 1, output)
    assert.equal(f.logs[yesterday].length, 3, output)
    assert.equal(f.state().processed?.[yesterday] || 0, 0, output)
  }
})

test('an API error whose text says 内容太少 is still an error, not a sparse-chat result', async (t) => {
  const yesterday = dayKey(-1)
  const f = await fixture(t, { [yesterday]: [row(), row(), row()] }, () => { throw new Error('内容太少') })
  if (!f) return
  const result = await f.memory.consolidate({ includeToday: true })
  assert.equal(result.ok, false)
  assert.equal(result.failed, 1)
  assert.equal(f.logs[yesterday].length, 3)
})

test('a line arriving during extraction is retained even on an old log day', async (t) => {
  const yesterday = dayKey(-1)
  const logs = { [yesterday]: [row(), row(), row()] }
  const f = await fixture(t, logs, () => { logs[yesterday].push(row('11111', '稍后抵达的合成消息')); return '[]' })
  if (!f) return
  assert.equal((await f.memory.consolidate({ includeToday: true })).ok, true)
  assert.equal(f.logs[yesterday].length, 4)
  assert.equal(f.state().processed[yesterday], 3)
  assert.deepEqual(f.deleted, [])
})

test('more than 240 unread rows are all extracted before advancing the cursor', async (t) => {
  const today = dayKey()
  const lines = Array.from({ length: 241 }, (_, i) => row('11111', `合成流水条目 ${i}`))
  const f = await fixture(t, { [today]: lines }, () => '[]')
  if (!f) return
  assert.equal((await f.memory.consolidate({ includeToday: true })).ok, true)
  assert.equal(f.factCalls.length, 4)
  assert.ok(f.factCalls[0].text.includes('合成流水条目 0'))
  assert.ok(f.factCalls.at(-1).text.includes('合成流水条目 240'))
  assert.equal(f.state().processed[today], 241)
})

test('disabling memory or daily consolidation never expires unprocessed old log rows', async (t) => {
  const old = dayKey(-20)
  for (const setting of ['enabled', 'dailyConsolidate']) {
    const f = await fixture(t, { [old]: [row(), row()] }, () => '[]')
    if (!f) return
    f.cfg.memory[setting] = false
    await f.memory.tick()
    assert.equal(f.logs[old].length, 2, setting)
    assert.deepEqual(f.deleted, [], setting)
    assert.equal(f.factCalls.length, 0, setting)
    assert.equal(f.state().processed?.[old] || 0, 0, setting)
  }
})

test('fallback retention removes only fully consumed logs, retaining mixed pending days', async (t) => {
  const consumedDay = dayKey(-21), pendingDay = dayKey(-20)
  const logs = {
    [consumedDay]: [row('22222'), row('11111')],
    [pendingDay]: [row('22222'), row('11111')],
  }
  const f = await fixture(t, logs, () => '[]')
  if (!f) return
  f.seedState({ items: [], processed: { [consumedDay]: 1, [pendingDay]: 1 },
    processedByChat: { [consumedDay]: { 'private:11111': 2 } } })
  f.cfg.memory.dailyConsolidate = false
  await f.memory.tick()
  assert.deepEqual(f.deleted, [consumedDay])
  assert.equal(f.logs[pendingDay].length, 2)
  assert.equal(f.state().processed[pendingDay], 1)
  assert.equal(f.state().processed[consumedDay], undefined)
  assert.equal(f.state().processedByChat[consumedDay], undefined)
})

test('partial multi-chunk failure retries the batch without claiming exactly-once fact extraction', async (t) => {
  const today = dayKey()
  const fact = '[{"text":"合成测试主人喜欢海盐汽水","importance":0.8}]'
  const f = await fixture(t, { [today]: Array.from({ length: 81 }, () => row()) }, (_, attempt) => {
    if (attempt === 2) throw new Error('second chunk temporarily failed')
    return attempt === 1 || attempt === 3 ? fact : '[]'
  })
  if (!f) return
  const first = await f.memory.consolidate({ includeToday: true })
  assert.equal(first.ok, false)
  assert.equal(f.state().items.length, 1)
  assert.equal(f.state().processed?.[today] || 0, 0)
  assert.equal(f.logs[today].length, 81)
  const second = await f.memory.consolidate({ includeToday: true })
  assert.equal(second.ok, true)
  assert.equal(f.factCalls.length, 4)
  assert.equal(f.state().items.length, 1)
  assert.equal(f.state().processed[today], 81)
})
