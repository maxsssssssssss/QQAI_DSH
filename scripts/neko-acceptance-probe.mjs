// Temporary, explicitly installed acceptance module. Synthetic sessions only.
// Public status contains metadata, never prompts, model text, QQ IDs or credentials.
import { createHash } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { dirname } from 'node:path'

const PREFIX = 'qqai-synthetic-stickers-'
const TOOLS = new Set(['sticker_search', 'sticker_send', 'meme_render', 'sticker_manage'])
const READ_ACTIONS = new Set(['browse', 'info', 'templates', 'credit'])
const hash = value => createHash('sha256').update(value).digest('hex')
const sid = value => String(value || '').replace(/^session-/, '')
const synthetic = value => sid(value).startsWith(PREFIX) && /^[a-z0-9-]+$/u.test(sid(value))
const receipt = value => (typeof value === 'string' && /^-?[1-9]\d{0,29}$/u.test(value))
  || (Number.isSafeInteger(value) && value !== 0)
const jsonClone = value => JSON.parse(JSON.stringify(value))
const numericUsage = value => Object.fromEntries(Object.entries(value || {})
  .filter(([key, n]) => ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens',
    'prompt_tokens', 'completion_tokens', 'total_tokens'].includes(key) && Number.isFinite(n) && n >= 0))

