// Isolated regressions of the actual pinned hub functions, not live QQ evidence.
import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PATCHES, patchedSource } from '../scripts/patch-plugin-media.mjs'
import { STICKER_TURN_PATCHES } from '../scripts/sticker-turn-patch-spec.mjs'
import { mediaHooks, stockResultUrl } from '../adapters/qqai-compat/index.mjs'
import { createStickerPolicy, toolTurnTracker } from '../adapters/qqai-compat/sticker-policy.mjs'

const root = process.env.AURABOT_SOURCE_ROOT
const chatId = 'private:12345'
const sha = value => createHash('sha256').update(value).digest('hex')
const importSource = value => import('data:text/javascript;base64,' + Buffer.from(value).toString('base64'))
const log = { info() {}, debug() {}, warn() {} }
async function source(t) {
  if (!root) { t.skip('Set AURABOT_SOURCE_ROOT to the fixed upstream package'); return }
  const spec = PATCHES.find(p => p.file === 'src/chat/hub.js')
  return patchedSource(await readFile(join(root, spec.file), 'utf8'), spec)
}
function fn(source, name, end, async = true) {
  const start = source.indexOf(`  ${async ? 'async ' : ''}function ${name}(`)
  const finish = source.indexOf(end, start)
  assert.ok(start > 0 && finish > start)
  return source.slice(start, finish)
}

test('turn-context patch is pinned, idempotent and upgrades the prior deployed hub', async t => {
  const final = await source(t); if (!final) return
  const stage = STICKER_TURN_PATCHES.at(-1), combined = PATCHES.find(p => p.file === stage.file)
  assert.equal(sha(final), stage.after)
  let previous = final
  for (const edit of [...stage.edits].reverse()) previous = previous.replace(edit.replacement, edit.needle)
  assert.equal(sha(previous), stage.before)
  assert.equal(patchedSource(previous, combined), final)
  assert.equal(patchedSource(final, combined), final)
  assert.throws(() => patchedSource(final + '\n// drift', combined), /unreviewed/)
})

test('actual onSessionEvent and tool-call tracker agree on normalized session and turn', async t => {
  const src = await source(t); if (!src) return
  const deliveries = [], released = []
  const make = new Function('deliver', 'release', 'log', `
    const sessionKey = x => String(x || '').replace(/^session-/, '');
    const sessionToChat = new Map([['owner-session', '${chatId}'], ['system-session', 'system:background']]);
    const turnState = new Map(), slowNoticeSent = new Set(), running = new Set();
    const getConfig = () => ({ownerQQ: '12345'});
    const stopTyping = () => {}, redact = x => x;
    ${fn(src, 'textOf', '\n  function onSessionEvent', false)}
    ${fn(src, 'onSessionEvent', '\n  // ---------- 收 QQ', false)}
    return onSessionEvent;`)
  const onEvent = make(async (...args) => deliveries.push(args), c => released.push(c), log)
  const tracker = toolTurnTracker({ getOwner: () => '12345', chatOfSession: sid => sid === 'owner-session' ? chatId : null })
  const session = { id: 'session-owner-session' }
  tracker.observe(session, { type: 'tool/call', data: { turn: 8, callId: 'tool-8' } })
  const toolScope = tracker.scope({ agent: { session }, callId: 'tool-8', rootCallId: 'tool-8' })
  const assistant = (turn, text) => ({ type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } })
  const end = turn => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  onEvent(session, assistant(8, '真实函数的合成回复')); onEvent(session, end(8))
  onEvent({ id: 'session-unmapped-probe' }, assistant(8, '不可发送')); onEvent({ id: 'session-unmapped-probe' }, end(8))
  onEvent({ id: 'session-system-session' }, assistant(8, '后台不能发送')); onEvent({ id: 'session-system-session' }, end(8))
  onEvent(session, assistant(9, '上一轮残留')); onEvent(session, end(10))
  const select = turn => ({ type: 'tool/call', data: { turn, name: 'sticker_send', callId: 'stock-' + turn } })
  onEvent(session, select(11)); onEvent(session, end(11)); onEvent(session, end(11))
  onEvent(session, select(12)); onEvent(session, { type: 'turn/end', data: { turn: 12, reason: { kind: 'aborted' } } })
  onEvent(session, end(12))
  onEvent(session, { type: 'tool/call', data: { turn: 13, name: 'sticker_search' } }); onEvent(session, end(13))
  await Promise.resolve(); await Promise.resolve()
  assert.equal(deliveries.length, 2)
  assert.equal(deliveries[0][2].stickerTurnKey, toolScope)
  assert.equal(deliveries[0][2].stickerFinal, true)
  assert.equal(deliveries[1][1], '')
  assert.equal(deliveries[1][2].stickerTurnKey, 'qq:owner-session:11')
  assert.equal(deliveries[1][2].stickerFinal, true)
  assert.equal(toolScope, 'qq:owner-session:8')
  assert.ok(released.includes(chatId))
})

