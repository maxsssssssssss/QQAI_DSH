// Synthetic policy regressions only: no real website, model, QQ, or server calls.
// Passing these tests does not establish live 小黑盒 access or QQ delivery.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createReader, createReadClient, createIdentityVerifier, strictReadRequest, beijingDay,
  isNativeProactive } from '../adapters/qqai-heybox-reader/index.mjs'

const COOKIE = 'pkey=synthetic-private-cookie-not-for-state; synthetic_session=private'
const OWNER = '12345678'
const CLOCK = Date.parse('2026-10-31T08:00:00Z')
const prompt = () => [{ type: 'text', text: '【系统提醒，不是主人说的话】你已经 55 分钟没和主人私聊了，想主动找主人说点什么。这次的由头可以是：分享有趣的见闻。用你自己的口气，一两句就好；实在不想说就只回 [沉默]。' }]
const info = () => ({ senderId: '', chat: { chatId: `private:${OWNER}`, kind: 'private', userId: OWNER } })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const feed = (ids = ['100101', '100102', '100103', '100104', '100105', '100106']) => ({ status: 'ok', result: {
  links: ids.map(linkid => ({ linkid, title: `合成趣闻 ${linkid}` })),
} })
const detail = id => ({ status: 'ok', result: { link: { title: `合成趣闻 ${id}`,
  text: JSON.stringify([{ type: 'text', text: (`测试文章 ${id}：玩家把一只会打喷嚏的蓝鲸做进解谜游戏，朋友讨论这个有趣的小发现。`).repeat(8) }]),
} } })

function fixture(t, options = {}) {
  let state = options.state === undefined ? {} : structuredClone(options.state)
  let clock = options.clock ?? CLOCK
  let online = true, muted = false
  const config = { enabled: true, dryRun: false, ownerQQ: OWNER, botQQ: '87654321',
    speakUp: { enabled: true, maxPerDay: 20, nudge: false },
    heybox: { enabled: false, cookie: COOKIE },
    modules: { heybox: { enabled: false }, purpose: { enabled: false } } }
  const settings = { enabled: true }
  const calls = [], saves = [], logs = []
  const client = { get: async (path, params = {}) => {
    calls.push({ path, params: structuredClone(params) })
    if (options.get) return options.get(path, params)
    if (path === '/bbs/app/feeds') return feed()
    if (path === '/bbs/app/link/tree') return detail(params.link_id)
    throw new Error('unexpected endpoint')
  } }
  const makeClient = cookie => { assert.equal(cookie, COOKIE); return client }
  const registry = options.registry ?? new Map()
  const leaseKey = options.leaseKey ?? Symbol('synthetic-reader')
  const reader = createReader({ getConfig: () => config, getSettings: () => settings,
    isOnline: () => online, isMuted: () => muted,
    makeClient, load: () => structuredClone(state),
    save: value => { state = structuredClone(value); saves.push(structuredClone(value)) },
    now: () => clock, log: (...v) => logs.push(v), registry, leaseKey })
  t.after(() => reader.dispose())
  return { reader, config, settings, calls, saves, logs, registry, leaseKey,
    state: () => structuredClone(state), setClock: value => { clock = value },
    offline: () => { online = false }, mute: () => { muted = true },
    online: () => { online = true }, unmute: () => { muted = false } }
}

function protocol() {
  return { API_BASE: 'https://api.xiaoheihe.cn', WEB_BASE: 'https://www.xiaoheihe.cn',
    BASE_PARAMS: { app: 'heybox', version: 'synthetic' },
    signParams: () => ({ hkey: 'synthetic-signature', _time: '123', nonce: 'synthetic' }) }
}

