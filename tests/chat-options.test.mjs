// Isolated regressions of native QQ-face/nudge behavior. No QQ or model traffic.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PATCHES, patchedSource } from '../scripts/patch-plugin-media.mjs'
import { mediaHooks } from '../adapters/qqai-compat/index.mjs'

const root = process.env.AURABOT_SOURCE_ROOT
const dataModule = (source) => import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
async function source(t, file, patch = false) {
  if (!root) { t.skip('Set AURABOT_SOURCE_ROOT to the pinned Aurabot package'); return }
  const raw = await readFile(join(root, file), 'utf8')
  return patch ? patchedSource(raw, PATCHES.find((entry) => entry.file === file)) : raw
}

async function faceFixture(t) {
  const raw = await source(t, 'src/chat/faces.js'); if (!raw) return
  const facesModule = await dataModule(raw)
  const calls = []
  const onebot = { call: async (action) => {
    calls.push(action)
    assert.equal(action, 'fetch_sys_faces')
    return { packs: [{ emojis: [{ q_sid: '264', q_des: '/捂脸', emoji_name_alias: ['合成别名'] }] }] }
  } }
  const faces = facesModule.createFaces({ onebot, log: { debug() {} } })
  const hubSource = await source(t, 'src/chat/hub.js', true)
  const start = hubSource.indexOf('  async function sendText(')
  const end = hubSource.indexOf('\n  async function sendVoice(', start)
  assert.ok(start > 0 && end > start)
  const cfg = { stickers: { enabled: false, faces: true } }, sent = []
  const make = new Function('getConfig', 'textToSegments', 'stripFaceTags', 'faces', 'sendSegments',
    `const quote=()=>[], mention=()=>[];\n${hubSource.slice(start, end)}\nreturn sendText;`)
  const sendText = make(() => cfg, facesModule.textToSegments, facesModule.stripFaceTags, faces,
    async (chatId, segments) => { sent.push({ chatId, segments }); return { message_id: 'synthetic-receipt' } })
  return { ...facesModule, faces, cfg, calls, sent, sendText }
}

async function nudgeFixture(t, { hour = 17, random = 0.4, muted = false } = {}) {
  const src = await source(t, 'src/features/companion.js', true); if (!src) return
  const start = src.indexOf('export function createSpeakUp(')
  assert.ok(start > 0)
  let now = Date.parse('2026-10-31T09:00:00Z')
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
    getHours() { return hour }
  }
  const math = Object.create(Math); math.random = () => random
  const cfg = { enabled: true, ownerQQ: '11111', ownerName: '合成主人',
    speakUp: { enabled: true, nudge: true, maxPerDay: 20, minIntervalMinutes: 30,
      maxIntervalMinutes: 60, idleMinutes: 40, awakeFrom: 8, awakeTo: 23 } }
  let disk = { day: new Clock().toDateString(), count: 20, nextAt: now + 3600000, last: now - 3600000 }
  const pushes = []
  const hub = { lastOwnerChatAt: now - 3600000,
    lastBotToOwner: { at: now - 20 * 60000, text: '合成测试，你在忙吗？' },
    pushToSession: async (...args) => { pushes.push(args) } }
  const create = new Function('dataDir', 'readJson', 'writeJson', 'Date', 'Math',
    src.slice(start).replace('export function', 'function') + '\nreturn createSpeakUp')(
    (name) => name, () => structuredClone(disk), (_path, value) => { disk = structuredClone(value) }, Clock, math)
  const restartModule = () => create({ getConfig: () => cfg, hub, log: { info() {} }, isMuted: () => muted })
  return { api: restartModule(), restartModule, cfg, hub, pushes, state: () => structuredClone(disk),
    now: () => now, advance: (ms) => { now += ms }, setRandom: (value) => { random = value } }
}

test('native sendText converts QQ faces while the separate sticker-library feature is disabled', async (t) => {
  const f = await faceFixture(t); if (!f) return
  await f.faces.refresh()
  await f.sendText('private:11111', '合成<face:捂脸>测试')
  assert.deepEqual(f.sent[0].segments, [
    { type: 'text', data: { text: '合成' } }, { type: 'face', data: { id: '264' } },
    { type: 'text', data: { text: '测试' } },
  ])
  assert.deepEqual(f.calls, ['fetch_sys_faces'])
  assert.equal(f.faces.idOf('合成别名'), 264)
  const hooks = mediaHooks({ getPort: () => 3080, getKit: () => null,
    getDataDir: () => '/synthetic/not-read', getOwner: () => '11111' })
  assert.deepEqual(hooks.send(f.sent[0].segments, { chatId: 'private:11111' }), f.sent[0].segments)
})

