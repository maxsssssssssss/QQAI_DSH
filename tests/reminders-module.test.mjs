// Synthetic integration tests; these are not real API/QQ acceptance evidence.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync,
  statSync, symlinkSync, linkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import module, { beijingTime, ownerChat, createRequestGrants, privateStore } from '../adapters/qqai-reminders/index.mjs'

const OWNER = '1234567', BOT = '7654321', OTHER = '1234568'
const base = Date.parse('2026-10-31T16:00:00+08:00')
const chat = () => ({ kind: 'private', chatId: `private:${OWNER}`, userId: OWNER })
const capability = (content) => content.at(-1).text.match(/request_token=([a-f\d-]{36})/)?.[1]

test('owner chat requires exact owner private target and Beijing time is host-independent', () => {
  assert.equal(ownerChat(chat(), { ownerQQ: OWNER }), true)
  for (const value of [null, `private:${OWNER}`, { ...chat(), kind: 'group' },
    { ...chat(), userId: OTHER }, { ...chat(), chatId: `private:${OTHER}` }]) {
    assert.equal(ownerChat(value, { ownerQQ: OWNER }), false)
  }
  assert.equal(beijingTime(Date.parse('2026-10-31T16:00:00Z')), '2026-11-01T00:00:00+08:00')
})

test('capabilities are granted only by actual owner prompts and autonomous turns revoke them', () => {
  let clock = base
  const cfg = { ownerQQ: OWNER }
  const grants = createRequestGrants({ getConfig: () => cfg, now: () => clock })
  const content = [{ type: 'text', text: '一分钟后提醒我喝水' }]
  const info = { chat: chat(), senderId: OWNER, sessionId: 'test-session' }
  const output = grants.prompt(content, info), token = capability(output)
  assert.ok(token)
  assert.equal(content.length, 1)
  assert.equal(grants.check(info.sessionId, token), true)
  assert.equal(grants.check('different-session', token), false)
  assert.equal(grants.check(info.sessionId, 'made-up-token'), false)
  assert.equal(grants.prompt(content, { ...info, senderId: '' }), content)
  assert.equal(grants.check(info.sessionId, token), false)
  for (const bad of [{ ...info, senderId: OTHER }, { ...info, chat: { ...chat(), kind: 'system' } },
    { ...info, chat: { ...chat(), chatId: `private:${OTHER}`, userId: OTHER } }]) {
    assert.equal(grants.prompt(content, bad), content)
  }
  clock += 1000
  const fresh = capability(grants.prompt(content, info))
  assert.notEqual(fresh, token)
  assert.equal(grants.check(info.sessionId, fresh), true)
  cfg.ownerQQ = OTHER
  assert.equal(grants.check(info.sessionId, fresh), false)
})

test('queued request cannot reuse earlier token; expiration, backwards clock and clear fail closed', () => {
  let clock = base
  const grants = createRequestGrants({ getConfig: () => ({ ownerQQ: OWNER }), now: () => clock })
  const info = { chat: chat(), senderId: OWNER, sessionId: 'queued' }
  const first = capability(grants.prompt([{ type: 'text', text: '提醒甲' }], info))
  const second = capability(grants.prompt([{ type: 'text', text: '提醒乙' }], info))
  assert.notEqual(first, second)
  assert.equal(grants.check('queued', first), false)
  assert.equal(grants.check('queued', second), true)
  clock = base - 1
  assert.equal(grants.check('queued', second), false)
  clock = base + 10 * 60_000
  assert.equal(grants.check('queued', second), false)
  const third = capability(grants.prompt([], info))
  assert.equal(grants.check('queued', third), true)
  grants.clear()
  assert.equal(grants.check('queued', third), false)
})

test('prefixed prompt IDs and unprefixed tool IDs resolve to one grant and idempotency record', () => {
  const grants = createRequestGrants({ getConfig: () => ({ ownerQQ: OWNER }), now: () => base })
  const info = { chat: chat(), senderId: OWNER, sessionId: 'session-01234567-89ab-cdef' }
  const token = capability(grants.prompt([{ type: 'text', text: '一分钟后提醒我喝水' }], info))
  assert.equal(grants.check('01234567-89ab-cdef', token), true)
  assert.equal(grants.check(info.sessionId, token), true)
  assert.equal(grants.check('other-01234567-89ab-cdef', token), false)
  let creates = 0
  const create = () => { creates++; return { ok: true, task: { id: 'synthetic' }, message: '已保存合成任务' } }
  const args = { text: '合成前缀测试', delayMinutes: 1 }
  assert.equal(grants.createOnce('01234567-89ab-cdef', args, create).ok, true)
  assert.equal(grants.createOnce(info.sessionId, { ...args, repeat: 'once' }, create).duplicate, true)
  assert.equal(creates, 1)
})