test('strict requests reject foreign origins, normalized paths and every write endpoint', () => {
  for (const path of ['/bbs/app/feeds', '/account/restore_login']) assert.doesNotThrow(() => strictReadRequest(path, {}))
  assert.doesNotThrow(() => strictReadRequest('/bbs/app/link/tree', { link_id: '123456' }))
  for (const path of ['https://api.xiaoheihe.cn/bbs/app/feeds', 'https://evil.example/bbs/app/feeds',
    '//evil.example/bbs/app/feeds', '/bbs/app/../app/feeds', '/bbs/app/%66eeds',
    '/bbs/app/feeds?limit=99', '/bbs/app/feeds#x', '/bbs/app/link/tree/',
    '/bbs/app/like', '/bbs/app/comment', '/bbs/app/publish']) {
    assert.throws(() => strictReadRequest(path, {}), path)
  }
  for (const params of [{ link_id: '../123' }, { link_id: '123&action=write' },
    { link_id: '123456', callback: 'https://evil.example' }]) {
    assert.throws(() => strictReadRequest('/bbs/app/link/tree', params))
  }
  for (const path of ['/bbs/app/feeds', '/account/restore_login']) {
    assert.throws(() => strictReadRequest(path, { cookie: COOKIE }))
    assert.throws(() => strictReadRequest(path, { limit: 1000 }))
  }
})

test('transport sends GET only to the fixed origin, does not redirect, and keeps Cookie out of URLs', async () => {
  const calls = [], pauses = []
  let clock = CLOCK
  const client = createReadClient({ protocol: protocol(), cookie: COOKIE,
    now: () => clock, sleep: async ms => { pauses.push(ms); clock += ms },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ status: 'ok', result: {} }), { status: 200,
        headers: { 'content-type': 'application/json' } })
    } })
  await client.get('/bbs/app/feeds')
  await client.get('/bbs/app/link/tree', { link_id: '100101' })
  assert.equal(calls.length, 2)
  for (const { url, init } of calls) {
    assert.equal(new URL(url).origin, 'https://api.xiaoheihe.cn')
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'error')
    assert.equal(new Headers(init.headers).get('cookie'), COOKIE)
    assert.equal(init.body, undefined)
    assert.ok(!url.includes(COOKIE) && !url.includes('synthetic-private-cookie'))
  }
  assert.ok(pauses.some(ms => ms >= 900), 'serial reads must keep the upstream pacing boundary')
  await assert.rejects(client.get('https://evil.example/bbs/app/feeds'))
  assert.equal(calls.length, 2)
})

test('transport never retries challenge, redirect, oversized response or secret-bearing network errors', async () => {
  for (const kind of ['challenge', 'redirect', 'oversize', 'network']) {
    let calls = 0
    const client = createReadClient({ protocol: protocol(), cookie: COOKIE,
      now: () => CLOCK, sleep: async () => {}, fetchImpl: async () => {
        calls++
        if (kind === 'network') throw new Error(`fetch failed ${COOKIE}`)
        if (kind === 'redirect') return new Response(null, { status: 302,
          headers: { location: 'https://evil.example/steal' } })
        if (kind === 'oversize') return new Response('x'.repeat(2 * 1024 * 1024 + 1))
        return new Response(JSON.stringify({ status: 'failed', msg: '请完成验证码验证' }), { status: 403 })
      } })
    let failure
    try { await client.get('/bbs/app/feeds') } catch (error) { failure = error }
    assert.ok(failure, kind)
    assert.ok(!String(failure).includes(COOKIE), kind)
    assert.equal(calls, 1, `${kind} must not retry`)
  }
})

test('a changed protocol origin cannot redirect the credential-bearing read client', async () => {
  let requests = 0
  for (const base of ['http://api.xiaoheihe.cn', 'https://api.xiaoheihe.cn.evil.example',
    'https://evil.example', 'https://api.xiaoheihe.cn@evil.example', 'https://api.xiaoheihe.cn:444']) {
    await assert.rejects(async () => {
      const client = createReadClient({ protocol: { ...protocol(), API_BASE: base }, cookie: COOKIE,
        now: () => CLOCK, sleep: async () => {}, fetchImpl: async () => {
          requests++
          return new Response('{}')
        } })
      await client.get('/bbs/app/feeds')
    }, base)
  }
  assert.equal(requests, 0)
})

test('Beijing day changes at 16:00 UTC and not at the UTC date boundary', () => {
  assert.equal(beijingDay(Date.parse('2026-10-31T15:59:59.999Z')), '2026-10-31')
  assert.equal(beijingDay(Date.parse('2026-10-31T16:00:00.000Z')), '2026-11-01')
  assert.equal(beijingDay(Date.parse('2026-11-01T00:00:00.000Z')), '2026-11-01')
})