test('turning faces off removes tags; unknown names never leak raw tags', async (t) => {
  const f = await faceFixture(t); if (!f) return
  f.cfg.stickers.faces = false
  await f.sendText('private:11111', '合成<face:捂脸>测试')
  assert.deepEqual(f.sent[0].segments, [{ type: 'text', data: { text: '合成测试' } }])
  f.cfg.stickers.faces = true
  await f.sendText('private:11111', '合成<face:不存在的表情>测试')
  assert.deepEqual(f.sent[1].segments, [{ type: 'text', data: { text: '合成测试' } }])
})

test('native face instructions are available with the stickers module disabled', async (t) => {
  const f = await faceFixture(t); if (!f) return
  const src = await source(t, 'src/persona/personas.js')
  const start = src.indexOf('export function rulesText(')
  assert.ok(start > 0)
  const rules = new Function('FACE_EXAMPLES', src.slice(start).replace('export function', 'function') + '\nreturn rulesText')(f.FACE_EXAMPLES)
  const cfg = { ownerQQ: '11111', stickers: { enabled: false, faces: true } }
  assert.ok(rules('private', cfg, { off: new Set(['stickers']) }).includes('<face:捂脸>'))
  cfg.stickers.faces = false
  assert.ok(!rules('private', cfg, { off: new Set(['stickers']) }).includes('<face:捂脸>'))
})

test('one question receives at most one nudge attempt and preserves daily count and nextAt', async (t) => {
  const f = await nudgeFixture(t); if (!f) return
  const before = f.state()
  await f.api.tick()
  assert.equal(f.pushes.length, 1)
  assert.equal(f.state().count, 20, 'nudges are outside the ordinary daily quota')
  assert.equal(f.state().nextAt, before.nextAt)
  assert.equal(f.state().last, before.last)
  assert.equal(f.state().nudgedFor, f.hub.lastBotToOwner.at)
  assert.equal(f.pushes[0][0].chatId, 'private:11111')
  assert.ok(f.pushes[0][1][0].text.includes('[沉默]'))
  await f.api.tick()
  await f.restartModule().tick()
  assert.equal(f.pushes.length, 1)
})

test('the random skip consumes that question attempt instead of rerolling every minute', async (t) => {
  const f = await nudgeFixture(t, { random: 0.8 }); if (!f) return
  await f.api.tick()
  assert.equal(f.pushes.length, 0)
  assert.equal(f.state().nudgedFor, f.hub.lastBotToOwner.at)
  f.setRandom(0.1)
  f.advance(60000)
  await f.api.tick()
  assert.equal(f.pushes.length, 0)
})

test('native nudge respects disabled, muted, night, replied, non-question, and 15-to-40-minute gates', async (t) => {
  const scenarios = [
    { options: {}, change: (f) => { f.cfg.speakUp.nudge = false } },
    { options: { muted: true } }, { options: { hour: 23 } },
    { options: {}, change: (f) => { f.hub.lastOwnerChatAt = f.now() - 60000 } },
    { options: {}, change: (f) => { f.hub.lastBotToOwner.text = '合成陈述。' } },
    { options: {}, change: (f) => { f.hub.lastBotToOwner.at = f.now() - 15 * 60000 } },
    { options: {}, change: (f) => { f.hub.lastBotToOwner.at = f.now() - 40 * 60000 } },
  ]
  for (const scenario of scenarios) {
    const f = await nudgeFixture(t, scenario.options); if (!f) return
    scenario.change?.(f)
    await f.api.tick()
    assert.equal(f.pushes.length, 0)
    assert.equal(f.state().nudgedFor, undefined)
  }
})

test('a new question can become another nudge target, but a full hub restart does not restore an old pending question', async (t) => {
  const f = await nudgeFixture(t); if (!f) return
  await f.api.tick()
  f.hub.lastBotToOwner = { at: f.now(), text: '新的合成问题呢？' }
  f.advance(20 * 60000)
  await f.api.tick()
  assert.equal(f.pushes.length, 2, 'the implementation deduplicates messages, not an entire unanswered chain')
  f.hub.lastOwnerChatAt = 0
  f.hub.lastBotToOwner = { at: 0, text: '' }
  await f.restartModule().tick()
  assert.equal(f.pushes.length, 2)
})
