// Synthetic policy checks only; no QQ traffic, remote assets, or model calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mediaHooks, ownerStickerCadence, stockResultUrl } from '../adapters/qqai-compat/index.mjs'
import { createStickerPolicy, toolTurnTracker, qqStickerTurnKey, stickerRules, TEXT_TEMPLATES } from '../adapters/qqai-compat/sticker-policy.mjs'

const sha = b => createHash('sha256').update(b).digest('hex')
const baseGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const gif = i => Buffer.concat([baseGif, Buffer.from(String(i))])
const chatId = 'private:11111'
const url = (kind, id) => `http://127.0.0.1:3080/x-nekowhale-stickers/${kind}/${id}.gif`
const info = turn => ({ chatId, stickerTurnKey: `qq:synthetic:${turn}` })
const images = items => (items || []).filter(x => x.kind === 'image')
const segments = items => images(items).map(x => ({ type: 'image', data: { file: x.value } }))

test('often hints on the fourth then seventh owner turn; counts confirmed turns, never bubbles or context builds', () => {
  const hooks = {}, state = {}, session = { id: 'session-synthetic' }
  const chat = { chatId, kind: 'private' }, where = { chat, sessionId: session.id, senderId: '11111' }
  const cfg = { ownerQQ: '11111', enabled: true, dryRun: false }, settings = { stickerUsage: 'often' }
  const api = { config: () => cfg, settings: () => settings, on: (k, fn) => { hooks[k] = fn },
    context: fn => { hooks.context = fn } }
  const policy = createStickerPolicy({})
  const install = () => ownerStickerCadence(api, policy, state)
  let end = install()
  const delivered = (n, extras = {}, chat = chatId) => hooks.activity({ kind: 'out', chatId: chat,
    stickerReceipt: { key: `qq:synthetic:${n}`, final: true, image: false, textOnly: true, ...extras } })
  const input = []
  function prompt(expected, turn, reason = 'completed') {
    assert.equal(hooks.prompt(input, where), input)
    const block = hooks.context(where)
    assert.equal(block.includes('sticker_search'), expected)
    assert.equal(hooks.context(where), block, 'stable for subsequent tool steps')
    assert.equal(hooks.context({ ...where, sessionId: 'another' }), '')
    assert.equal(hooks.context({ ...where, chat: { chatId: 'group:11111' } }), '')
    end({ id: 'synthetic' }, { type: 'turn/end', data: { turn, reason: { kind: reason } } })
    assert.equal(hooks.context(where), '')
  }
  delivered(90, { final: false }); delivered(91, { textOnly: false }); delivered(92, {}, 'private:99999')
  for (let n = 1; n <= 7; n++) {
    if (n === 3) end = install() // same process module reload
    prompt(n === 4 || n === 7, n)
    delivered(n); delivered(n) // duplicate receipt for the same turn
  }
  delivered(8, { final: false, image: true, textOnly: false })
  delivered(8) // interim image and final text belong to the same turn
  for (let n = 9; n <= 11; n++) { prompt(false, n); delivered(n) }
  hooks.prompt(input, { ...where, steer: true })
  assert.equal(hooks.context(where), '', 'steer cannot arm the hint')
  for (const mode of ['normal', 'rare', 'off']) {
    settings.stickerUsage = mode
    prompt(false)
  }
  settings.stickerUsage = 'often'; cfg.dryRun = true; prompt(false)
  cfg.dryRun = false
  prompt(true, 12, 'aborted')
  prompt(true, 13) // silence carries no receipt
  hooks.prompt(input, where) // another module may veto the owner's prompt
  hooks.prompt(input, { ...where, senderId: '' })
  assert.equal(hooks.context(where), '', 'native proactive prompt in the same session cannot inherit the hint')
  prompt(true, 14); delivered(14)
  prompt(false, 15)
})