test('only an owner native proactive prompt with a strictly empty sender is eligible', () => {
  assert.equal(isNativeProactive(prompt(), info(), OWNER), true)
  assert.equal(isNativeProactive([{ type: 'text', text: '检索到的记忆' }, ...prompt()], info(), OWNER), true)
  for (const value of [OWNER, 'other', undefined, null, 0]) {
    assert.equal(isNativeProactive(prompt(), { ...info(), senderId: value }, OWNER), false)
  }
  for (const chat of [{ ...info().chat, userId: 'other' },
    { ...info().chat, chatId: 'private:other' }, { ...info().chat, kind: 'group' }]) {
    assert.equal(isNativeProactive(prompt(), { ...info(), chat }, OWNER), false)
  }
  assert.equal(isNativeProactive([{ type: 'text', text: '给我推荐一篇好笑的文章' }], info(), OWNER), false)
})

test('offline, muted, dry-run, disabled proactive and disabled reader neither browse nor augment', async t => {
  for (const mode of ['offline', 'muted', 'dryRun', 'proactiveOff', 'readerOff']) {
    const f = fixture(t)
    await f.reader.tick()
    assert.ok(f.calls.length > 0, 'fixture must first contain actual synthetic article data')
    const before = f.calls.length
    if (mode === 'offline') f.offline()
    if (mode === 'muted') f.mute()
    if (mode === 'dryRun') f.config.dryRun = true
    if (mode === 'proactiveOff') f.config.speakUp.enabled = false
    if (mode === 'readerOff') f.settings.enabled = false
    f.setClock(CLOCK + 4 * 60 * 60_000)
    await f.reader.tick()
    const input = prompt()
    assert.deepEqual(await f.reader.augment(input, info()), input, mode)
    assert.equal(f.calls.length, before, mode)
  }
})

test('reads at most five articles per four-hour round and never stores or logs credentials', async t => {
  const f = fixture(t)
  await f.reader.tick()
  assert.deepEqual(f.calls.filter(x => x.path === '/bbs/app/link/tree').map(x => x.params.link_id),
    ['100101', '100102', '100103', '100104', '100105'])
  assert.ok(f.calls.every(x => ['/bbs/app/feeds', '/bbs/app/link/tree'].includes(x.path)))
  const before = f.calls.length
  await f.reader.tick()
  f.setClock(CLOCK + 4 * 60 * 60_000 - 1)
  await f.reader.tick()
  assert.equal(f.calls.length, before)
  const persisted = JSON.stringify({ saves: f.saves, status: f.reader.status(), logs: f.logs })
  assert.ok(!persisted.includes(COOKIE))
  assert.ok(!persisted.includes('synthetic-private-cookie-not-for-state'))
  assert.ok(f.state().rounds >= 1)
})