test('actual hub preserves turn identity through tools, interleaved final bubbles and send hooks', async t => {
  const src = await source(t); if (!src) return
  const replySpec = PATCHES.find(p => p.file === 'src/chat/reply.js')
  const originalReply = await readFile(join(root, 'src/chat/reply.js'), 'utf8')
  const { parseReply, bubbleDelay } = await importSource(replySpec ? patchedSource(originalReply, replySpec) : originalReply)
  const dir = await mkdtemp(join(tmpdir(), 'qqai-hub-turn-')); t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'byhash'))
  const catalog = [], base = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  for (let i = 0; i < 3; i++) {
    const hash = String(i).padStart(12, '0'); catalog.push({ pack: '大肥鱼', hash })
    await writeFile(join(dir, 'byhash', hash + '.gif'), Buffer.concat([base, Buffer.from(String(i))]))
  }
  const kit = { all: async () => catalog, fileByHash: async hash => join(dir, 'byhash', hash + '.gif') }
  const policy = createStickerPolicy({ getKit: () => kit, getUsage: () => 'normal' })
  const turns = toolTurnTracker({ getOwner: () => '12345', chatOfSession: sid => sid === 'owner-session' && chatId,
    stockUrl: result => stockResultUrl(result, 3080) })
  const media = mediaHooks({ getPort: () => 3080, getKit: () => kit, getDataDir: () => dir, getOwner: () => '12345', policy,
    takeStock: turns.takeStock })
  const hookScopes = [], accepted = [], activities = [], sentIds = new Set()
  const hooks = {
    reply: async (text, info) => { hookScopes.push(['reply', info.stickerTurnKey]); await Promise.resolve(); return text },
    items: media.items,
    send: async (message, info) => {
      hookScopes.push(['send', info.stickerTurnKey || policy.scope(info)])
      return media.send(message, info)
    },
  }
  const cfg = { enabled: true, dryRun: false, ownerQQ: '12345', voice: { enabled: false }, stickers: { enabled: false } }
  const make = new Function('AsyncLocalStorage', 'parseReply', 'bubbleDelay', 'hooks', 'getConfig', 'onebot', 'sentIds', 'log', 'onActivity', `
    const stickerTurnStore = new AsyncLocalStorage(), captureStore = new AsyncLocalStorage();
    const targetOf = () => ({kind:'private',id:'12345'}), bump = () => {}, mood = () => ({delay:1}), isMuted = () => false;
    const groupEngaged = new Map(), groupRefs = new Map(), groupSaid = new Map(), saidElsewhere = new Map();
    const stickers = {}; let lastChatAt = 0, lastBotToOwner = null;
    const sleep = async () => { await Promise.resolve(); }, logChat = () => {};
    const sendVoice = async () => {}, sendSticker = async () => {}, pokeBack = async () => {};
    ${fn(src, 'sendSegments', '\n  /** replyId')}
    const sendText = (chat, text) => sendSegments(chat, [{type:'text',data:{text}}], text);
    const sendImage = (chat, file) => sendSegments(chat, [{type:'image',data:{file}}], '[image]');
    ${fn(src, 'deliver', '\n  // ---------- 盯 DSH')}
    return { deliver, sendSegments };`)
  let rejectImages = false
  const hub = make(AsyncLocalStorage, parseReply, bubbleDelay, hooks, () => cfg,
    { call: async (_action, params) => {
      if (rejectImages && params.message.some(s => s.type === 'image')) return {}
      accepted.push(params.message); await Promise.resolve(); return { message_id: accepted.length }
    } }, sentIds, log, a => activities.push(a))
  const image = i => `![表情](http://127.0.0.1:3080/x-nekowhale-stickers/s/${catalog[i].hash}.gif)`
  const keyA = 'qq:owner-session:8', keyB = 'qq:owner-session:9'
  await policy.withTurn(keyA, () => hub.deliver(chatId, image(0)))
  await Promise.all([
    hub.deliver(chatId, '甲|||' + image(0) + '|||' + image(1) + '|||' + image(2) + '|||乙', { stickerTurnKey: keyA, own: true }),
    hub.deliver(chatId, '丙|||' + image(0) + '|||' + image(1) + '|||丁', { stickerTurnKey: keyB, own: true }),
  ])
  assert.equal(accepted.flat().filter(x => x.type === 'image').length, 4, 'tool+final A sends 2; overlapping B sends 2')
  assert.deepEqual(accepted.flat().filter(x => x.type === 'text').map(x => x.data.text).sort(), ['丁', '丙', '乙', '甲'].sort())
  assert.equal(hookScopes.filter(([kind, key]) => kind === 'send' && key === keyA).length, 4)
  assert.equal(hookScopes.filter(([kind, key]) => kind === 'send' && key === keyB).length, 4)
  const before = accepted.length
  await hub.deliver(chatId, '无上下文仍可发文本|||' + image(2))
  assert.equal(accepted.length, before + 1)
  assert.equal(accepted.at(-1)[0].type, 'text')

  // Exercise the actual admission, settled result, final-only merge and receipt path.
  const markers = []
  hooks.items = (items, info) => {
    markers.push(info.stickerFinal)
    return media.items(items, info)
  }
  const session = { id: 'session-owner-session' }
  function select(turn, i) {
    const callId = 'call-' + turn
    turns.observe(session, { type: 'tool/call', data: { turn, callId, name: 'sticker_send' } })
    turns.result({ name: 'sticker_send', callId, rootCallId: callId, agent: { session } },
      { isError: false, content: [{ type: 'text', text: image(i) }] })
    turns.observe(session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  select(97, 0)
  const finalOpts = { stickerTurnKey: 'qq:owner-session:97', stickerFinal: true, own: true }
  const oldCount = accepted.length
  await hub.deliver(chatId, '工具中的发送', { stickerTurnKey: finalOpts.stickerTurnKey })
  await hub.deliver(chatId, '[沉默]', finalOpts)
  hooks.reply = () => null
  await hub.deliver(chatId, '', finalOpts)
  hooks.reply = () => ''
  await hub.deliver(chatId, '被过滤掉的回复', finalOpts)
  hooks.reply = text => text
  await hub.deliver(chatId, '', finalOpts)
  assert.deepEqual(markers, [false, true])
  assert.deepEqual(accepted.slice(oldCount).map(segments => segments[0].type), ['text', 'image'])
  select(98, 1)
  const recovered = await hub.deliver(chatId, '漏贴图片的最终回复', { ...finalOpts, stickerTurnKey: 'qq:owner-session:98' })
  assert.deepEqual(accepted.slice(-2).map(segments => segments[0].type), ['text', 'image'])
  assert.equal(recovered.ok, true)
  assert.equal(recovered.delivered, 2)
  assert.deepEqual(activities.at(-1).stickerReceipt, { key: 'qq:owner-session:98', final: true, image: true, textOnly: false })
  select(99, 2)
  const explicit = await hub.deliver(chatId, '甲|||' + image(2) + '|||乙', { ...finalOpts, stickerTurnKey: 'qq:owner-session:99' })
  assert.deepEqual(accepted.slice(-3).map(segments => segments[0].type), ['text', 'image', 'text'])
  assert.equal(explicit.delivered, 3)
  rejectImages = true
  const partial = await hub.deliver(chatId, '甲|||' + image(2), { ...finalOpts, stickerTurnKey: 'qq:owner-session:100' })
  assert.equal(partial.failed, 1)
  assert.deepEqual(activities.at(-1).stickerReceipt, { key: 'qq:owner-session:100', final: true, image: false, textOnly: false })
  await hub.deliver(chatId, '甲|||乙', { ...finalOpts, stickerTurnKey: 'qq:owner-session:101' })
  assert.deepEqual(activities.at(-1).stickerReceipt, { key: 'qq:owner-session:101', final: true, image: false, textOnly: true })
})
