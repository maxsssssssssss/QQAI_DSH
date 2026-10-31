import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PATCHES, GIF_MEDIA_PATCH, patchedSource, patchPackages } from '../scripts/patch-plugin-media.mjs'

const sourceRoots = [process.env.AURABOT_SOURCE_ROOT, process.env.NEKOWHALE_PACKAGE_ROOT]
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
async function source(t, index) {
  const root = sourceRoots[PATCHES[index].rootIndex]
  if (!root) { t.skip('Set AURABOT_SOURCE_ROOT and NEKOWHALE_PACKAGE_ROOT to reviewed package sources'); return }
  return readFile(join(root, PATCHES[index].file), 'utf8')
}

test('pinned sender rejects model paths and URLs before any file or network reader', async (t) => {
  const original = await source(t, 0)
  if (!original) return
  const patched = patchedSource(original, PATCHES[0])
  const begin = patched.indexOf('  async function sendImage(')
  const end = patched.indexOf('\n  /**', begin)
  assert.ok(begin > 0 && end > begin)
  let reads = 0
  const captured = []
  const make = new Function('fetchImage', 'sendSegments', 'quote', 'mention', 'log',
    patched.slice(begin, end) + '\nreturn sendImage')
  const sendImage = make(() => { reads++; throw new Error('reader must never run') },
    async (...args) => { captured.push(args); return { message_id: 'local-test' } },
    () => [], () => [], { warn() {} })
  for (const value of ['/etc/passwd', 'file:///private.png', 'https://example.com/redirect', 'http://127.0.0.1:3180/']) {
    assert.equal(await sendImage('private:test', value), null)
  }
  assert.equal(reads, 0)
  assert.equal(captured.length, 0)
  const valid = 'base64://' + gif.toString('base64')
  assert.deepEqual(await sendImage('private:test', valid), { message_id: 'local-test' })
  assert.equal(captured[0][1][0].data.file, valid)
  assert.equal(reads, 0)
})

test('compiled Nekowhale image loader refuses arbitrary local and remote avatar inputs', async (t) => {
  const original = await source(t, 1)
  if (!original) return
  const patched = patchedSource(original, PATCHES[1])
  const { loadImageInput } = await import('data:text/javascript;base64,' + Buffer.from(patched).toString('base64'))
  for (const input of ['/private/photo.png', 'https://example.com/avatar.png', 'file:///private/photo.png']) {
    await assert.rejects(loadImageInput(input), /avatar image input is disabled/)
  }
})

test('installer refuses drift, verifies both packages, and is idempotent', async (t) => {
  const originals = await Promise.all(PATCHES.map((_, i) => source(t, i)))
  if (originals.some((x) => !x)) return
  const parent = await mkdtemp(join(tmpdir(), 'qqai-patches-'))
  t.after(() => rm(parent, { force: true, recursive: true }))
  const roots = [join(parent, 'dsh-aurabot-qq'), join(parent, 'dsh-nekowhale-stickers')]
  await Promise.all(PATCHES.map(async (spec, i) => {
    const root = roots[spec.rootIndex]
    const file = join(root, spec.file)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, originals[i])
    assert.throws(() => patchedSource(originals[i] + 'drift', spec), /unreviewed source hash/)
  }))
  for (const spec of PATCHES.slice(0, 2)) await writeFile(join(roots[spec.rootIndex], 'package.json'), JSON.stringify({ name: spec.package, version: spec.version }))
  await assert.rejects(patchPackages(roots, { check: true }), /required media patch is missing/)
  assert.deepEqual((await patchPackages(roots)).map((x) => x.status), PATCHES.map(() => 'patched'))
  assert.deepEqual((await patchPackages(roots)).map((x) => x.status), PATCHES.map(() => 'already-patched'))
  assert.deepEqual((await patchPackages(roots, { check: true })).map((x) => x.status), PATCHES.map(() => 'verified'))
  // The running deployment already has the reviewed GIF-only patch. Its upgrade
  // must converge on the same final file as a brand-new upstream installation.
  const intermediate = patchedSource(originals[0], GIF_MEDIA_PATCH)
  await writeFile(join(roots[0], PATCHES[0].file), intermediate)
  await assert.rejects(patchPackages(roots, { check: true }), /required media patch is missing/)
  assert.deepEqual((await patchPackages(roots)).map((x) => x.status), PATCHES.map((_, i) => i === 0 ? 'patched' : 'already-patched'))
  assert.equal(await readFile(join(roots[0], PATCHES[0].file), 'utf8'), patchedSource(originals[0], PATCHES[0]))
  assert.deepEqual((await patchPackages(roots, { check: true })).map((x) => x.status), PATCHES.map(() => 'verified'))
})

test('the composed hub accepts only reviewed original/intermediate/final hashes and writes one result per file', async (t) => {
  const original = await source(t, 0)
  if (!original) return
  assert.equal(PATCHES.length, 7)
  assert.equal(new Set(PATCHES.map((p) => `${p.rootIndex}:${p.file}`)).size, PATCHES.length)
  const intermediate = patchedSource(original, GIF_MEDIA_PATCH)
  const final = patchedSource(original, PATCHES[0])
  assert.equal(patchedSource(intermediate, PATCHES[0]), final)
  assert.equal(patchedSource(final, PATCHES[0]), final)
  assert.throws(() => patchedSource(intermediate.replace('return { missedAt }', 'return { missedAt, ok: true }'), PATCHES[0]), /unreviewed source hash/)
})

test('background memory/mood helper passes configured Thinking Off to the provider', async (t) => {
  const original = await source(t, 3)
  if (!original) return
  const patched = patchedSource(original, PATCHES[3])
  const { askModel } = await import('data:text/javascript;base64,' + Buffer.from(patched).toString('base64'))
  const calls = []
  const llm = {
    resolveModelInfo: async () => ({ reasoning: { efforts: ['off', 'low', 'high'], defaultEffort: 'high' } }),
    async *stream(params) { calls.push(params); yield { type: 'text-delta', text: 'ok' } },
  }
  assert.equal(await askModel({ llm }, { cfg: { model: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'off' } }, text: 'synthetic fixture' }), 'ok')
  assert.equal(calls[0].reasoningEffort, 'off')
})

test('proactive change replaces only the fabricated-life angle, preserving the scheduler', async (t) => {
  const original = await source(t, 2)
  if (!original) return
  const patched = patchedSource(original, PATCHES[2])
  assert.ok(!patched.includes('编也行'))
  assert.equal(patched.replace(PATCHES[2].replacement, PATCHES[2].needle), original.trimEnd() + '\n')
})
