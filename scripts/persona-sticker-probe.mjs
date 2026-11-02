// Temporary read-only observer for isolated QQ-preset persona checks.
// This module has no QQ delivery, reminders, timers or mutating HTTP routes.
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync,
  renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const PREFIX = 'qqai-synthetic-stickers-'
const TOOLS = new Set(['sticker_search', 'sticker_send', 'meme_render', 'sticker_manage'])
const READ_ACTIONS = new Set(['browse', 'info', 'templates', 'credit'])
const sha = value => createHash('sha256').update(value).digest('hex')
const sid = value => String(value || '').replace(/^session-/, '')
const synthetic = value => sid(value).startsWith(PREFIX) && /^[a-z0-9-]+$/u.test(sid(value))
const textOf = message => typeof message?.content === 'string' ? message.content
  : (Array.isArray(message?.content) ? message.content : []).filter(part => part?.type === 'text')
    .map(part => typeof part.text === 'string' ? part.text : '').join('\n')
const numericUsage = value => Object.fromEntries(Object.entries(value || {})
  .filter(([key, n]) => ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens',
    'prompt_tokens', 'completion_tokens', 'total_tokens'].includes(key) && Number.isFinite(n) && n >= 0))

// A narrow surface-form diagnostic, not a general judgment of response style.
function stageDirectionMarkers(text) {
  const spans = String(text).match(/（[^（）\r\n]{1,180}）|\([^()\r\n]{1,180}\)|\*{1,2}[^*\r\n]{1,180}\*{1,2}/gu) || []
  return spans.filter(span => /尾巴|摇尾|摆尾|甩尾|喷水|笔记本|抱着本子|蹭蹭|鼓起腮帮/u.test(span)).length
}