test('autonomous prompt clears the same grant regardless of session prefix form', () => {
  const grants = createRequestGrants({ getConfig: () => ({ ownerQQ: OWNER }), now: () => base })
  const content = [{ type: 'text', text: '合成主人请求' }]
  const info = { chat: chat(), senderId: OWNER, sessionId: 'session-clear-prefix' }
  const first = capability(grants.prompt(content, info))
  grants.prompt(content, { ...info, senderId: '', sessionId: 'clear-prefix' })
  assert.equal(grants.check(info.sessionId, first), false)
  const second = capability(grants.prompt(content, { ...info, sessionId: 'clear-prefix' }))
  grants.prompt(content, { ...info, senderId: '' })
  assert.equal(grants.check('clear-prefix', second), false)
})

function harness(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'qqai-reminders-module-'))
  const moduleData = join(directory, 'data'); mkdirSync(moduleData)
  const cfg = { enabled: true, dryRun: false, ownerQQ: OWNER, botQQ: BOT }
  const settings = { enabled: true }
  const hooks = new Map(), routes = new Map(), timers = [], builders = [], disposers = [], sent = []
  let clock = options.now ?? base, muted = false, identity = BOT, mapped = `private:${OWNER}`
  const api = {
    config: () => cfg, settings: () => settings, dataDir: name => join(moduleData, name),
    every: (_ms, callback) => timers.push(callback), on: (event, callback) => hooks.set(event, callback),
    context: callback => { api.contextProvider = callback }, tool: builder => builders.push(builder),
    defineTool: spec => spec, route: (name, handler) => routes.set(name, handler),
    onDispose: callback => disposers.push(callback),
    core: { onebot: { state: 'connected', call: async (action, params) => {
      assert.equal(action, 'get_login_info'); assert.deepEqual(params, {})
      return { user_id: identity }
    } }, mutes: { muted: target => { assert.equal(target, `private:${OWNER}`); return muted } },
    hub: { chatOfSession: () => mapped, logChat: () => {} } },
    sendSegments: async (target, segments, note) => {
      sent.push({ target, segments, note }); return options.receipt ?? { message_id: 1001 }
    },
  }
  const previousClock = Date.now
  Date.now = () => clock
  try { module.setup(api) } finally { Date.now = previousClock }
  t.after(() => { for (const dispose of disposers) dispose(); rmSync(directory, { recursive: true, force: true }) })
  const where = { chat: chat(), level: 'full', sessionId: 'owner-session' }
  const tools = Object.fromEntries(builders[0](where).map(tool => [tool.name, tool]))
  const authorize = (senderId = OWNER) => capability(hooks.get('prompt')([{ type: 'text', text: '一分钟后提醒我喝水' }],
    { chat: chat(), senderId, sessionId: options.prefixedPromptSession ? 'session-' + where.sessionId : where.sessionId }))
  return { directory, moduleData, cfg, settings, hooks, routes, timers, builders, disposers, sent, api, tools, where,
    authorize, advance: ms => { clock += ms }, setMuted: value => { muted = value },
    setIdentity: value => { identity = value }, setMapped: value => { mapped = value },
    create: args => tools.qq_reminder_create.execute({ text: '合成提醒测试', delayMinutes: 1, request_token: authorize(), ...args }),
    tick: () => timers[0](), status: () => routes.get('/state')({ method: 'GET' }) }
}

test('new module initializes without a state file and exposes tools only in owner private chat', t => {
  const h = harness(t)
  assert.equal(h.status().ready, true)
  assert.equal(Object.keys(h.tools).length, 3)
  for (const where of [{ ...h.where, level: 'social' }, { ...h.where, level: 'chat' },
    { ...h.where, chat: { kind: 'system', chatId: 'system:test' } },
    { ...h.where, chat: { ...chat(), userId: OTHER, chatId: `private:${OTHER}` } },
    { ...h.where, chat: { kind: 'group', groupId: OWNER, chatId: `group:${OWNER}` } }]) {
    assert.deepEqual(h.builders[0](where), [])
  }
  assert.match(h.api.contextProvider({ chat: chat() }), /北京时间/)
  assert.equal(h.api.contextProvider({ chat: { kind: 'system' } }), '')
})

test('tool execution rechecks session mapping, current owner, enable flags and prompt capability', async t => {
  const h = harness(t)
  const invoke = token => h.tools.qq_reminder_create.execute({ text: '合成权限测试', delayMinutes: 1, request_token: token })
  assert.equal((await invoke('fabricated')).ok, false)
  const token = h.authorize()
  h.setMapped('system:background')
  assert.equal((await invoke(token)).ok, false)
  h.setMapped(`private:${OWNER}`)
  for (const [object, key, value] of [[h.cfg, 'enabled', false], [h.cfg, 'dryRun', true], [h.settings, 'enabled', false], [h.cfg, 'ownerQQ', OTHER]]) {
    const old = object[key]; object[key] = value
    assert.equal((await invoke(token)).ok, false)
    object[key] = old
  }
  assert.equal((await invoke(token)).ok, true)
  h.authorize('')
  assert.equal((await invoke(token)).ok, false)
})

