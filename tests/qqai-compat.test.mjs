import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { approvedGif, guideStockSearch, mediaHooks, stickerReference, whalePersona } from '../adapters/qqai-compat/index.mjs'

const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const hash = '012345abcdef'
const renderId = '012345abcdef0123'
const url = `http://127.0.0.1:3180/x-nekowhale-stickers/s/${hash}.gif`

test('successful owner search shows how to pass a returned name, without selecting an image', () => {
  const exec = { name: 'sticker_search', callId: 'c1', rootCallId: 'c1' }
  const scope = 'qq:example:3'
  const text = '鲸鱼“好耶”｜喜悦｜快乐\n拉炮｜喜悦｜庆祝'
  const result = Object.freeze({ isError: false, value: Object.freeze({ text }) })
  const guided = guideStockSearch(exec, result, scope).value.text
  assert.ok(guided.startsWith(text + '\n'))
  assert.ok(guided.includes('sticker_send({"name":"鲸鱼“好耶”"})'))
  assert.ok(!guided.includes('!['))
  assert.equal(guideStockSearch(exec, result, ''), result)
  assert.equal(guideStockSearch({ ...exec, name: 'sticker_send' }, result, scope), result)
  assert.equal(guideStockSearch({ ...exec, rootCallId: 'parent' }, result, scope), result)
  for (const untouched of [{ isError: true, content: [] }, { isError: false, value: { text: '没有匹配的表情，换个情绪词再试。' } }]) {
    assert.equal(guideStockSearch(exec, untouched, scope), untouched)
  }
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'qqai-compat-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dataDir = join(root, 'nekowhale')
  await mkdir(join(dataDir, 'byhash'), { recursive: true })
  await mkdir(join(dataDir, 'renders'))
  const file = join(dataDir, 'byhash', `${hash}.gif`)
  await writeFile(file, gif)
  await writeFile(join(dataDir, 'renders', `${renderId}.gif`), gif)
  const kit = {
    all: async () => [{ pack: '大肥鱼', hash }],
    fileByHash: async (id) => id === hash ? file : undefined,
    renderPath: (id) => join(dataDir, 'renders', `${id}.gif`),
  }
  return { root, dataDir, file, kit }
}

test('accepts only canonical plugin URLs and correct hash widths', () => {
  assert.deepEqual(stickerReference(url, 3180), { kind: 's', id: hash })
  for (const value of [
    '/etc/passwd', 'file:///etc/passwd', 'base64://R0lGODlh',
    'https://example.com/redirect', url + '?secret=1', url + '#x',
    url.replace('127.0.0.1', 'localhost'), url.replace(':3180/', ':3181/'),
    url.replace('127.0.0.1', 'user@127.0.0.1'), url.replace('/s/', '/other/../s/'),
    url.replace('/s/', '/s/%2e%2e/'), url.replace(hash, renderId),
  ]) assert.equal(stickerReference(value, 3180), null, value)
})

test('resolves only real GIF files beneath the separate sticker root', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(await approvedGif({ kind: 's', id: hash }, f), gif)
  assert.deepEqual(await approvedGif({ kind: 'r', id: renderId }, f), gif)
  const outside = join(f.root, 'private.gif')
  await writeFile(outside, gif)
  const link = join(f.dataDir, 'byhash', 'outside.gif')
  await symlink(outside, link)
  await assert.rejects(approvedGif({ kind: 's', id: hash }, { ...f, kit: { fileByHash: async () => link } }), /outside/)
  await writeFile(f.file, 'private data that is not a gif')
  await assert.rejects(approvedGif({ kind: 's', id: hash }, f), /Not a GIF/)
})

test('known GIF uses native image payload exactly once for its owner', async (t) => {
  const f = await fixture(t)
  const hooks = mediaHooks({ getPort: () => 3180, getKit: () => f.kit,
    getDataDir: () => f.dataDir, getOwner: () => 'test-owner' })
  const info = { chatId: 'private:test-owner', stickerTurnKey: 'qq:synthetic:1' }
  const items = await hooks.items([{ kind: 'text', value: '给你看看' }, { kind: 'image', value: url }], info)
  assert.equal(items.length, 2)
  assert.deepEqual(Buffer.from(items[1].value.slice(9), 'base64'), gif)
  const segments = [{ type: 'image', data: { file: items[1].value } }]
  assert.deepEqual(hooks.send(segments, info), segments)
  assert.equal(hooks.send(segments, info), null)
  assert.equal(await hooks.items([{ kind: 'image', value: url }], { chatId: 'private:someone-else' }), null)
})

