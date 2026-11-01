import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { NEKO_NETWORK_PATCHES } from '../scripts/neko-network-patch-spec.mjs'
import { patchedSource } from '../scripts/patch-plugin-media.mjs'

const fixtureRoot = process.env.NEKOWHALE_PACKAGE_ROOT
const hash = (s) => createHash('sha256').update(s).digest('hex')
const tight = { attemptMs: 200, totalMs: 450, maxBytes: 1024, backoffMs: 5 }

async function setup(t, handler) {
  if (!fixtureRoot) { t.skip('Set NEKOWHALE_PACKAGE_ROOT to the reviewed 1.1.1 sources'); return }
  const dir = await mkdtemp(join(tmpdir(), 'qqai-neko-network-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const spec = NEKO_NETWORK_PATCHES[0]
  const raw = await readFile(join(fixtureRoot, spec.file), 'utf8')
  const patched = patchedSource(raw, spec)
  assert.equal(hash(patched), spec.after)
  await writeFile(join(dir, 'core-sync.mjs'), patched)
  const module = await import(pathToFileURL(join(dir, 'core-sync.mjs')).href)
  // Existing cache code receives the same implementation with shorter budgets;
  // production constants and source hashes are tested separately below.
  await writeFile(join(dir, 'sync-fast.mjs'),
    `import { createBoundedFetchRetry } from './core-sync.mjs';\nexport const fetchRetry = createBoundedFetchRetry(${JSON.stringify(tight)});\n`)
  const cacheSource = await readFile(join(fixtureRoot, 'lib/core/fetcher.js'), 'utf8')
  assert.equal(hash(cacheSource.trimEnd() + '\n'), 'ead012f3acdbf841b92239dc6ac76f826551ebe804da8fb6ae519749a118b5a6')
  await writeFile(join(dir, 'fetcher.mjs'), cacheSource.replace("'./sync.js'", "'./sync-fast.mjs'"))
  const { createCachedFetcher } = await import(pathToFileURL(join(dir, 'fetcher.mjs')).href)
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers })
    handler(req, res, requests.length)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  return { dir, module, createCachedFetcher, requests,
    url: `http://127.0.0.1:${server.address().port}` }
}

test('reviewed network patch is exact, idempotent, and keeps finite production budgets', async (t) => {
  const f = await setup(t, (_, res) => res.end('ok')); if (!f) return
  const spec = NEKO_NETWORK_PATCHES[0]
  const raw = await readFile(join(fixtureRoot, spec.file), 'utf8')
  const patched = patchedSource(raw, spec)
  assert.equal(patchedSource(patched, spec), patched)
  assert.throws(() => patchedSource(raw + 'unreviewed', spec), /unreviewed source hash/)
  assert.deepEqual(f.module.QQAI_FETCH_LIMITS,
    { attemptMs: 12000, totalMs: 30000, maxBytes: 32 * 1024 * 1024, backoffMs: 1000 })
  assert.throws(() => f.module.createBoundedFetchRetry({ totalMs: Infinity }), /Invalid/)
  assert.throws(() => f.module.createBoundedFetchRetry({ totalMs: 30001 }), /Invalid/)
  assert.throws(() => f.module.createBoundedFetchRetry({ maxBytes: 0 }), /Invalid/)
})

test('successful binary response is completely read and preserves cache validators', async (t) => {
  const bytes = Buffer.from([71, 73, 70, 56, 57, 97, 0, 255, 128, 10])
  const f = await setup(t, (_, res) => {
    res.writeHead(200, { 'content-type': 'image/gif', etag: '"unchanged"', 'last-modified': 'Mon, 02 Nov 2026 00:00:00 GMT' })
    res.write(bytes.subarray(0, 5)); res.end(bytes.subarray(5))
  }); if (!f) return
  const response = await f.module.fetchRetry(f.url)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('etag'), '"unchanged"')
  assert.equal(response.headers.get('content-type'), 'image/gif')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  assert.equal(f.requests.length, 1)
})

test('stalled response headers exhaust one total budget including retries', async (t) => {
  const f = await setup(t, () => {}); if (!f) return
  const fetchRetry = f.module.createBoundedFetchRetry(tight)
  const start = performance.now()
  await assert.rejects(fetchRetry(f.url), { code: 'QQAI_NETWORK_TIMEOUT' })
  assert.ok(performance.now() - start < 1500)
  assert.ok(f.requests.length >= 2 && f.requests.length <= 5)
})

test('stalled response body is bounded too, rather than escaping after headers', async (t) => {
  const f = await setup(t, (_, res) => { res.writeHead(200); res.write('partial body') }); if (!f) return
  const start = performance.now()
  await assert.rejects(f.module.createBoundedFetchRetry(tight)(f.url), { code: 'QQAI_NETWORK_TIMEOUT' })
  assert.ok(performance.now() - start < 1500)
  assert.ok(f.requests.length >= 2)
})

