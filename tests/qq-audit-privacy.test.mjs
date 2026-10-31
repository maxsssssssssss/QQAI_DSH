import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../scripts/audit-qq-runtime.mjs'

const secret = 'synthetic-secret-do-not-publish'
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'qqai-audit-test-'))
  const home = join(root, 'home'), output = join(root, 'audit')
  const data = join(home, 'plugins-data', 'aurabot')
  await mkdir(data, { recursive: true })
  await writeFile(join(data, 'config.json'), JSON.stringify({ ownerQQ: '1234567890', token: secret }))
  await writeFile(join(data, 'sessions.json'), JSON.stringify({ chats: {
    'private:1234567890': { sessionId: 'session-private-session-synthetic' },
  } }))
  const previous = { DSH_HOME: process.env.DSH_HOME, DSH_QQ_AUDIT_DIR: process.env.DSH_QQ_AUDIT_DIR }
  process.env.DSH_HOME = home
  process.env.DSH_QQ_AUDIT_DIR = output
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })
  const handlers = new Map()
  const warnings = []
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')))
  const agent = { session: { id: 'private-session-synthetic' } }
  const ctx = {
    on: (name, handler) => handlers.set(name, handler),
    systemPrompt: { assemble: async ({ scope }) => {
      assert.equal(scope, agent)
      return { variables: { aurabot_persona: `鲸鱼娘 AI 伙伴 你的名字是大肥鱼 ${secret}` } }
    } },
    tools: { schemas: () => [{ name: 'remember' }, { name: 'web_search' }, { name: secret }] },
  }
  apply(ctx)
  return { root, home, output, agent, ctx, handlers, warnings,
    file: join(output, 'metadata.jsonl') }
}

test('request audit emits only whitelisted primitives and returns the identical frozen model configuration', async (t) => {
  const f = await fixture(t)
  const config = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash',
    reasoningEffort: 'off', apiKey: secret, messages: Object.freeze([{ content: secret }]) })
  const next = async () => config
  const result = await f.handlers.get('agent/request')({ agent: f.agent, turn: { private: secret }, step: secret }, next)
  assert.equal(result, config)
  const text = await readFile(f.file, 'utf8')
  assert.ok(!text.includes(secret))
  assert.ok(!text.includes('1234567890'))
  assert.ok(!text.includes('private-session-synthetic'))
  const row = JSON.parse(text)
  assert.equal(row.turn, null)
  assert.equal(row.step, null)
  assert.deepEqual(row.tools, ['remember', 'web_search'])
  assert.equal(row.unknownToolCount, 1)
  assert.equal(row.reasoningEffort, 'off')
  assert.equal(row.personaHasWhaleIdentity, true)
  assert.equal((await stat(f.file)).mode & 0o777, 0o600)
  assert.equal((await stat(f.output)).mode & 0o777, 0o700)
})

test('unknown provider/model and free-form tool errors cannot leak private strings', async (t) => {
  const f = await fixture(t)
  const config = { provider: secret, model: secret, reasoningEffort: secret }
  assert.equal(await f.handlers.get('agent/request')({ agent: f.agent, turn: 1, step: 0 }, async () => config), config)
  f.handlers.get('tools/result')({ agent: f.agent, name: secret }, { isError: true, error: { code: secret }, content: secret })
  const text = await readFile(f.file, 'utf8')
  assert.ok(!text.includes(secret))
  const [request, result] = text.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(request.provider, null)
  assert.equal(request.model, null)
  assert.equal(request.reasoningEffort, null)
  assert.equal(result.name, 'unknown')
  assert.equal(result.hasErrorCode, true)
  assert.equal(result.isError, true)
})

test('assembly or output failure cannot fail a successful model request, expose its exception, or follow a symlink', async (t) => {
  const f = await fixture(t)
  const config = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash' })
  f.ctx.systemPrompt.assemble = async () => { throw new Error(secret) }
  assert.equal(await f.handlers.get('agent/request')({ agent: f.agent }, async () => config), config)
  assert.equal(f.warnings.length, 1)
  assert.ok(!f.warnings.join('\n').includes(secret))
  const outside = join(f.root, 'outside.txt')
  await writeFile(outside, 'original')
  await symlink(outside, f.file)
  f.ctx.systemPrompt.assemble = async () => ({ variables: {} })
  assert.equal(await f.handlers.get('agent/request')({ agent: f.agent }, async () => config), config)
  assert.doesNotThrow(() => f.handlers.get('tools/result')({ agent: f.agent, name: 'remember' }, { isError: false }))
  assert.equal(await readFile(outside, 'utf8'), 'original')
  assert.equal(f.warnings.length, 1)
})

test('non-owner sessions are skipped, while actual downstream request failures remain failures', async (t) => {
  const f = await fixture(t)
  const config = { model: 'deepseek-flash' }
  f.ctx.systemPrompt.assemble = async () => { throw new Error('must not assemble another session') }
  assert.equal(await f.handlers.get('agent/request')({ agent: { session: { id: 'other' } } }, async () => config), config)
  assert.equal(f.warnings.length, 0)
  await assert.rejects(readFile(f.file), { code: 'ENOENT' })
  const failure = new Error('original model failure')
  await assert.rejects(f.handlers.get('agent/request')({ agent: f.agent }, async () => { throw failure }), error => error === failure)
})