test('untrusted paths, URLs and base64 never reach the file resolver; failures are closed', async () => {
  let touched = false
  const hooks = mediaHooks({ getPort: () => 3180,
    getKit: () => { touched = true; throw new Error('unexpected') },
    getDataDir: () => '/unused', getOwner: () => 'owner', warn: () => { throw new Error('broken logger') } })
  const info = { chatId: 'private:owner' }
  for (const value of ['/etc/passwd', 'file:///private.png', 'https://example.com/redirect', 'base64://' + gif.toString('base64')]) {
    assert.equal(await hooks.items([{ kind: 'image', value }], info), null)
  }
  assert.equal(touched, false)
  assert.equal(await hooks.items([{ kind: 'image', value: url }], info), null)
  assert.equal(hooks.send([{ type: 'image', data: { file: '/etc/passwd' } }], info), null)
})

test('pinned upstream parser delivers Markdown image items through this adapter', async (t) => {
  const root = process.env.AURABOT_SOURCE_ROOT
  if (!root) { t.skip('Set AURABOT_SOURCE_ROOT to the pinned upstream source for this integration check'); return }
  const { parseReply } = await import(pathToFileURL(join(root, 'src/chat/reply.js')))
  const f = await fixture(t)
  const hooks = mediaHooks({ getPort: () => 3180, getKit: () => f.kit, getDataDir: () => f.dataDir, getOwner: () => 'owner' })
  const parsed = parseReply(`你好呀|||![表情](${url})|||来张表情`)
  assert.deepEqual(parsed.items.map((x) => x.kind), ['text', 'image', 'text'])
  const transformed = await hooks.items(parsed.items, { chatId: 'private:owner', stickerTurnKey: 'qq:synthetic:1' })
  assert.deepEqual(transformed.map((x) => x.kind), ['text', 'image', 'text'])
  assert.deepEqual(Buffer.from(transformed[1].value.slice(9), 'base64'), gif)
})

test('persona comes from the pinned installed source and rejects version drift', async (t) => {
  const file = process.env.WHALE_PERSONA_SOURCE
  if (!file) { t.skip('Set WHALE_PERSONA_SOURCE to the pinned plugin cordis.patch.yml'); return }
  const raw = await readFile(file, 'utf8')
  const out = whalePersona(raw)
  assert.ok(out.includes('傲娇'))
  assert.ok(out.includes('AI 伙伴'))
  assert.ok(out.includes('你的名字是大肥鱼，称呼对方为主人'))
  assert.ok(!out.includes('{{cwd}}'))
  assert.ok(!out.includes('（萝莉）'))
  assert.ok(!out.includes('思考过程（推理、思维链'))
  assert.throws(() => whalePersona(raw + 'changed'), /source changed/)
  assert.equal(whalePersona(raw, { personaText: '' }), out)
  assert.equal(whalePersona(raw, { personaText: ' \n\t ' }), out)

  const custom = (await readFile(new URL('../personas/xiaojing.md', import.meta.url), 'utf8')).trim()
  assert.ok(custom.includes('你的名字是小鲸'))
  assert.equal(whalePersona(raw, { personaText: custom, botName: '旧名字', ownerName: '旧称呼' }), custom,
    'custom role must replace the whole default without appending stale identity or rewriting user wording')
  assert.equal(whalePersona(raw, { personaText: '\n' + custom + '\n' }), custom)
  assert.throws(() => whalePersona(raw + 'changed', { personaText: custom }), /source changed/,
    'custom persona must not bypass the pinned installed-plugin check')
  for (const personaText of [null, 12, false, {}, [], 'x'.repeat(20001)]) {
    assert.throws(() => whalePersona(raw, { personaText }), /Invalid custom whale persona/)
  }
})