test('caller cancellation interrupts an in-flight response body and prevents retries', async (t) => {
  let responseStarted
  const started = new Promise((resolve) => { responseStarted = resolve })
  const f = await setup(t, (_, res) => { res.writeHead(200); res.write('first'); responseStarted() }); if (!f) return
  const controller = new AbortController()
  const reason = new Error('synthetic caller cancellation')
  const pending = f.module.fetchRetry(f.url, { signal: controller.signal })
  const rejection = assert.rejects(pending, (e) => e === reason)
  await started
  controller.abort(reason)
  await rejection
  assert.equal(f.requests.length, 1)
  await assert.rejects(f.module.fetchRetry(f.url, { signal: controller.signal }), (e) => e === reason)
  assert.equal(f.requests.length, 1)
})

test('caller cancellation interrupts retry backoff without issuing the next request', async (t) => {
  let firstResponse
  const started = new Promise((resolve) => { firstResponse = resolve })
  const f = await setup(t, (_, res) => { res.writeHead(429); res.end('rate limited'); firstResponse() }); if (!f) return
  const controller = new AbortController()
  const reason = new Error('cancel backoff')
  const pending = f.module.fetchRetry(f.url, { signal: controller.signal })
  const rejection = assert.rejects(pending, (e) => e === reason)
  await started
  await new Promise((resolve) => setTimeout(resolve, 40))
  controller.abort(reason)
  await rejection
  assert.equal(f.requests.length, 1)
})

test('transient HTTP failures retry, while a terminal 404 is returned once', async (t) => {
  const f = await setup(t, (req, res, count) => {
    if (req.url === '/missing') { res.writeHead(404); res.end('missing'); return }
    res.writeHead(count < 3 ? (count === 1 ? 570 : 503) : 200)
    res.end(count < 3 ? 'retry' : 'success')
  }); if (!f) return
  const retry = f.module.createBoundedFetchRetry({ ...tight, attemptMs: 1000, totalMs: 2000 })
  assert.equal(await (await retry(f.url)).text(), 'success')
  assert.equal(f.requests.length, 3)
  assert.equal((await retry(f.url + '/missing')).status, 404)
  assert.equal(f.requests.length, 4)
})

test('declared oversized and chunked oversized bodies fail without futile retries', async (t) => {
  const f = await setup(t, (req, res) => {
    if (req.url === '/declared') { res.writeHead(200, { 'content-length': '2048' }); res.write('start'); return }
    res.writeHead(200); res.write(Buffer.alloc(700)); res.end(Buffer.alloc(700))
  }); if (!f) return
  const retry = f.module.createBoundedFetchRetry(tight)
  await assert.rejects(retry(f.url + '/declared'), { code: 'QQAI_NETWORK_SIZE' })
  await assert.rejects(retry(f.url + '/chunked'), { code: 'QQAI_NETWORK_SIZE' })
  assert.equal(f.requests.length, 2)
})

test('ETag 304 cache validation keeps the original complete cache bytes', async (t) => {
  const f = await setup(t, (req, res) => {
    if (req.headers['if-none-match'] === '"cache-v1"') { res.writeHead(304); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json', etag: '"cache-v1"' }); res.end('{"text":"完整缓存"}')
  }); if (!f) return
  const cache = join(f.dir, 'cache')
  const get = f.createCachedFetcher({ dir: cache, site: f.url })
  const first = await get('meme/index.json')
  assert.deepEqual(await get('meme/index.json', true), first)
  assert.deepEqual(await readFile(join(cache, 'meme/index.json')), first)
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[1].headers['if-none-match'], '"cache-v1"')
})

test('timed-out body falls back to an existing cache without overwriting or leaving partial data', async (t) => {
  const f = await setup(t, (_, res) => { res.writeHead(200); res.write('incomplete new content') }); if (!f) return
  const cache = join(f.dir, 'cache')
  await mkdir(join(cache, 'meme'), { recursive: true })
  const original = Buffer.from('{"text":"old complete content"}')
  await writeFile(join(cache, 'meme/index.json'), original)
  const get = f.createCachedFetcher({ dir: cache, site: f.url, ttlMs: 0 })
  assert.deepEqual(await get('meme/index.json', true), original)
  assert.deepEqual(await readFile(join(cache, 'meme/index.json')), original)
  assert.deepEqual(await readdir(join(cache, 'meme')), ['index.json'])
})

test('uncached incomplete body fails and does not leave a cache file', async (t) => {
  const f = await setup(t, (_, res) => { res.writeHead(200); res.write('partial') }); if (!f) return
  const cache = join(f.dir, 'cache')
  const get = f.createCachedFetcher({ dir: cache, site: f.url })
  await assert.rejects(get('meme/new.json'), { code: 'QQAI_NETWORK_TIMEOUT' })
  await assert.rejects(readFile(join(cache, 'meme/new.json')), { code: 'ENOENT' })
})