test('actual module create and cancel accept prefixed prompt IDs with normalized builder IDs', async t => {
  const h = harness(t, { prefixedPromptSession: true })
  const created = await h.create({ text: '合成生产会话前缀回归' })
  assert.equal(created.ok, true)
  assert.equal((await h.tools.qq_reminder_list.execute({})).count, 1)
  const request_token = h.authorize()
  assert.equal((await h.tools.qq_reminder_cancel.execute({ id: created.task.id, request_token })).ok, true)
  h.advance(61_000); await h.tick()
  assert.equal(h.sent.length, 0)
  assert.equal(h.status().counts.cancelled, 1)
})

test('create/list/cancel use real persistent engine and cancellation cannot reuse an old prompt token', async t => {
  const h = harness(t)
  const old = h.authorize()
  const created = await h.tools.qq_reminder_create.execute({ text: '合成取消测试', delayMinutes: 1, request_token: old })
  assert.equal(created.ok, true)
  const listed = await h.tools.qq_reminder_list.execute({})
  assert.equal(listed.count, 1)
  assert.equal(listed.tasks[0].id, created.task.id)
  const fresh = h.authorize()
  assert.equal((await h.tools.qq_reminder_cancel.execute({ id: created.task.id, request_token: old })).ok, false)
  assert.equal((await h.tools.qq_reminder_cancel.execute({ id: created.task.id, request_token: fresh })).ok, true)
  h.advance(65_000); await h.tick()
  assert.equal(h.sent.length, 0)
  assert.equal((await h.tools.qq_reminder_list.execute({})).count, 0)
  assert.equal((await h.tools.qq_reminder_list.execute({ history: true })).tasks[0].status, 'cancelled')
})

test('delivery is one literal text segment to fixed owner; scheduled night reminders still run', async t => {
  const h = harness(t, { now: Date.parse('2026-10-31T23:30:00+08:00') })
  const text = '<poke> <sticker:合成> ||| [CQ:at,qq=all] 合成文本'
  assert.equal((await h.create({ text })).ok, true)
  assert.equal((await h.create({ text: '非法目标', chatId: `private:${OTHER}` })).ok, false)
  h.advance(61_000); await h.tick()
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].target, `private:${OWNER}`)
  assert.deepEqual(h.sent[0].segments, [{ type: 'text', data: { text: `主人，到提醒时间啦：${text}` } }])
  assert.equal(h.status().totals.confirmed, 1)
  await h.tick()
  assert.equal(h.sent.length, 1)
})

test('scheduler waits through disabled, dry-run, offline, wrong-account and mute states', async t => {
  const h = harness(t)
  assert.equal((await h.create({})).ok, true)
  h.advance(61_000)
  for (const [enter, leave] of [
    [() => { h.cfg.enabled = false }, () => { h.cfg.enabled = true }],
    [() => { h.cfg.dryRun = true }, () => { h.cfg.dryRun = false }],
    [() => { h.settings.enabled = false }, () => { h.settings.enabled = true }],
    [() => { h.api.core.onebot.state = 'disconnected' }, () => { h.api.core.onebot.state = 'connected' }],
    [() => h.setIdentity(OTHER), () => h.setIdentity(BOT)],
    [() => h.setMuted(true), () => h.setMuted(false)],
  ]) {
    enter(); await h.tick()
    assert.equal(h.sent.length, 0)
    assert.equal(h.status().counts.pending, 1)
    leave()
  }
  await h.tick()
  assert.equal(h.sent.length, 1)
  assert.equal(h.status().counts.completed, 1)
})

test('identity changes during the login-info await prevent sending', async t => {
  const h = harness(t)
  assert.equal((await h.create({})).ok, true)
  h.advance(61_000)
  let resolveIdentity
  h.api.core.onebot.call = () => new Promise(resolve => { resolveIdentity = resolve })
  const ticking = h.tick()
  await Promise.resolve()
  assert.equal(typeof resolveIdentity, 'function')
  h.cfg.botQQ = OTHER
  resolveIdentity({ user_id: BOT })
  await ticking
  assert.equal(h.sent.length, 0)
  assert.equal(h.status().counts.pending, 1)
})

test('unconfirmed QQ receipt pauses the task without repeating it', async t => {
  const h = harness(t, { receipt: {} })
  assert.equal((await h.create({})).ok, true)
  h.advance(61_000); await h.tick()
  assert.equal(h.sent.length, 1)
  assert.equal(h.status().counts.uncertain, 1)
  assert.equal(h.status().totals.confirmed, 0)
  h.advance(61_000); await h.tick()
  assert.equal(h.sent.length, 1)
})

