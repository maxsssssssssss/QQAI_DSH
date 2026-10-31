// Temporary metadata-only observer for the configured owner's real QQ session.
// Install only during acceptance. Never records prompts, tool arguments/results,
// QQ identifiers, nicknames, authentication material, or reasoning content.
import { readFileSync, mkdirSync, lstatSync, chmodSync, openSync, fstatSync,
  fchmodSync, writeFileSync, closeSync, constants } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'

export const inject = ['tools', 'systemPrompt']
const hash = value => createHash('sha256').update(value).digest('hex')
const sessionKey = value => String(value || '').replace(/^session-/, '')
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const allowed = (value, choices) => choices.includes(value) ? value : null
const toolNames = new Set(['sticker_search', 'sticker_send', 'meme_render', 'sticker_manage',
  'web_search', 'web_fetch', 'remember', 'recall_memory', 'qq_chat_history', 'qq_send_message'])

export function apply(ctx) {
  const output = process.env.DSH_QQ_AUDIT_DIR
  const home = process.env.DSH_HOME
  if (!isAbsolute(output || '') || !isAbsolute(home || '')) {
    throw new Error('QQ audit requires protected absolute runtime directories')
  }
  mkdirSync(output, { recursive: true, mode: 0o700 })
  if (!lstatSync(output).isDirectory()) throw new Error('QQ audit output must be a protected directory')
  chmodSync(output, 0o700)
  const data = join(home, 'plugins-data', 'aurabot')
  const ownerSession = agent => {
    try {
      const config = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'))
      if (!/^\d{5,12}$/.test(String(config.ownerQQ || ''))) return null
      const map = JSON.parse(readFileSync(join(data, 'sessions.json'), 'utf8'))
      const id = map.chats?.[`private:${config.ownerQQ}`]?.sessionId
      const actual = agent?.session?.id
      return id && actual && sessionKey(id) === sessionKey(actual)
        ? hash(sessionKey(id)).slice(0, 20) : null
    } catch { return null }
  }
  const record = (session, fields) => {
    const fd = openSync(join(output, 'metadata.jsonl'), constants.O_WRONLY | constants.O_APPEND
      | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
    try {
      if (!fstatSync(fd).isFile()) throw new Error('QQ audit output must be a regular file')
      fchmodSync(fd, 0o600)
      writeFileSync(fd, JSON.stringify({ at: new Date().toISOString(), session, ...fields }) + '\n')
    } finally { closeSync(fd) }
  }
  let warned = false
  const observerFailure = () => {
    // Never log the original exception: it can contain request/credential data.
    if (!warned) { warned = true; console.warn('QQAI audit metadata capture failed; model request was left unchanged') }
  }

  // At request time Aurabot has already attached its dynamic QQ tools/persona.
  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const config = await next()
    try {
      const id = ownerSession(agent)
      if (id) {
        const assembly = await ctx.systemPrompt.assemble({ scope: agent })
        const persona = typeof assembly?.variables?.aurabot_persona === 'string'
          ? assembly.variables.aurabot_persona : ''
        const names = ctx.tools.schemas(agent).map(tool => tool.name)
        record(id, {
          type: 'request-metadata', turn: number(turn), step: number(step),
          provider: allowed(config.provider, ['deepseek-official']),
          model: allowed(config.model, ['deepseek-flash']),
          reasoningEffort: allowed(config.reasoningEffort, ['off', 'low', 'medium', 'high', 'xhigh', 'max']),
          tools: names.filter(name => toolNames.has(name)),
          unknownToolCount: names.filter(name => !toolNames.has(name)).length,
          personaSha256: persona ? hash(persona) : null,
          personaHasWhaleIdentity: /鲸鱼娘/.test(persona),
          personaHasAiIdentity: /AI 伙伴/.test(persona),
          personaHasDefaultName: /你的名字是大肥鱼/.test(persona),
        })
      }
    } catch { observerFailure() }
    return config
  })
  ctx.on('tools/result', (exec, result) => {
    try {
      const id = ownerSession(exec.agent)
      if (id) record(id, { type: 'tool-result-metadata',
        name: toolNames.has(exec.name) ? exec.name : 'unknown',
        isError: Boolean(result?.isError), hasErrorCode: Boolean(result?.error?.code) })
    } catch { observerFailure() }
  })
}