export default {
  id: 'qqai-neko-probe', name: 'QQAI 临时表情验收', version: '0.1.0',
  async setup(api) {
    const [{ renderPrompt }, { privateStore }, { createReminderEngine }, { prepareReminderStickerSegments }] = await Promise.all([
      import('/opt/qqai-dsh/app/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'),
      // Aurabot copies the probe entry into .aurabot-cache/<stamp>/ before importing it.
      // Resolve the fixed installed helper root, not a sibling of that cached entry.
      import('/srv/qqai-dsh/home/.dsh/plugins-data/aurabot/modules/qqai-reminders/index.mjs'),
      import('/srv/qqai-dsh/home/.dsh/plugins-data/aurabot/modules/qqai-reminders/engine.mjs'),
      import('/srv/qqai-dsh/home/.dsh/plugins-data/aurabot/modules/qqai-reminders/stickers.mjs'),
    ])
    const file = api.dataDir('probe-state.json'); chmodSync(dirname(file), 0o700)
    const store = privateStore(file)
    let saved = store.load(), alive = true
    if (!Object.keys(saved).length) saved = { version: 1, startedAt: new Date().toISOString(),
      cases: {}, artifacts: { s: [], r: [] }, deniedTools: 0, observerErrors: 0,
      mediaTest: { attempted: false }, reminderTest: { attempted: false } }
    if (saved.version !== 1 || !saved.cases || !saved.artifacts) throw new Error('Invalid private probe record')
    const persist = () => store.save(saved)
    persist()
    const selected = agent => synthetic(agent?.session?.id) ? sid(agent.session.id) : null
    const row = id => saved.cases[id] ||= { requests: [], actualRequests: [], tools: [], usage: [], assistantMessages: 0,
      outputImages: 0, stockImages: 0, templateImages: 0, completed: false }
    const outputUrls = text => {
      const port = api.dsh.get('webServer')?.port
      return [...String(text || '').matchAll(/!\[[^\]\r\n]*\]\((http:\/\/127\.0\.0\.1:\d+\/x-nekowhale-stickers\/(s\/[a-f0-9]{12}|r\/[a-f0-9]{16})\.gif)\)/gu)]
        .filter(match => match[1].startsWith(`http://127.0.0.1:${port}/`)).map(match => match[1])
    }
    const guarded = fn => (...args) => { try { return fn(...args) } catch { saved.observerErrors++; try { persist() } catch {} } }
    const tools = api.dsh.get('tools'), systemPrompt = api.dsh.get('systemPrompt')
    // Monotonic guard remains effective even if another pre-execute listener allows a call.
    api.onDispose(tools.guard(exec => {
      if (!selected(exec.agent)) return
      if (!TOOLS.has(exec.name) || exec.name === 'sticker_manage' && !READ_ACTIONS.has(exec.arguments?.action)
        || exec.name === 'meme_render' && exec.arguments?.image) {
        saved.deniedTools++; persist()
        return 'Synthetic sticker acceptance may only use read-only sticker selection and text templates.'
      }
    }))
    api.onDispose(api.dsh.on('agent/created', guarded(({ agent }) => {
      const id = selected(agent); if (!id) return
      // Visibility restriction is scoped to this synthetic agent only.
      if (agent.ctx?.tools?.restrict) api.onDispose(agent.ctx.tools.restrict({ allow: [...TOOLS] }))
      row(id); persist()
    })))
    api.onDispose(api.dsh.on('agent/request', async ({ agent, turn, step, signal }, next) => {
      const config = await next(), id = selected(agent)
      if (id) {
        try {
          const assembled = await systemPrompt.assemble({ scope: agent, agent, signal })
          const rendered = renderPrompt(assembled), persona = assembled.variables?.aurabot_persona || ''
          const policy = api.use('qqai-compat')?.stickerPolicy?.() || ''
          const names = assembled.tools.map(tool => tool.name)
          row(id).requests.push({ turn, step, provider: config.provider === 'deepseek-official' ? config.provider : 'unexpected',
            model: config.model === 'deepseek-flash' ? config.model : 'unexpected',
            thinkingOff: config.reasoningEffort === 'off', policyInFinalSystem: Boolean(policy) && rendered.includes(policy),
            personaSha256: hash(persona), personaMatchesCurrent: persona === api.config().ext['qqai-compat'].personaText.trim(),
            tools: names.filter(name => TOOLS.has(name)), otherToolCount: names.filter(name => !TOOLS.has(name)).length,
            finalSystemCharacters: rendered.length })
          persist()
        } catch { saved.observerErrors++; persist() }
      }
      return config
    }))
    // This supported seam sees the request actually dispatched to the provider,
    // including preparedCall.stream(). The earlier agent/request observer above
    // independently reassembles a prompt and is not used as the wire-input proof.
    api.onDispose(api.dsh.on('llm/stream', (options, next) => {
      if (synthetic(options.sessionId)) {
        try {
          const r = row(sid(options.sessionId))
          r.actualRequests ||= []
          const systemMessages = (options.messages || []).filter(message => message.role === 'system')
          const textOf = message => typeof message.content === 'string' ? message.content
            : (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')
          const actualSystem = typeof options.system === 'string' && options.system
            ? options.system : systemMessages.length ? textOf(systemMessages.at(-1)) : ''
          const persona = api.config().ext['qqai-compat'].personaText.trim()
          const policy = api.use('qqai-compat')?.stickerPolicy?.() || ''
          const names = (options.tools || []).map(tool => tool.name)
          // agent-loop buildRequest freezes its request and derives an explicit
          // system/message; session title generation can share the sessionId but
          // sends a separate options.system request without this boundary.
          const primaryDialogue = Object.isFrozen(options) && systemMessages.length > 0
          r.actualRequests.push({ kind: primaryDialogue ? 'agent-dialogue' : 'auxiliary',
            provider: options.provider === 'deepseek-official' ? options.provider : 'unexpected',
            model: options.model === 'deepseek-flash' ? options.model : 'unexpected', thinkingOff: options.reasoningEffort === 'off',
            policyInActualSystem: Boolean(policy) && actualSystem.includes(policy),
            personaInActualSystem: Boolean(persona) && actualSystem.includes(persona), personaSha256: hash(persona),
            actualSystemSha256: hash(actualSystem), actualSystemCharacters: actualSystem.length,
            systemMessageCount: systemMessages.length, actualTools: names.filter(name => TOOLS.has(name)),
            otherActualToolCount: names.filter(name => !TOOLS.has(name)).length,
            frozenAgentRequest: Object.isFrozen(options) })
          persist()
        } catch { saved.observerErrors++; try { persist() } catch {} }
      }
      return next()
    }))
    api.onDispose(api.dsh.on('tools/result', guarded((exec, result) => {
      const id = selected(exec.agent); if (!id) return
      row(id).tools.push({ name: TOOLS.has(exec.name) ? exec.name : 'blocked-other', isError: Boolean(result.isError) })
      if (!result.isError && ['sticker_send', 'meme_render'].includes(exec.name)) {
        const text = result.value?.text || (result.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n')
        for (const url of outputUrls(text)) {
          const kind = url.includes('/s/') ? 's' : 'r'
          if (!saved.artifacts[kind].includes(url)) saved.artifacts[kind].push(url)
        }
      }
      persist()
    })))
    api.onDispose(api.dsh.on('session/event', guarded((session, event) => {
      if (!synthetic(session?.id)) return
      const r = row(sid(session.id))
      if (event.type === 'assistant/message') {
        const data = event.data || {}, content = data.message?.content || data.content || []
        const urls = outputUrls(Array.isArray(content) ? content.filter(x => x.type === 'text').map(x => x.text).join('\n') : '')
        r.assistantMessages++; r.outputImages += urls.length
        r.stockImages += urls.filter(url => url.includes('/s/')).length
        r.templateImages += urls.filter(url => url.includes('/r/')).length
        const usage = numericUsage(data.usage || data.message?.usage)
        if (Object.keys(usage).length) r.usage.push(usage)
      }
      if (event.type === 'turn/end') {
        r.completed = event.data?.reason?.kind === 'completed'
        r.terminal = ['completed', 'cancelled', 'error', 'failed'].includes(event.data?.reason?.kind)
          ? event.data.reason.kind : 'other'
      }
      if (['assistant/message', 'turn/end'].includes(event.type)) persist()
    })))

    async function ownerOnline() {
      const cfg = api.config()
      if (!alive || cfg.enabled !== true || cfg.dryRun !== false || api.core.onebot.state !== 'connected'
        || api.core.mutes.muted(`private:${cfg.ownerQQ}`)) return false
      const owner = String(cfg.ownerQQ), bot = String(cfg.botQQ)
      const info = await api.core.onebot.call('get_login_info', {}, { timeoutMs: 5000 })
      return alive && owner === String(api.config().ownerQQ) && bot === String(api.config().botQQ)
        && String(info?.user_id) === bot && api.config().enabled === true && api.config().dryRun === false
    }
    const qualifiedPost = req => req.method === 'POST'
      && req.headers?.['x-qqai-acceptance'] === 'neko-stickers-v1'
    const reminderStore = privateStore(api.dataDir('reminder-probe.json'))
    const reminderEngine = createReminderEngine({ ...reminderStore, leaseKey: api.dataDir('reminder-probe.json'),
      isAllowed: async task => String(task.owner) === String(api.config().ownerQQ) && await ownerOnline(),
      send: async task => {
        const compat = api.use('qqai-compat')
        const text = '主人，到提醒时间啦：' + task.text
        return compat.withStickerTurn(`reminder:acceptance:${task.id}:${task.dueAt}`, async () => {
          const llm = api.dsh.llm || api.dsh.get('llm')
          saved.reminderTest.modelRequests = []
          const observed = { stream: async function* (params) {
            const entry = { provider: params.provider === 'deepseek-official' ? params.provider : 'unexpected',
              model: params.model === 'deepseek-flash' ? params.model : 'unexpected',
              thinkingOff: params.reasoningEffort === 'off', outputCharacters: 0, usage: {} }
            saved.reminderTest.modelRequests.push(entry)
            try {
              for await (const chunk of llm.stream(params)) {
                if (chunk?.type === 'text-delta') entry.outputCharacters += String(chunk.text || '').length
                for (const usage of [chunk?.usage, chunk?.tokenUsage, chunk?.response?.usage]) {
                  Object.assign(entry.usage, numericUsage(usage))
                }
                yield chunk
              }
            } finally { persist() }
          } }
          const observedApi = { config: api.config, core: api.core, use: id => api.use(id),
            dsh: { llm: observed, get: key => key === 'llm' ? observed : api.dsh.get(key) } }
          const images = await prepareReminderStickerSegments(observedApi, compat, text)
          if (!(await ownerOnline())) return null
          saved.reminderTest.outboundAttempted = true; saved.reminderTest.images = images.length; persist()
          const result = await api.sendSegments(`private:${api.config().ownerQQ}`,
            [{ type: 'text', data: { text } }, ...images], '[合成表情提醒验收]')
          saved.reminderTest.receiptConfirmed = receipt(result?.message_id)
          saved.reminderTest.finishedAt = new Date().toISOString(); persist()
          return result
        })
      } })
    api.every(1000, () => reminderEngine.tick(), '临时合成提醒验收')
    api.route('/media-test', async req => {
      if (!qualifiedPost(req)) return { ok: false, reason: 'protected-post-required' }
      if (saved.mediaTest.attempted) return { ok: false, reason: 'already-attempted-no-retry', ...saved.mediaTest }
      if (!saved.artifacts.s.length || !saved.artifacts.r.length) return { ok: false, reason: 'real-model-artifacts-required' }
      const compat = api.use('qqai-compat')
      if (!compat || !(await ownerOnline())) return { ok: false, reason: 'owner-offline-or-adapter-unavailable' }
      if (saved.mediaTest.attempted) return { ok: false, reason: 'already-attempted-no-retry', ...saved.mediaTest }
      // Claim before all awaits: unknown transport outcomes must never trigger a second send.
      saved.mediaTest = { attempted: true, startedAt: new Date().toISOString() }; persist()
      try {
        const urls = [saved.artifacts.s[0], saved.artifacts.r[0]]
        // Exercise the real multi-bubble hub's turn propagation, parser, image hook and receipt aggregation.
        const result = await api.core.hub.deliver(`private:${api.config().ownerQQ}`,
          '表情接入验收：现成 GIF＋中文文字模板（自动测试）。|||'
            + `![现成表情](${urls[0]})|||![文字模板](${urls[1]})`,
          { own: true, stickerTurnKey: 'qq:qqai-synthetic-stickers-delivery:1' })
        saved.mediaTest.imagesRequested = 2
        saved.mediaTest.delivered = Number.isSafeInteger(result?.delivered) ? result.delivered : 0
        saved.mediaTest.failed = Number.isSafeInteger(result?.failed) ? result.failed : null
        saved.mediaTest.receiptConfirmed = result?.ok === true && result.delivered === 3
        saved.mediaTest.finishedAt = new Date().toISOString(); persist()
        return { ok: saved.mediaTest.receiptConfirmed, ...saved.mediaTest }
      } catch { saved.mediaTest.receiptConfirmed = false; saved.mediaTest.error = 'send-not-confirmed-no-retry'; persist(); return { ok: false, ...saved.mediaTest } }
    })
    api.route('/reminder-test', async req => {
      if (!qualifiedPost(req)) return { ok: false, reason: 'protected-post-required' }
      if (saved.reminderTest.attempted) return { ok: false, reason: 'already-created-no-retry', ...saved.reminderTest }
      if (!(await ownerOnline())) return { ok: false, reason: 'owner-offline' }
      if (saved.reminderTest.attempted) return { ok: false, reason: 'already-created-no-retry', ...saved.reminderTest }
      saved.reminderTest = { attempted: true, createdAt: new Date().toISOString() }; persist()
      const created = reminderEngine.create({ text: '专用提醒表情验收：用举牌写“今天也要开心”（自动测试，可忽略）', delayMinutes: 2 / 60 }, String(api.config().ownerQQ))
      saved.reminderTest.created = created.ok === true; persist()
      return { ok: created.ok === true, ...saved.reminderTest }
    })
    api.route('/state', req => req.method === 'GET' ? { ok: true, version: saved.version,
      startedAt: saved.startedAt, cases: jsonClone(saved.cases), deniedTools: saved.deniedTools,
      observerErrors: saved.observerErrors, artifactCounts: { stock: saved.artifacts.s.length, template: saved.artifacts.r.length },
      mediaTest: jsonClone(saved.mediaTest), reminderTest: jsonClone(saved.reminderTest), reminderEngine: reminderEngine.status() }
      : { ok: false, reason: 'read-only' })
    api.onDispose(() => { alive = false; reminderEngine.dispose() })
    return { syntheticPrefix: PREFIX, permanentFeature: false }
  },
}
