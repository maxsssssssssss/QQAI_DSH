// Temporary verification module. Installed by run-chat-thinking-check.py only.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const id = '__MODULE_ID__'
const syntheticId = '__SESSION_ID__'
const normalized = value => String(value || '').replace(/^session-/, '')
const sha = value => createHash('sha256').update(value).digest('hex')
const check = value => { if (!value) throw new Error('Thinking verification failed') }
const textOf = message => (message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')

export default {
  id, name: 'QQAI 临时思考档位验证', version: '0.1.0',
  async setup(api) {
    const result = { owner: {}, requests: [], turns: [], tools: [], background: null, errors: 0 }
    const cfg = api.config()
    const ctrl = api.dsh.get('sessionController')
    const llm = api.dsh.get('llm')
    const defaults = () => api.dsh.get('agentDefaultModel').currentSelection()
    check(cfg.model.reasoningEffort === 'off' && defaults().reasoningEffort === 'off')
    const chat = { kind: 'private', userId: cfg.ownerQQ, chatId: `private:${cfg.ownerQQ}` }
    const target = api.core.hub.modelFor(chat)
    check(target.provider === 'deepseek-official' && target.model === 'deepseek-flash' && target.reasoningEffort === 'high')
    const effective = await llm.resolveCallConfig(target)
    check(effective.reasoningEffort === 'high')
    const mapping = () => JSON.parse(readFileSync('/srv/qqai-dsh/home/.dsh/plugins-data/aurabot/sessions.json', 'utf8')).chats[chat.chatId].sessionId
    const ownerId = mapping()
    const loadedOwner = await ctrl.resolveAgent(ownerId)
    const owner = loadedOwner.agent ?? loadedOwner
    await owner.runMaintenance(async () => {
      const before = JSON.stringify(owner.session.deriveMessages())
      ctrl.agents.selectForNextRequest(owner, target)
      check(await api.dsh.get('sessions').flush(owner.session))
      const selected = ctrl.agents.selectionFor(owner).current
      check(selected.reasoningEffort === 'high' && before === JSON.stringify(owner.session.deriveMessages()) && mapping() === ownerId)
      const systems = owner.session.deriveMessages().filter(m => m.role === 'system')
      const persona = cfg.ext['qqai-compat'].personaText.trim()
      check(systems.length === 1 && textOf(systems[0]).includes(persona))
      result.owner = { selected: { ...selected }, effectiveEffort: effective.reasoningEffort,
        historyIdentical: true, originalSessionPreserved: true, modelSelectionFlushed: true,
        personaSha256: sha(persona), activeSystemCount: systems.length,
        nonSystemMessages: owner.session.deriveMessages().filter(m => m.role !== 'system').length }
    })
    const selected = agent => normalized(agent?.session?.id) === syntheticId
    const observe = fn => (...args) => {
      try { return fn(...args) } catch { result.errors++ }
    }
    const tools = api.dsh.get('tools')
    api.onDispose(tools.guard(exec => selected(exec.agent) && exec.name !== 'sticker_search'
      ? 'This isolated check permits only reading the sticker catalog.' : undefined))
    api.onDispose(api.dsh.on('agent/created', ({ agent }) => {
      if (selected(agent)) api.onDispose(agent.ctx.tools.restrict({ allow: ['sticker_search'] }))
    }))
    api.onDispose(api.dsh.on('llm/stream', (options, next) => {
      if (normalized(options.sessionId) === syntheticId) observe(() => {
        const systems = (options.messages || []).filter(m => m.role === 'system')
        const primary = Object.isFrozen(options) && systems.length > 0
        result.requests.push({ kind: primary ? 'dialogue' : 'auxiliary',
          model: options.model, effort: options.reasoningEffort ?? null,
          personaMatches: primary ? systems.some(m => textOf(m).includes(cfg.ext['qqai-compat'].personaText.trim())) : null,
          replayedReasoningBlocks: (options.messages || []).flatMap(m => m.content || []).filter(b => b.type === 'reasoning').length,
          tools: (options.tools || []).map(t => t.name) })
      })()
      return next()
    }))
    api.onDispose(api.dsh.on('tools/result', observe((exec, response) => {
      if (selected(exec.agent)) result.tools.push({ name: exec.name, success: !response.isError })
    })))
    api.onDispose(api.dsh.on('session/event', observe((session, event) => {
      if (normalized(session?.id) !== syntheticId) return
      if (event.type === 'assistant/message') {
        const blocks = event.data.message?.content || []
        const text = textOf(event.data.message)
        const reasoning = blocks.filter(b => b.type === 'reasoning').reduce((n, b) => n + String(b.text || '').length, 0)
        result.turns.push({ event: 'assistant', textCharacters: text.length, reasoningCharacters: reasoning,
          containsSyntheticRecall: text.includes('海盐汽水') })
      }
      if (event.type === 'turn/end') result.turns.push({ event: 'end', reason: event.data?.reason?.kind })
    })))
    api.route('/state', req => req.method === 'GET' ? { ok: true, ...result, defaultEffort: defaults().reasoningEffort }
      : { ok: false })
    api.route('/high', async req => {
      if (req.method !== 'POST') return { ok: false }
      const loaded = await ctrl.resolveAgent(syntheticId)
      const agent = loaded.agent ?? loaded
      check(selected(agent))
      ctrl.agents.selectForNextRequest(agent, target)
      check(await api.dsh.get('sessions').flush(agent.session))
      return { ok: true, effort: ctrl.agents.selectionFor(agent).current.reasoningEffort }
    })
    api.route('/background', async req => {
      if (req.method !== 'POST' || result.background) return { ok: false }
      const report = { effort: null, requests: 0, reasoningCharacters: 0, validMoodResult: false }
      result.background = report
      const wrapped = new Proxy(llm, { get(service, key) {
        if (key === 'stream') return async function* (options) {
          report.requests++
          report.effort = options.reasoningEffort
          check(report.effort === 'off')
          for await (const chunk of service.stream(options)) {
            if (/reasoning|thinking/.test(chunk.type)) report.reasoningCharacters += String(chunk.text || '').length
            yield chunk
          }
        }
        const value = Reflect.get(service, key, service)
        return typeof value === 'function' ? value.bind(service) : value
      } })
      const { askModel } = api.lib('core/llm.js')
      const { parseMoodJudge } = api.lib('features/companion.js')
      const answer = await askModel({ llm: wrapped, get: key => key === 'llm' ? wrapped : api.dsh.get(key) }, {
        cfg: api.config(), maxTokens: 400,
        system: '判断合成对话中角色的心情变化。只输出 JSON，包含 delta（-15 到 15 整数）、reason、confidence（0 到 1）。',
        text: '主人说谢谢你今天陪我，小鲸说我也很开心。' })
      report.validMoodResult = Boolean(parseMoodJudge(answer))
      check(report.validMoodResult && report.reasoningCharacters === 0)
      return { ok: true, ...report }
    })
    return { verificationOnly: true }
  }
}
