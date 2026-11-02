// Replay a fresh synthetic DeepSeek selection in the installed hub, with QQ transport intercepted.
// Usage on the deployed host: node replay-sticker-omission.mjs /private/stock-replay.json
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const live = '/srv/qqai-dsh/home/.dsh', packages = join(live, 'profiles/web/node_modules')
const production = join(live, 'plugins-data/aurabot'), local = await mkdtemp(join(tmpdir(), 'qqai-stock-replay-'))
process.env.AURABOT_DATA_DIR = local
process.env.DSH_HOME = local
globalThis.fetch = () => { throw new Error('Network disabled in isolated replay') }
const load = path => import(pathToFileURL(path))
const settings = JSON.parse(await readFile(join(production, 'config.json'), 'utf8')).ext['qqai-compat']
const trace = JSON.parse(await readFile(process.argv[2], 'utf8'))
const { call, result } = trace
assert.match(trace.session, /^qqai-synthetic-stickers-stock-[0-9a-f]{32}$/u)
assert.equal(call.name, 'sticker_send')
assert.equal(result.isError, false)
assert.equal(settings.stickerUsage, 'often')
const firstLine = result.content[0].text.split('\n')[0]
const [, port, hash] = firstLine.match(/^!\[[^\]\r\n]*\]\(http:\/\/127\.0\.0\.1:(\d+)\/x-nekowhale-stickers\/s\/([a-f0-9]{12})\.gif\)$/u) || []
assert.ok(hash)
const aurabot = join(packages, 'dsh-aurabot-qq'), neko = join(packages, 'dsh-nekowhale-stickers')
const { createHub } = await load(join(aurabot, 'src/chat/hub.js'))
const { StickerKit } = await load(join(neko, 'lib/core/index.js'))
const { default: compat } = await load(join(production, 'modules/qqai-compat/index.mjs'))
const kit = new StickerKit({ dataDir: settings.stickersDataDir, packs: ['大肥鱼'], whitelist: ['pack:大肥鱼'],
  autoSync: 'off', bundledMeta: join(neko, 'meta/nekowhale.json') })
const bytes = await readFile(join(settings.stickersDataDir, 'byhash', hash + '.gif'))
assert.equal(createHash('sha1').update(bytes).digest('hex').slice(0,12), hash)

try {
  const owner = '12345', chatId = 'private:' + owner, session = { id: trace.session }
  const agent = { session, followup: async () => {} }
  const cfg = { ownerQQ: owner, enabled: true, dryRun: false, workspaceDir: join(local, 'sessions'), voice: { enabled: false },
    stickers: { enabled: false, faces: false }, model: {} }
  const events = new Map(), filters = new Map(), noop = () => {}
  const dsh = { agents: new Map([[session.id, agent]]), workspaceRegistry: { list: () => [{ path: cfg.workspaceDir, id: 'replay' }] },
    on: (name, fn) => { events.set(name, fn); return noop },
    get: name => ({ sessionController: { create: async () => ({ sessionId: session.id }), rename: async () => {} },
      stickers: kit, webServer: { port: Number(port) } })[name] }
  const log = { info: noop, warn: noop, debug: noop }
  const captured = [], activities = []
  const onebot = { call: async (action, params) => {
    if (action === 'set_input_status') return {}
    assert.equal(action, 'send_private_msg')
    assert.equal(params.user_id, Number(owner))
    captured.push(params.message)
    return { message_id: captured.length }
  } }
  const filter = name => (value, info) => filters.has(name) ? filters.get(name)(value, info) : value
  const hub = createHub({ dsh, getConfig: () => cfg, log, onebot, onActivity: a => activities.push(a),
    hooks: { prompt: filter('prompt'), reply: filter('reply'), items: filter('reply/items'), send: filter('send') } })
  compat.setup({ core: { hub }, dsh, settings: () => settings, config: () => cfg, log,
    on: (name, fn) => filters.set(name, fn), route: noop, onDispose: noop })
  const emit = (type, data) => {
    const event = { type, data }
    hub.onSessionEvent(session, event)
    events.get('session/event')?.(session, event)
  }
  const checks = []
  for (const [index, policy] of ['omitted', 'already-in-final', 'no-selection'].entries()) {
    const turn = call.turn + index
    await hub.pushToSession({ chatId, kind: 'private', userId: owner }, [{ type: 'text', text: '合成回归' }], owner)
    emit('user/message', { turn, source: { kind: 'aurabot' } })
    if (policy !== 'no-selection') {
      const replay = { ...call, turn, callId: call.callId + (index ? '-repeat' : '') }
      emit('tool/call', replay)
      const exec = { name: call.name, arguments: call.arguments, agent, callId: replay.callId, rootCallId: replay.callId }
      const settled = events.has('tools/execute') ? await events.get('tools/execute')(exec, async () => result) : result
      events.get('tools/result')?.(exec, settled)
      emit('tool/result', { turn, step: call.step, message: { role: 'tool', toolCallId: replay.callId, ...result } })
    }
    const before = captured.length, count = activities.length
    const text = policy === 'already-in-final' ? '前|||' + firstLine + '|||后' : '只返回正文'
    emit('assistant/message', { turn, message: { content: [{ type: 'text', text }] } })
    emit('turn/end', { turn, reason: { kind: 'completed' } })
    for (let i = 0; i < 200 && activities.length === count; i++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(activities.length, count + 1, 'hub did not complete the isolated delivery')
    const records = captured.slice(before).flat()
    const expected = policy === 'omitted' ? ['text', 'image'] : policy === 'already-in-final' ? ['text', 'image', 'text'] : ['text']
    assert.deepEqual(records.map(x => x.type), expected)
    for (const segment of records.filter(x => x.type === 'image')) {
      assert.ok(segment.data.file.startsWith('base64://'))
      assert.ok(Buffer.from(segment.data.file.slice(9), 'base64').equals(bytes))
    }
    checks.push({ policy, segments: expected, selectedImageBytesMatch: expected.includes('image') })
  }
  console.log(JSON.stringify({ ok: true, scope: 'installed hub isolated replay of real synthetic model selection',
    oneBotTransport: 'intercepted', realQqSends: 0, productionOwnerMappingAccessed: false, checks }))
} finally {
  await rm(local, { recursive: true, force: true })
}