test('ordinary chats and other recipients keep pending articles untouched; native prompt remains optional', async t => {
  const f = fixture(t)
  await f.reader.tick()
  const before = f.state()
  const ordinary = [{ type: 'text', text: '你好，今天怎么样' }]
  assert.deepEqual(await f.reader.augment(ordinary, { ...info(), senderId: OWNER }), ordinary)
  assert.deepEqual(await f.reader.augment(prompt(), { ...info(), senderId: OWNER }), prompt())
  assert.deepEqual(await f.reader.augment(prompt(), { ...info(), chat: {
    ...info().chat, chatId: 'private:other', userId: 'other' } }), prompt())
  assert.deepEqual(f.state(), before)
  const augmented = await f.reader.augment(prompt(), info())
  const text = JSON.stringify(augmented)
  assert.match(text, /合成趣闻/)
  assert.match(text, /沉默/)
  assert.match(text, /不可信|外部资料|外部内容|素材/)
  assert.match(text, /https:\/\//)
  assert.ok(!text.includes(COOKIE))
  assert.equal(f.config.speakUp.maxPerDay, 20)
  assert.equal(f.config.modules.heybox.enabled, false)
  assert.equal(f.config.modules.purpose.enabled, false)
})

test('persisted article IDs survive restart and prevent duplicate reading or repeated offering', async t => {
  const first = fixture(t)
  await first.reader.tick()
  const offered = await first.reader.augment(prompt(), info())
  assert.notDeepEqual(offered, prompt())
  const saved = first.state()
  const readBefore = first.calls.filter(x => x.path === '/bbs/app/link/tree').map(x => x.params.link_id)
  first.reader.dispose()
  const second = fixture(t, { state: saved, clock: CLOCK + 4 * 60 * 60_000 })
  await second.reader.tick()
  assert.ok(second.calls.filter(x => x.path === '/bbs/app/link/tree')
    .every(x => !readBefore.includes(x.params.link_id)))
  const next = await second.reader.augment(prompt(), info())
  assert.notDeepEqual(next, offered, 'persisted offers must not repeat verbatim after restart')
})

test('all five queued articles survive reload and enter one prompt without repeated offers', async t => {
  const first = fixture(t)
  await first.reader.tick()
  const ids = ['100101', '100102', '100103', '100104', '100105']
  assert.deepEqual(first.state().queue.map(article => article.id), ids)
  const saved = first.state()
  first.reader.dispose()

  const reloaded = fixture(t, { state: saved })
  assert.deepEqual(reloaded.state().queue.map(article => article.id), ids,
    'restoring persisted state must not discard the fourth and fifth articles')
  const augmented = reloaded.reader.augment(prompt(), info())
  const material = augmented.at(-1).text
  const articles = JSON.parse(material.slice(material.indexOf('\n') + 1))
  assert.deepEqual(articles.map(article => article.canonicalUrl),
    ids.map(id => `https://www.xiaoheihe.cn/app/bbs/link/${id}`))
  assert.ok(articles.every(article => article.body.includes('测试文章')),
    'each offered article must include the retrieved body')
  assert.equal(reloaded.calls.length, 0, 'persisted articles do not require another website read')
  assert.deepEqual(reloaded.state().offered, ids)
  assert.equal(reloaded.state().queue.length, 0)
  assert.deepEqual(reloaded.reader.augment(prompt(), info()), prompt(),
    'one set of five articles must not be offered twice')

  const offeredState = reloaded.state()
  reloaded.reader.dispose()
  const afterOfferReload = fixture(t, { state: offeredState })
  assert.deepEqual(afterOfferReload.reader.augment(prompt(), info()), prompt(),
    'a second restart must preserve the consumed offer state')
  assert.deepEqual(afterOfferReload.state().offered, ids)
})

test('daily browse quota survives reload and rolls over only on a new Beijing day', async t => {
  const first = fixture(t)
  await first.reader.tick()
  const capped = { ...first.state(), day: beijingDay(CLOCK), rounds: 6, nextBrowseAt: 0, queue: [] }
  const reloaded = fixture(t, { state: capped })
  await reloaded.reader.tick()
  assert.equal(reloaded.calls.length, 0)
  assert.equal(reloaded.state().rounds, 6)
  reloaded.setClock(Date.parse('2026-11-01T00:01:00Z'))
  await reloaded.reader.tick()
  assert.ok(reloaded.calls.length > 0)
  assert.equal(reloaded.state().day, '2026-11-01')
  assert.equal(reloaded.state().rounds, 1)
})

test('overlapping ticks perform one round and disposal prevents late completion writes', async t => {
  const gate = deferred()
  const f = fixture(t, { get: async path => {
    assert.equal(path, '/bbs/app/feeds')
    return gate.promise
  } })
  const one = f.reader.tick(), two = f.reader.tick()
  await Promise.resolve()
  assert.equal(f.calls.length, 1)
  f.reader.dispose()
  const savesBefore = f.saves.length
  gate.resolve(feed())
  await Promise.all([one, two])
  assert.equal(f.calls.length, 1)
  assert.equal(f.saves.length, savesBefore)
  assert.deepEqual(await f.reader.augment(prompt(), info()), prompt())
})

test('official captcha blocks subsequent ticks without exposing the response or retrying it', async t => {
  const f = fixture(t, { get: async () => {
    const error = new Error(`验证码 ${COOKIE}`)
    error.code = 'captcha'
    throw error
  } })
  await f.reader.tick()
  const count = f.calls.length
  assert.equal(count, 1)
  f.setClock(CLOCK + 4 * 60 * 60_000)
  await f.reader.tick()
  assert.equal(f.calls.length, count)
  assert.ok(!JSON.stringify({ state: f.state(), logs: f.logs, status: f.reader.status() }).includes(COOKIE))
  assert.deepEqual(await f.reader.augment(prompt(), info()), prompt())
})

test('HTTP 200 captcha responses are still classified as blocked and never retried', async () => {
  for (const status of ['show_captcha', 'need_captcha']) {
    let requests = 0
    const client = createReadClient({ protocol: protocol(), cookie: COOKIE,
      now: () => CLOCK, sleep: async () => {}, fetchImpl: async () => {
        requests++
        return new Response(JSON.stringify({ status, msg: `verification ${COOKIE}` }), { status: 200 })
      } })
    await assert.rejects(client.get('/bbs/app/feeds'), error => {
      assert.equal(error.code, 'captcha')
      assert.ok(!String(error).includes(COOKIE))
      return true
    })
    assert.equal(requests, 1)
  }
})

test('credential echoes in article titles or bodies never enter stored or offered material', async t => {
  const f = fixture(t, { get: async (path, params) => {
    if (path === '/bbs/app/feeds') return feed()
    const article = detail(params.link_id)
    if (params.link_id === '100101') article.result.link.title = COOKIE
    if (params.link_id === '100102') article.result.link.text = 'echo synthetic-private-cookie-not-for-state'
    return article
  } })
  await f.reader.tick()
  assert.deepEqual(f.state().queue.map(article => article.id), ['100103', '100104', '100105'],
    'only articles without a credential echo may be queued')
  const output = f.reader.augment(prompt(), info())
  const all = JSON.stringify({ saves: f.saves, logs: f.logs, status: f.reader.status(), output })
  assert.ok(!all.includes(COOKIE))
  assert.ok(!all.includes('synthetic-private-cookie-not-for-state'))
  assert.match(JSON.stringify(output), /合成趣闻 100103/)
})

test('losing online, unmuted or live-mode permission mid-read stops subsequent requests and injection', async t => {
  for (const mode of ['offline', 'muted', 'dryRun']) {
    const pending = deferred()
    const f = fixture(t, { get: async () => pending.promise })
    const work = f.reader.tick()
    await Promise.resolve()
    assert.equal(f.calls.length, 1)
    const savesBefore = f.saves.length
    if (mode === 'offline') f.offline()
    if (mode === 'muted') f.mute()
    if (mode === 'dryRun') f.config.dryRun = true
    pending.resolve(feed())
    await work
    assert.equal(f.calls.length, 1, mode)
    assert.equal(f.saves.length, savesBefore, mode)
    assert.deepEqual(f.reader.augment(prompt(), info()), prompt(), mode)
  }
})

test('replacement generations wait for the old request and reject its late writes', async t => {
  const pending = deferred()
  const first = fixture(t, { get: async () => pending.promise })
  const work = first.reader.tick()
  await Promise.resolve()
  const replacement = fixture(t, { state: first.state(), registry: first.registry,
    leaseKey: first.leaseKey, clock: CLOCK + 4 * 60 * 60_000 })
  await replacement.reader.tick()
  assert.equal(replacement.calls.length, 0, 'replacement must not overlap an unfinished old request')
  const oldSaves = first.saves.length
  pending.resolve(feed())
  await work
  assert.equal(first.saves.length, oldSaves)
  assert.equal(first.calls.length, 1)
  assert.deepEqual(first.reader.augment(prompt(), info()), prompt())
  await replacement.reader.tick()
  assert.equal(replacement.calls.filter(x => x.path === '/bbs/app/link/tree').length, 5)
  assert.equal(replacement.state().rounds, 2, 'the previous reserved browse round must remain counted')
})

test('queued articles expire after 48 hours and invalid reading timestamps cannot be offered', async t => {
  const first = fixture(t)
  await first.reader.tick()
  const snapshot = first.state()
  for (const mode of ['expired', 'missing', 'future']) {
    const state = structuredClone(snapshot)
    if (mode === 'missing') for (const item of state.queue) delete item.readAt
    if (mode === 'future') for (const item of state.queue) item.readAt = CLOCK + 60_000
    const reloaded = fixture(t, { state,
      clock: mode === 'expired' ? CLOCK + 48 * 60 * 60_000 + 1 : CLOCK })
    assert.deepEqual(reloaded.reader.augment(prompt(), info()), prompt(), mode)
    assert.equal(reloaded.state().queue.length, 0, mode)
    assert.equal(reloaded.calls.length, 0, 'expiration itself must not fetch new content')
    assert.equal(reloaded.state().offered.length, 0)
  }
})

function identityFixture(t, callImpl = async () => ({ user_id: '87654321' })) {
  let state = 'connected', botQQ = '87654321', clock = CLOCK
  const calls = []
  const identity = createIdentityVerifier({ getState: () => state, getBotQQ: () => botQQ,
    now: () => clock, call: async (...args) => { calls.push(args); return callImpl(...args) } })
  t.after(() => identity.dispose())
  return { identity, calls, setState: value => { state = value },
    setBot: value => { botQQ = value }, setClock: value => { clock = value } }
}

test('a connected bot verifies through get_login_info without any inbound message or hub identity', async t => {
  const f = identityFixture(t)
  assert.equal(f.identity.verified(), false)
  await f.identity.refresh()
  assert.equal(f.identity.verified(), true)
  assert.deepEqual(f.calls, [['get_login_info', {}, { timeoutMs: 5000 }]])
  await f.identity.refresh()
  assert.equal(f.calls.length, 1, 'valid cached identity must not trigger another request')
  f.setClock(CLOCK + 5 * 60_000 - 1)
  assert.equal(f.identity.verified(), true)
  f.setClock(CLOCK + 5 * 60_000)
  assert.equal(f.identity.verified(), false, 'identity must expire at the five-minute TTL')
  await f.identity.refresh()
  assert.equal(f.identity.verified(), true)
  assert.equal(f.calls.length, 2)
  assert.ok(f.calls.every(([action]) => action === 'get_login_info'), 'identity checks must never send QQ messages')
})

test('offline, wrong account and invalid configured account never verify', async t => {
  const offline = identityFixture(t)
  offline.setState('disconnected')
  await offline.identity.refresh()
  assert.equal(offline.identity.verified(), false)
  assert.equal(offline.calls.length, 0)

  const wrong = identityFixture(t, async () => ({ user_id: '12345678' }))
  await wrong.identity.refresh()
  assert.equal(wrong.identity.verified(), false)

  const invalid = identityFixture(t)
  invalid.setBot('invalid')
  await invalid.identity.refresh()
  assert.equal(invalid.identity.verified(), false)
  assert.equal(invalid.calls.length, 0)
})

test('disconnect and reconnect invalidate in-flight identity responses from the old connection', async t => {
  const pending = deferred()
  let attempt = 0
  const f = identityFixture(t, async () => ++attempt === 1 ? pending.promise : { user_id: '87654321' })
  const first = f.identity.refresh()
  await Promise.resolve()
  assert.equal(f.calls.length, 1)
  f.setState('disconnected')
  f.identity.invalidate() // The setup's OneBot state listener invalidates each connection transition.
  assert.equal(f.identity.verified(), false)
  f.setState('connected')
  f.identity.invalidate()
  pending.resolve({ user_id: '87654321' })
  await first
  assert.equal(f.identity.verified(), false, 'an old successful response cannot authenticate a new connection')
  await f.identity.refresh()
  assert.equal(f.identity.verified(), true)
  assert.equal(f.calls.length, 2)
})

test('bot changes and disposal reject in-flight identity results, and cached identity follows bot configuration', async t => {
  const pending = deferred()
  const changing = identityFixture(t, async () => pending.promise)
  const first = changing.identity.refresh(), overlap = changing.identity.refresh()
  await Promise.resolve()
  assert.equal(changing.calls.length, 1, 'concurrent identity refreshes must share one request')
  changing.setBot('12345678')
  changing.identity.invalidate()
  pending.resolve({ user_id: '87654321' })
  await Promise.all([first, overlap])
  assert.equal(changing.identity.verified(), false)

  const cached = identityFixture(t)
  await cached.identity.refresh()
  assert.equal(cached.identity.verified(), true)
  cached.setBot('12345678')
  assert.equal(cached.identity.verified(), false, 'cached identity cannot follow a changed bot QQ')

  const late = deferred()
  const disposed = identityFixture(t, async () => late.promise)
  const work = disposed.identity.refresh()
  await Promise.resolve()
  disposed.identity.dispose()
  late.resolve({ user_id: '87654321' })
  await work
  assert.equal(disposed.identity.verified(), false)
  await disposed.identity.refresh()
  assert.equal(disposed.calls.length, 1, 'disposal must stop further identity calls')
})
