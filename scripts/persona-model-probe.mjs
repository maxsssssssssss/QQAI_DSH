// Temporary, one-shot real-model check of the live QQ persona hook.
// Synthetic conversation only. No QQ send, session write or production memory I/O.
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const digest = value => createHash('sha256').update(value).digest('hex')
export default {
  id: 'qqai-persona-probe', name: 'QQAI 临时人格验证', version: '0.1.0',
  async setup(api) {
    const file = api.dataDir('result.json')
    chmodSync(dirname(file), 0o700)
    if (existsSync(file)) return { alreadyAttempted: true }
    const result = { ok: false, pending: true, actualRequests: [],
      qqSendRequested: false, productionHistoryOrMemoryWritten: false,
      startedAt: new Date().toISOString() }
    const fd = openSync(file, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(result)); fsyncSync(fd) } finally { closeSync(fd) }
    try {
      const cfg = api.config()
      if (cfg.model.provider !== 'deepseek-official' || cfg.model.model !== 'deepseek-flash'
        || cfg.model.reasoningEffort !== 'off') throw new Error('Unexpected model')
      // Same live filter object/path used by host.js aurabot_persona variable.
      const persona = api.core.modules.filterSync('persona', api.core.personas.current())
      const expected = cfg.ext['qqai-compat'].personaText
      if (typeof persona !== 'string' || !persona.trim() || persona !== expected) {
        throw new Error('Active persona mismatch')
      }
      result.personaSha256 = digest(persona)
      result.livePersonaHookMatched = true
      const llm = api.dsh.llm || api.dsh.get('llm')
      const wrapped = new Proxy(llm, { get(target, key) {
        if (key === 'stream') return async function* (params) {
          if (result.actualRequests.length) throw new Error('One request only')
          const entry = { provider: params.provider, model: params.model, reasoningEffort: params.reasoningEffort,
            maxTokens: params.maxTokens, outputCharacters: 0 }
          if (entry.provider !== 'deepseek-official' || entry.model !== 'deepseek-flash'
            || entry.reasoningEffort !== 'off') throw new Error('Unexpected request route')
          result.actualRequests.push(entry)
          for await (const chunk of Reflect.apply(target.stream, target, [params])) {
            if (chunk.type === 'text-delta') entry.outputCharacters += String(chunk.text || '').length
            for (const usage of [chunk.usage, chunk.tokenUsage, chunk.response?.usage]) {
              if (!usage) continue
              for (const key of ['inputTokens', 'outputTokens', 'total_tokens', 'prompt_tokens', 'completion_tokens']) {
                if (Number.isFinite(usage[key])) (entry.usage ||= {})[key] = usage[key]
              }
            }
            yield chunk
          }
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      const dsh = { llm: wrapped, get: key => key === 'llm' ? wrapped : api.dsh.get(key) }
      const { askModel } = api.lib('core/llm.js')
      const response = await askModel(dsh, { cfg: { model: { ...cfg.model } }, system: persona,
        text: '我刚才有点忙，现在回来啦。先告诉我你的名字，再用两句话随便跟我聊聊。',
        maxTokens: 320, temperature: 0.4 })
      // Never persist generated prose or reasoning; these are bounded metadata checks.
      result.responseChecks = { hasXiaojingName: response.includes('小鲸'),
        usesOwnerAddress: response.includes('主人'), usesFirstPerson: /本小姐|本鲸鱼娘/.test(response),
        outputCharacters: response.length }
      result.ok = result.livePersonaHookMatched && result.actualRequests.length === 1
        && result.responseChecks.hasXiaojingName && result.responseChecks.usesOwnerAddress
        && result.responseChecks.usesFirstPerson
    } catch {
      result.error = 'persona-probe-failed-private-details-omitted'
    }
    result.pending = false
    result.finishedAt = new Date().toISOString()
    const tmp = file + '.complete.tmp'
    const out = openSync(tmp, 'wx', 0o600)
    try { writeFileSync(out, JSON.stringify(result, null, 2)); fsyncSync(out) } finally { closeSync(out) }
    renameSync(tmp, file)
    return { ok: result.ok }
  },
}