export default {
  id: 'qqai-neko-probe', name: 'QQAI 临时人格只读验证', version: '0.2.0',
  setup(api) {
    const file = api.dataDir('persona-sticker-state.json'), parent = dirname(file)
    if (lstatSync(parent).isSymbolicLink()) throw new Error('Unsafe probe directory')
    chmodSync(parent, 0o700)
    let saved = { version: 1, startedAt: new Date().toISOString(), cases: {}, deniedTools: 0, observerErrors: 0 }
    if (existsSync(file)) {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('Unsafe probe record')
      saved = JSON.parse(readFileSync(file, 'utf8'))
      if (saved.version !== 1 || !saved.cases || Array.isArray(saved.cases)
        || !Number.isSafeInteger(saved.deniedTools) || !Number.isSafeInteger(saved.observerErrors)) throw new Error('Invalid probe record')
      chmodSync(file, 0o600)
    }
    let revision = 0
    const persist = () => {
      const temp = `${file}.${process.pid}.${++revision}.tmp`
      const fd = openSync(temp, 'wx', 0o600)
      try { writeFileSync(fd, JSON.stringify(saved, null, 2)); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temp, file)
    }
    const row = id => saved.cases[id] ||= { actualRequests: [], tools: [], usage: [],
      assistantMessages: 0, outputImages: 0, stockImages: 0, templateImages: 0,
      stageDirectionMarkers: 0, completed: false }
    const selected = agent => synthetic(agent?.session?.id) ? sid(agent.session.id) : null
    const observe = fn => (...args) => {
      try { return fn(...args) }
      catch { saved.observerErrors++; try { persist() } catch {} }
    }
    persist()

    const tools = api.dsh.get('tools')
    api.onDispose(tools.guard(exec => {
      if (!selected(exec.agent)) return
      if (!TOOLS.has(exec.name) || exec.name === 'sticker_manage' && !READ_ACTIONS.has(exec.arguments?.action)
        || exec.name === 'meme_render' && exec.arguments?.image) {
        saved.deniedTools++; persist()
        return 'Synthetic persona verification permits only sticker selection and text templates; no QQ, memory or curation writes.'
      }
    }))
    api.onDispose(api.dsh.on('agent/created', observe(({ agent }) => {
      const id = selected(agent); if (!id) return
      if (agent.ctx?.tools?.restrict) api.onDispose(agent.ctx.tools.restrict({ allow: [...TOOLS] }))
      row(id); persist()
    })))
    // Observe the actual provider-bound request. Do not independently assemble a prompt.
    api.onDispose(api.dsh.on('llm/stream', (options, next) => {
      if (synthetic(options.sessionId)) observe(() => {
        const r = row(sid(options.sessionId))
        const systemMessages = (options.messages || []).filter(message => message.role === 'system')
        const actualSystem = typeof options.system === 'string' && options.system
          ? options.system : systemMessages.length ? textOf(systemMessages.at(-1)) : ''
        const persona = api.config().ext['qqai-compat'].personaText.trim()
        const policy = api.use('qqai-compat')?.stickerPolicy?.() || ''
        const names = (options.tools || []).map(tool => tool.name)
        // Pinned DSH freezes agent-loop requests with an explicit system message.
        // Session-title requests share an ID but do not have this boundary.
        const primaryDialogue = Object.isFrozen(options) && systemMessages.length > 0
        r.actualRequests.push({ kind: primaryDialogue ? 'agent-dialogue' : 'auxiliary',
          provider: options.provider === 'deepseek-official' ? options.provider : 'unexpected',
          model: options.model === 'deepseek-flash' ? options.model : 'unexpected', thinkingOff: options.reasoningEffort === 'off',
          policyInActualSystem: Boolean(policy) && actualSystem.includes(policy),
          personaInActualSystem: Boolean(persona) && actualSystem.includes(persona), personaSha256: sha(persona),
          actualSystemSha256: sha(actualSystem), actualSystemCharacters: actualSystem.length,
          systemMessageCount: systemMessages.length, actualTools: names.filter(name => TOOLS.has(name)),
          otherActualToolCount: names.filter(name => !TOOLS.has(name)).length,
          frozenAgentRequest: Object.isFrozen(options) })
        persist()
      })()
      return next()
    }))
    api.onDispose(api.dsh.on('tools/result', observe((exec, result) => {
      const id = selected(exec.agent); if (!id) return
      row(id).tools.push({ name: TOOLS.has(exec.name) ? exec.name : 'blocked-other', isError: Boolean(result.isError) })
      persist()
    })))
    api.onDispose(api.dsh.on('session/event', observe((session, event) => {
      if (!synthetic(session?.id)) return
      const r = row(sid(session.id))
      if (event.type === 'assistant/message') {
        const d = event.data || {}, text = textOf(d.message || { content: d.content })
        const port = api.dsh.get('webServer')?.port
        const refs = [...text.matchAll(/!\[[^\]\r\n]*\]\((http:\/\/127\.0\.0\.1:\d+\/x-nekowhale-stickers\/(s\/[a-f0-9]{12}|r\/[a-f0-9]{16})\.gif)\)/gu)]
          .filter(match => match[1].startsWith(`http://127.0.0.1:${port}/`))
        r.assistantMessages++; r.outputImages += refs.length
        r.stockImages += refs.filter(match => match[2].startsWith('s/')).length
        r.templateImages += refs.filter(match => match[2].startsWith('r/')).length
        r.stageDirectionMarkers += stageDirectionMarkers(text)
        const usage = numericUsage(d.usage || d.message?.usage)
        if (Object.keys(usage).length) r.usage.push(usage)
      }
      if (event.type === 'turn/end') {
        r.completed = event.data?.reason?.kind === 'completed'
        r.terminal = ['completed', 'cancelled', 'error', 'failed'].includes(event.data?.reason?.kind)
          ? event.data.reason.kind : 'other'
      }
      if (['assistant/message', 'turn/end'].includes(event.type)) persist()
    })))
    api.route('/state', req => req.method === 'GET' ? { ok: true, version: saved.version,
      startedAt: saved.startedAt, cases: JSON.parse(JSON.stringify(saved.cases)),
      deniedTools: saved.deniedTools, observerErrors: saved.observerErrors,
      artifactCounts: { stock: 0, template: 0 }, qqDeliveryAvailable: false }
      : { ok: false, reason: 'read-only' })
    return { syntheticPrefix: PREFIX, permanentFeature: false, qqDeliveryAvailable: false }
  },
}
