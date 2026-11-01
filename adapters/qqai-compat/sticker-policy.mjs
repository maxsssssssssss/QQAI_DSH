import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'

export const STICKER_PACK = '大肥鱼'
export const MAX_IMAGES_PER_TURN = 2
export const TEXT_TEMPLATES = Object.freeze({ couplet_top: 12, couplet_bottom: 12, think: 20, scroll: 60, sign: 40 })
const sha = value => createHash('sha256').update(value).digest('hex')
const sessionKey = value => String(value || '').replace(/^session-/, '')
export const qqStickerTurnKey = (session, turn) => {
  const id = sessionKey(session)
  return /^[\w-]{1,160}$/.test(id) && Number.isSafeInteger(turn) && turn >= 0 ? `qq:${id}:${turn}` : ''
}
const validScope = value => typeof value === 'string' &&
  (/^qq:[\w-]{1,160}:\d+$/.test(value) || /^reminder:[\w:.-]{1,180}$/.test(value))

export function stickerRules(usage) {
  const hint = {
    off: '', rare: '只在特别合适时偶尔主动配图。',
    normal: '闲聊、调侃、庆祝或安慰时，语境合适就主动选现成表情表达情绪，不必等主人索要；不合适可不发，不要求每轮发。',
    often: '闲聊中较积极地配图，大约每两三轮一次，仍按语境决定。',
  }[usage] ?? ''
  return '只用大肥鱼单人表情，这是你自己的表情，可用于表达自己的反应；主人明确指定时优先照办。' + hint
    + '先 sticker_search 再 sticker_send，优先现成 GIF；仅主人指定配字或当下特定短句、共同梗才用 meme_render 纯文字模板（想、举牌、葱卷、上联、下联），不因没搜到图就做模板，不把普通回复重复制图。'
    + '整轮最多2张（包括工具发送和多个气泡）；工具返回的 Markdown 图片行是 QQ 纯文字规则的例外，原样放入回复，不预告、不编造链接。'
}

// State is retained across adapter hot reloads in the same DSH process. It never
// contains dialogue or credentials, and is not written to the conversation DB.
const RUNTIME = Symbol.for('qqai.nekowhale-turn-policy.v1')
export function sharedStickerState(key) {
  const all = globalThis[RUNTIME] ||= new Map()
  if (!all.has(key)) all.set(key, { scopes: new Map(), renders: new Map(), calls: new Map() })
  return all.get(key)
}

/** A tool call is durably announced before dispatch; rootCallId also covers nested calls. */
export function toolTurnTracker({ getOwner, chatOfSession, state = new Map() }) {
  const ownerSession = sid => chatOfSession(sid) === `private:${getOwner()}`
  return {
    observe(session, event) {
      try {
        const sid = sessionKey(session?.id), d = event?.data
        if (event?.type !== 'tool/call' || !ownerSession(sid) || typeof d?.callId !== 'string') return
        const scope = qqStickerTurnKey(sid, d.turn)
        if (!scope) return
        state.set(`${sid}|${d.callId}`, scope)
        if (state.size > 4096) state.delete(state.keys().next().value)
      } catch {}
    },
    scope(exec) {
      try {
        const sid = sessionKey(exec?.agent?.session?.id)
        if (!ownerSession(sid)) return ''
        return state.get(`${sid}|${exec.rootCallId || exec.callId}`) || ''
      } catch { return '' }
    },
  }
}

export function createStickerPolicy({ getKit, getUsage = () => 'off', state = { scopes: new Map(), renders: new Map() }, now = Date.now }) {
  const context = new AsyncLocalStorage()
  const knownTemplate = t => t?.pack === STICKER_PACK && t?.input === 'text' && Object.hasOwn(TEXT_TEMPLATES, t.key)
  async function template(ref, text) {
    if (typeof ref !== 'string' || !ref.trim()) throw new Error('A known whale text template is required')
    const t = await getKit().resolveTemplate(ref)
    if (!knownTemplate(t)) throw new Error('Only the five whale text templates are enabled')
    if (typeof text !== 'string' || !text.trim()
      || [...text.trim()].length > TEXT_TEMPLATES[t.key]) throw new Error('Template text is empty or too long')
    return t
  }
  const scope = info => {
    const key = info?.stickerTurnKey || context.getStore()
    return validScope(key) ? key : ''
  }
  return {
    scope,
    withTurn(key, fn) {
      if (!validScope(key) || typeof fn !== 'function') throw new Error('Invalid sticker turn scope')
      return context.run(key, fn)
    },
    rules: () => stickerRules(getUsage()),
    state: () => ({ usage: getUsage(), maxImagesPerTurn: MAX_IMAGES_PER_TURN,
      allowedPack: STICKER_PACK, allowedTemplateKeys: Object.keys(TEXT_TEMPLATES) }),
    template,
    async referenceAllowed(ref) {
      if (ref.kind === 's') {
        const list = await getKit().all()
        return list.some(s => s.pack === STICKER_PACK && s.hash === ref.id)
      }
      return ref.kind === 'r' && state.renders.has(ref.id)
    },
    /** A successful allowlisted meme_render result can authorize its returned render ID. */
    approveRender(id, t) {
      if (!/^[a-f0-9]{16}$/.test(id) || !knownTemplate(t)) throw new Error('Invalid rendered whale template')
      state.renders.set(id, { key: t.key, at: now() })
      if (state.renders.size > 2048) state.renders.delete(state.renders.keys().next().value)
    },
    async renderTextSticker(ref, text) {
      const t = await template(ref, text)
      const r = await getKit().render(`${STICKER_PACK}:${t.key}`, { text: text.trim() })
      if (!knownTemplate(r.template) || r.template.key !== t.key || !Buffer.isBuffer(r.data)
        || sha(r.data).slice(0, 16) !== r.id) throw new Error('Rendered template provenance mismatch')
      this.approveRender(r.id, r.template)
      return r
    },
    /** Reserve synchronously before sending. Uncertain/failed sends never refund a slot. */
    reserve(key, bytes) {
      if (!validScope(key)) return false
      let budget = state.scopes.get(key)
      if (!budget) {
        budget = { hashes: new Set(), at: now() }
        state.scopes.set(key, budget)
      }
      const hash = sha(bytes)
      if (budget.hashes.has(hash) || budget.hashes.size >= MAX_IMAGES_PER_TURN) return false
      budget.hashes.add(hash)
      // No active scope is discarded to make room. New scopes fail closed if full.
      if (state.scopes.size > 4096) {
        for (const [k, v] of state.scopes) if (k !== key && now() - v.at > 24 * 3600_000) state.scopes.delete(k)
        if (state.scopes.size > 4096) { state.scopes.delete(key); return false }
      }
      return true
    },
  }
}