async function fixture(t, shared) {
  const dir = await mkdtemp(join(tmpdir(), 'qqai-sticker-policy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'byhash')); await mkdir(join(dir, 'renders'))
  const catalog = []
  for (let i = 0; i < 6; i++) {
    const hash = String(i + 1).padStart(12, '0')
    catalog.push({ id: `${i}`, hash, pack: i === 5 ? '大肥鱼和GPT娘' : '大肥鱼' })
    await writeFile(join(dir, 'byhash', `${hash}.gif`), gif(i))
  }
  let enabled = true
  const kit = {
    all: async () => enabled ? catalog : [],
    fileByHash: async id => join(dir, 'byhash', `${id}.gif`),
    renderPath: id => join(dir, 'renders', `${id}.gif`),
    resolveTemplate: async ref => {
      const [pack, key] = ref.split(':')
      return { id: ref, pack, key, input: key === 'hug' ? 'image' : 'text' }
    },
    render: async (ref, input) => {
      const template = await kit.resolveTemplate(ref), data = gif(input.text)
      const id = sha(data).slice(0, 16), path = kit.renderPath(id)
      await writeFile(path, data)
      return { template, data, id, path }
    },
  }
  const state = shared || { scopes: new Map(), renders: new Map() }
  const policy = createStickerPolicy({ getKit: () => kit, getUsage: () => 'normal', state })
  const turns = toolTurnTracker({ getOwner: () => '11111', chatOfSession: sid => sid === 'synthetic' ? chatId : '',
    stockUrl: result => stockResultUrl(result, 3080) })
  const hooks = mediaHooks({ getPort: () => 3080, getKit: () => kit,
    getDataDir: () => dir, getOwner: () => '11111', policy, takeStock: turns.takeStock })
  const item = i => ({ kind: 'image', value: url('s', catalog[i].hash) })
  function tool(turn, callId, name = 'sticker_send', sid = 'synthetic') {
    const session = { id: sid }
    turns.observe(session, { type: 'tool/call', data: { turn, callId, name } })
    return (link, { isError = false, rootCallId = callId } = {}) => {
      const text = `![现成图](${link})\n把上面这行原样放进回复即可显示。`
      turns.result({ agent: { session }, callId, rootCallId, name },
        { isError, ...(isError ? {} : { value: { text } }), content: [{ type: 'text', text }] })
    }
  }
  return { dir, kit, policy, hooks, item, state, turns, tool, disable: () => { enabled = false } }
}

test('only a final reply recovers omitted stock GIFs, in call order and just once', async t => {
  const f = await fixture(t), text = { kind: 'text', value: '恭喜' }, final = { ...info(1), stickerFinal: true }
  const first = f.tool(1, 'a'), second = f.tool(1, 'b'), third = f.tool(1, 'c')
  second(f.item(1).value); third(f.item(2).value); first(f.item(0).value)
  assert.deepEqual(await f.hooks.items([text], info(1)), [text], 'a mid-turn send leaves the choices pending')
  assert.equal(await f.hooks.items([], { ...final, chatId: 'private:22222' }), null)
  assert.equal(await f.hooks.items([], { ...info(2), stickerFinal: true }), null)
  const reply = await f.hooks.items([text], final)
  assert.deepEqual(reply.map(i => i.kind), ['text', 'image', 'image'])
  assert.deepEqual(images(reply).map(i => Buffer.from(i.value.slice(9), 'base64')), [gif(0), gif(1)])
  assert.ok(f.hooks.send(segments(reply), final))
  assert.equal(f.hooks.send(segments(reply), final), null)
  assert.deepEqual(await f.hooks.items([text], final), [text])
})

test('an explicitly placed or already sent image uses its original slot; image-only completion works', async t => {
  const f = await fixture(t), final = { ...info(1), stickerFinal: true }, text = { kind: 'text', value: '原有位置' }
  f.tool(1, 'a')(f.item(0).value); f.tool(1, 'b')(f.item(1).value)
  const prior = await f.hooks.items([f.item(0)], info(1))
  assert.ok(f.hooks.send(segments(prior), info(1)))
  const reply = await f.hooks.items([f.item(1), text], final)
  assert.deepEqual(reply.map(i => i.kind), ['image', 'text'])
  f.tool(2, 'new')(f.item(0).value)
  assert.equal(images(await f.hooks.items([], { ...info(2), stickerFinal: true })).length, 1)
})

test('stale, failed, nested, preview, unmapped or unapproved stock selections cannot attach', async t => {
  const f = await fixture(t), session = { id: 'session-synthetic' }, final = { ...info(1), stickerFinal: true }
  const link = f.item(0).value
  f.tool(1, 'selected')(link)
  const late = f.tool(1, 'still-running')
  f.turns.observe(session, { type: 'user/message', data: { source: { kind: 'aurabot' } } })
  late(link)
  f.tool(1, 'failed')(link, { isError: true })
  f.tool(1, 'nested')(link, { rootCallId: 'parent' })
  f.tool(1, 'search', 'sticker_search')(link)
  f.tool(1, 'template', 'meme_render')(link)
  f.tool(1, 'render-ref')(url('r', 'f'.repeat(16)))
  f.tool(1, 'external')(link.replace('127.0.0.1', 'example.com'))
  f.tool(1, 'unmapped', 'sticker_send', 'unmapped')(link)
  f.tool(1, 'wrong-pack')(f.item(5).value)
  assert.equal(await f.hooks.items([], final), null)
  f.tool(2, 'cancelled')(link)
  f.turns.observe(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted' } } })
  assert.equal(await f.hooks.items([], { ...info(2), stickerFinal: true }), null)
  f.tool(3, 'selected-again')(link)
  f.turns.observe(session, { type: 'user/message', data: { source: { kind: 'runtime-context' } } })
  f.turns.observe(session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  f.turns.observe(session, { type: 'user/message', data: { source: { kind: 'user' } } })
  assert.equal(images(await f.hooks.items([], { ...info(3), stickerFinal: true })).length, 1)
})

test('tool sends and multiple final bubbles share two slots, and duplicate images do not recur', async t => {
  const f = await fixture(t)
  const first = await f.policy.withTurn('qq:synthetic:4', () => f.hooks.items([f.item(0)], { chatId }))
  assert.equal(images(first).length, 1)
  assert.ok(f.hooks.send(segments(first), info(4)))
  const final = await f.hooks.items([{ kind: 'text', value: '文本保留' }, f.item(0), f.item(1), f.item(2)], info(4))
  assert.equal(images(final).length, 1)
  assert.equal(final[0].value, '文本保留')
  assert.ok(f.hooks.send(segments(final), info(4)))
  assert.equal(await f.hooks.items([f.item(3)], info(4)), null)
  assert.equal(images(await f.hooks.items([f.item(0), f.item(1)], info(5))).length, 2)
})

test('parallel prepare calls atomically reserve no more than two images for one turn', async t => {
  const f = await fixture(t)
  const batches = await Promise.all([0, 1, 2, 3, 4].map(i => f.hooks.items([f.item(i)], info(2))))
  assert.equal(batches.flatMap(images).length, 2)
})

test('interleaved chat turns and a reminder have independent bound permits', async t => {
  const f = await fixture(t)
  const [a, b, reminder] = await Promise.all([
    f.policy.withTurn('qq:synthetic:1', async () => { await Promise.resolve(); return f.hooks.items([f.item(0), f.item(1)], { chatId }) }),
    f.policy.withTurn('qq:synthetic:2', () => f.hooks.items([f.item(0), f.item(1)], { chatId })),
    f.policy.withTurn('reminder:task-1:12345', () => f.hooks.items([f.item(0), f.item(1)], { chatId })),
  ])
  assert.equal([a, b, reminder].flatMap(images).length, 6)
  assert.equal(f.hooks.send(segments(a), info(3)), null, 'another turn cannot consume these permits')
  assert.ok(f.hooks.send(segments(a), info(1)))
  assert.ok(f.hooks.send(segments(b), info(2)))
  assert.ok(f.policy.withTurn('reminder:task-1:12345', () => f.hooks.send(segments(reminder), { chatId })))
  assert.equal(f.hooks.send(segments(a), info(1)), null)
})

test('old duo hashes, disabled library rows and unproven render hashes are rejected at send preparation', async t => {
  const f = await fixture(t)
  assert.equal(await f.hooks.items([f.item(5)], info(1)), null)
  assert.equal(await f.hooks.items([{ kind: 'image', value: url('r', 'a'.repeat(16)) }], info(1)), null)
  f.disable()
  assert.equal(await f.hooks.items([f.item(0)], info(1)), null)
})

test('missing scope drops images while retaining text, and unapproved base64 cannot be sent', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.hooks.items([{ kind: 'text', value: '原文' }, f.item(0)], { chatId }), [{ kind: 'text', value: '原文' }])
  assert.equal(f.hooks.send([{ type: 'image', data: { file: 'base64://' + gif(0).toString('base64') } }], info(1)), null)
  assert.equal(await f.hooks.items([f.item(0)], { ...info(1), chatId: 'private:22222' }), null)
})

test('only five single-whale text templates authorize renders, with explicit bounded Unicode text', async t => {
  const f = await fixture(t)
  for (const [key, max] of Object.entries(TEXT_TEMPLATES)) {
    await assert.doesNotReject(f.policy.template('大肥鱼:' + key, '鲸'.repeat(max)))
    await assert.rejects(f.policy.template('大肥鱼:' + key, '鲸'.repeat(max + 1)))
  }
  for (const ref of ['GPT娘:think', '大肥鱼和GPT娘:sign', '大肥鱼:hug', '大肥鱼:unknown']) {
    await assert.rejects(f.policy.renderTextSticker(ref, '短句'))
  }
  for (const text of [undefined, null, '', '   ', 123]) await assert.rejects(f.policy.renderTextSticker('大肥鱼:think', text))
  const r = await f.policy.renderTextSticker('大肥鱼:think', '海盐汽水')
  const prepared = await f.hooks.items([{ kind: 'image', value: url('r', r.id) }], info(1))
  assert.equal(images(prepared).length, 1)
  assert.deepEqual(Buffer.from(prepared[0].value.slice(9), 'base64'), r.data)
  await writeFile(r.path, gif('tampered'))
  assert.equal(await f.hooks.items([{ kind: 'image', value: url('r', r.id) }], info(2)), null)
})

test('hot reload does not reset an already used turn budget', async t => {
  const f = await fixture(t)
  assert.equal(images(await f.hooks.items([f.item(0), f.item(1)], info(7))).length, 2)
  const next = createStickerPolicy({ getKit: () => f.kit, state: f.state })
  assert.equal(next.reserve('qq:synthetic:7', gif('new')), false)
})

test('durable tool/call IDs bind root and nested tools to the exact owner turn', () => {
  const tracker = toolTurnTracker({ getOwner: () => '11111', chatOfSession: sid => sid === 'synthetic' ? chatId : '' })
  tracker.observe({ id: 'session-synthetic' }, { type: 'tool/call', data: { callId: 'a', turn: 3 } })
  tracker.observe({ id: 'session-synthetic' }, { type: 'tool/call', data: { callId: 'b', turn: 4 } })
  assert.equal(tracker.scope({ agent: { session: { id: 'synthetic' } }, callId: 'a' }), 'qq:synthetic:3')
  assert.equal(tracker.scope({ agent: { session: { id: 'session-synthetic' } }, callId: 'nested', rootCallId: 'a' }), 'qq:synthetic:3')
  assert.equal(tracker.scope({ agent: { session: { id: 'synthetic' } }, callId: 'b' }), 'qq:synthetic:4')
  assert.equal(tracker.scope({ agent: { session: { id: 'unmapped-synthetic-probe' } }, callId: 'a' }), '')
  assert.equal(tracker.scope({ agent: { session: { id: 'synthetic' } }, callId: 'unknown' }), '')
  assert.equal(qqStickerTurnKey('session-synthetic', 3), 'qq:synthetic:3')
  assert.equal(qqStickerTurnKey('synthetic', NaN), '')
})

test('normal policy is concise and prioritizes requested stickers and existing GIFs', () => {
  const rules = stickerRules('normal')
  assert.ok(rules.length < 350)
  for (const value of ['只用大肥鱼单人表情', '这是你自己的表情', '主人明确指定', '优先现成 GIF', '整轮最多2张', '共同梗', '不因没搜到图就做模板',
    '不必等主人索要', '不合适可不发', '不要求每轮发', 'Markdown 图片行是 QQ 纯文字规则的例外']) assert.ok(rules.includes(value))
  assert.ok(!stickerRules('off').includes('可主动配图'))
})
