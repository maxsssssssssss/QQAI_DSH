// Real pinned normalization and scheduling code with synthetic inputs/time only.
// Never load/save private configuration, invoke a model or send QQ messages.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PATCHES, patchedSource } from '../scripts/patch-plugin-media.mjs'
import { PROACTIVE_LIMIT_PATCHES } from '../scripts/proactive-limits-patch-spec.mjs'

const root = process.env.AURABOT_SOURCE_ROOT
const spec = PROACTIVE_LIMIT_PATCHES[0]
const minute = 60_000
const target = { maxPerDay: 30, minIntervalMinutes: 40, maxIntervalMinutes: 80 }
const hash = text => createHash('sha256').update(text).digest('hex')

async function source(t, file) {
  if (!root) { t.skip('Set AURABOT_SOURCE_ROOT to the pinned installed Aurabot source'); return }
  return readFile(join(root, file), 'utf8')
}

async function configFixture(t) {
  const raw = await source(t, spec.file); if (!raw) return
  const patched = patchedSource(raw, spec)
  // Accept an already-patched installation, while reconstructing only the reviewed
  // original line for the comparison. Both complete modules run their real imports.
  const original = hash(raw.trimEnd() + '\n') === spec.after
    ? patched.replace(spec.replacement, spec.needle) : raw.trimEnd() + '\n'
  assert.equal(hash(original), spec.before)
  const load = async text => {
    const moduleText = text.replace(/from (['"])(\.\.?\/[^'"\n]+)\1/g, (_all, _quote, path) =>
      `from ${JSON.stringify(pathToFileURL(resolve(dirname(join(root, spec.file)), path)).href)}`)
    return import('data:text/javascript;base64,' + Buffer.from(moduleText).toString('base64'))
  }
  return { original, patched, before: await load(original), after: await load(patched) }
}

async function scheduler(t, { random = 0.5, hour = 18, count = 12, nextAt = 0 } = {}) {
  const raw = await source(t, 'src/features/companion.js'); if (!raw) return
  const code = patchedSource(raw, PATCHES.find(p => p.file === 'src/features/companion.js'))
  const start = code.indexOf('export function createSpeakUp(')
  assert.ok(start > 0)
  let now = Date.parse('2026-10-31T10:00:00Z')
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
    getHours() { return hour }
  }
  const math = Object.create(Math); math.random = () => random
  const cfg = { enabled: true, ownerQQ: '11111', ownerName: '合成主人',
    speakUp: { enabled: true, ...target, idleMinutes: 40, awakeFrom: 8, awakeTo: 23, nudge: true } }
  let disk = { day: new Clock().toDateString(), count, nextAt,
    last: now - 120 * minute, nudgedFor: now - 180 * minute }
  const pushes = []
  const hub = { lastOwnerChatAt: now - 90 * minute,
    lastBotToOwner: { at: now - 80 * minute, text: '合成陈述。' },
    pushToSession: async (...args) => { pushes.push(args) } }
  const create = new Function('dataDir', 'readJson', 'writeJson', 'Date', 'Math',
    code.slice(start).replace('export function', 'function') + '\nreturn createSpeakUp')(
      name => name, () => structuredClone(disk), (_file, value) => { disk = structuredClone(value) }, Clock, math)
  const restart = () => create({ getConfig: () => cfg, hub, log: { info() {} }, isMuted: () => false })
  return { api: restart(), restart, hub, cfg, pushes, state: () => structuredClone(disk),
    now: () => now, advance: ms => { now += ms } }
}

test('fixed native config patch is exact, idempotent and rejects source drift', async t => {
  const f = await configFixture(t); if (!f) return
  assert.equal(hash(f.patched), spec.after)
  assert.equal(patchedSource(f.patched, spec), f.patched)
  assert.equal(f.patched.replace(spec.replacement, spec.needle), f.original)
  assert.throws(() => patchedSource(f.original + '// unreviewed change\n', spec), /unreviewed source hash/)
})

test('real normalize retains thirty and preserves unrelated normalization and existing defaults', async t => {
  const f = await configFixture(t); if (!f) return
  assert.deepEqual(f.after.normalize({}), f.before.normalize({}))
  for (const [input, expected] of [[0, 0], [20, 20], [30, 30], [31, 30], [999, 30], [-1, 0], ['30', 30]]) {
    const raw = { speakUp: { enabled: true, ...target, maxPerDay: input, idleMinutes: 40, nudge: true },
      model: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' },
      memory: { enabled: true, recallCount: 10, consolidateTimes: ['04:00', '16:00'] },
      mood: { enabled: true, judge: true, halfLifeHours: 3 },
      ext: { 'qqai-compat': { botName: '小鲸', personaText: '合成人格' } } }
    const before = f.before.normalize(raw), after = f.after.normalize(raw)
    assert.equal(after.speakUp.maxPerDay, expected)
    before.speakUp.maxPerDay = expected
    assert.deepEqual(after, before, 'only the approved ordinary daily ceiling may differ')
    assert.equal(after.speakUp.minIntervalMinutes, 40)
    assert.equal(after.speakUp.maxIntervalMinutes, 80)
    assert.equal(after.speakUp.nudge, true)
  }
})

test('panel merge and JSON round trip keep thirty instead of silently clamping back to twenty', async t => {
  const f = await configFixture(t); if (!f) return
  const current = f.after.normalize({ speakUp: { enabled: true, maxPerDay: 20,
    minIntervalMinutes: 30, maxIntervalMinutes: 60, idleMinutes: 40, nudge: true },
    ext: { 'qqai-compat': { botName: '小鲸', personaText: '合成人格' } } })
  const saved = f.after.mergeFromPanel(current, { speakUp: target })
  assert.deepEqual(saved, { ...current, speakUp: { ...current.speakUp, ...target } })
  assert.deepEqual(f.after.normalize(JSON.parse(JSON.stringify(saved))), saved)
})

test('native first scheduling uses forty to eighty minutes without clearing same-day count or nudge state', async t => {
  for (const random of [0, 0.5, 1 - Number.EPSILON]) {
    const f = await scheduler(t, { random }); if (!f) return
    const before = f.state()
    await f.api.tick()
    const after = f.state()
    assert.ok(after.nextAt >= f.now() + 40 * minute && after.nextAt <= f.now() + 80 * minute)
    assert.deepEqual({ ...after, nextAt: before.nextAt }, before)
    assert.equal(f.pushes.length, 0)
  }
})

test('native scheduler can consume attempt thirty and then stops ordinary attempts at the new cap', async t => {
  const f = await scheduler(t, { count: 29, nextAt: 1 }); if (!f) return
  const before = f.state()
  await f.api.tick()
  const after = f.state()
  assert.equal(after.count, 30)
  assert.equal(f.pushes.length, 1)
  assert.equal(after.nextAt, f.now() + 60 * minute)
  assert.equal(after.nudgedFor, before.nudgedFor)
  f.advance(81 * minute)
  await f.restart().tick()
  assert.equal(f.state().count, 30)
  assert.equal(f.pushes.length, 1)
  assert.equal(f.state().nextAt, after.nextAt)
})

test('ordinary idle still follows the last message from either side and must exceed forty minutes', async t => {
  for (const recent of ['owner', 'bot']) {
    const f = await scheduler(t, { count: 6, nextAt: 1 }); if (!f) return
    if (recent === 'owner') f.hub.lastOwnerChatAt = f.now() - 35 * minute
    else f.hub.lastBotToOwner.at = f.now() - 35 * minute
    await f.api.tick()
    f.advance(5 * minute)
    await f.api.tick()
    assert.equal(f.state().count, 6)
    assert.equal(f.pushes.length, 0)
    f.advance(minute)
    await f.api.tick()
    assert.equal(f.state().count, 7)
    assert.equal(f.pushes.length, 1)
  }
})

test('enabled native nudge remains outside the thirty-attempt quota and does not rewrite the ordinary deadline', async t => {
  const f = await scheduler(t, { random: 0.4, count: 30, nextAt: 1 }); if (!f) return
  f.hub.lastBotToOwner = { at: f.now() - 20 * minute, text: '合成测试，你在忙吗？' }
  const before = f.state()
  await f.api.tick()
  assert.equal(f.pushes.length, 1)
  assert.ok(f.pushes[0][1][0].text.includes('轻轻追一句'))
  assert.equal(f.state().count, before.count)
  assert.equal(f.state().nextAt, before.nextAt)
  assert.equal(f.state().last, before.last)
  assert.equal(f.state().nudgedFor, f.hub.lastBotToOwner.at)
  await f.restart().tick()
  assert.equal(f.pushes.length, 1)
})

test('the unchanged night window blocks ordinary proactive attempts', async t => {
  const f = await scheduler(t, { count: 6, nextAt: 1, hour: 23 }); if (!f) return
  const before = f.state()
  await f.api.tick()
  assert.deepEqual(f.state(), before)
  assert.equal(f.pushes.length, 0)
})