test('a private chat-log error cannot discard a valid QQ delivery receipt', async t => {
  const h = harness(t)
  assert.equal((await h.create({})).ok, true)
  h.api.core.hub.logChat = () => { throw new Error('synthetic log failure') }
  h.advance(61_000); await h.tick()
  assert.equal(h.sent.length, 1)
  assert.equal(h.status().totals.confirmed, 1)
  assert.equal(h.status().counts.uncertain, 0)
})

test('replaying a completed create in the same grant cannot schedule another message', async t => {
  const h = harness(t), request_token = h.authorize()
  const args = { text: '合成幂等测试', delayMinutes: 1, request_token }
  const first = await h.tools.qq_reminder_create.execute(args)
  assert.equal(first.ok, true)
  h.advance(61_000); await h.tick()
  assert.equal(h.status().counts.completed, 1)
  h.advance(121_000) // Outside the engine's short relative-time duplicate window.
  const replay = await h.tools.qq_reminder_create.execute({ ...args, repeat: 'once' })
  assert.equal(replay.ok, true)
  assert.equal(replay.duplicate, true)
  assert.equal(replay.task.id, first.task.id)
  assert.equal(h.status().totals.created, 1)
  assert.equal(h.status().counts.pending, 0)
  h.advance(61_000); await h.tick()
  assert.equal(h.sent.length, 1)
})

test('equivalent absolute time formats share the same request idempotency record', async t => {
  const h = harness(t), request_token = h.authorize()
  const first = await h.tools.qq_reminder_create.execute({ text: '合成绝对时间幂等测试', at: '2026-10-31T16:01+08:00', request_token })
  assert.equal(first.ok, true)
  h.advance(61_000); await h.tick()
  const replay = await h.tools.qq_reminder_create.execute({ text: '合成绝对时间幂等测试', at: '2026-10-31T16:01:00+08:00', repeat: 'once', request_token })
  assert.equal(replay.ok, true)
  assert.equal(replay.duplicate, true)
  assert.equal(replay.task.id, first.task.id)
  assert.equal(h.status().totals.created, 1)
  assert.equal(h.sent.length, 1)
})

test('readonly route does not leak text, IDs or owner and disposal invalidates existing tool closures', async t => {
  const h = harness(t)
  const token = h.authorize()
  const created = await h.tools.qq_reminder_create.execute({ text: '私有合成提醒内容', delayMinutes: 1, request_token: token })
  assert.equal(created.ok, true)
  const snapshot = JSON.stringify(h.status())
  assert.equal(snapshot.includes('私有合成提醒内容'), false)
  assert.equal(snapshot.includes(created.task.id), false)
  assert.equal(snapshot.includes(OWNER), false)
  assert.equal(h.routes.get('/state')({ method: 'POST' }).ok, false)
  for (const dispose of h.disposers) dispose()
  assert.equal((await h.tools.qq_reminder_create.execute({ text: '迟到测试', delayMinutes: 1, request_token: token })).ok, false)
  h.advance(61_000); await h.tick()
  assert.equal(h.sent.length, 0)
})

test('private store writes atomically with 0600 mode and preserves corrupt original for investigation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qqai-reminder-store-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'state.json'), store = privateStore(file)
  store.save({ version: 1, synthetic: true })
  assert.deepEqual(store.load(), { version: 1, synthetic: true })
  assert.equal(statSync(file).mode & 0o777, 0o600)
  store.save({ version: 1, synthetic: false })
  assert.deepEqual(store.load(), { version: 1, synthetic: false })
  assert.deepEqual(readdirSync(directory), ['state.json'])
  writeFileSync(file, '{corrupt')
  assert.throws(() => store.load(), /校验失败/)
  assert.equal(readFileSync(file, 'utf8'), '{corrupt')
  assert.throws(() => privateStore(join(directory, 'absent-dir', 'state.json')).save({}), /写入失败/)
})

test('private store rejects symlinks, multiply linked files and oversized files', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qqai-reminder-store-boundaries-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const original = join(directory, 'original.json')
  writeFileSync(original, '{}')
  const symlink = join(directory, 'symlink.json'); symlinkSync(original, symlink)
  assert.throws(() => privateStore(symlink).load(), /不可读/)
  const hardlink = join(directory, 'hardlink.json'); linkSync(original, hardlink)
  assert.throws(() => privateStore(hardlink).load(), /校验失败/)
  assert.throws(() => privateStore(directory).load(), /校验失败/)
  const large = join(directory, 'large.json'); writeFileSync(large, Buffer.alloc(2 * 1024 * 1024 + 1, ' '))
  assert.throws(() => privateStore(large).load(), /校验失败/)
})
