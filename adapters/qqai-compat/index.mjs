// QQAI_DSH integration only. Aurabot still owns sessions, memory and delivery.
// Reviewed against Aurabot e9026a9 and Nekowhale b7b58c0; see docs/plugin-compatibility-audit.md.
import { createHash } from 'node:crypto'
import { constants, readFileSync } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { createStickerPolicy, qqStickerTurnKey, sessionKey, sharedStickerState, toolTurnTracker } from './sticker-policy.mjs'

export const PERSONA_SHA256 = '9969097250f89301d23dffabb3b3dd2a1614cf5e5e0500a389c10c11fa383d7b'
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const digest = (value) => createHash('sha256').update(value).digest('hex')
const inside = (root, path) => {
  const rel = relative(root, path)
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)
}

/** Read the pinned installed plugin, rather than copying an old project persona. */
export function whalePersona(raw, { botName = '大肥鱼', ownerName = '主人', personaText = '' } = {}) {
  const normalized = String(raw).trimEnd() + '\n'
  if (digest(normalized) !== PERSONA_SHA256) throw new Error('Whale persona source changed; review and pin it before loading')
  // An explicitly supplied project persona replaces the complete role text.
  // Keep the installed plugin pin check even when its default text is replaced.
  if (typeof personaText !== 'string' || personaText.length > 20000) throw new Error('Invalid custom whale persona')
  if (personaText.trim()) return personaText.trim()
  const lines = normalized.split('\n')
  const start = lines.indexOf('    persona: |-')
  if (start < 0) throw new Error('Pinned Whale persona field is missing')
  const body = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith('      ')) break
    body.push(line.slice(6))
  }
  // Small disclosed local adaptation: no age label, no demand to expose reasoning,
  // and resolve the old deployment placeholders without nested interpolation.
  const source = body.join('\n').trim()
    .replace('（萝莉）', '')
    .replaceAll('{{model}}', 'DeepSeek')
    .replaceAll('{{cwd}}', '专用会话工作区')
    .split('\n').filter((line) => !line.includes('思考过程（推理、思维链')).join('\n')
  const cleanName = (v) => String(v).replace(/[\r\n]/g, ' ').slice(0, 30)
  return source + '\n\n【当前会话身份】\n'
    + `你的名字是${cleanName(botName)}，称呼对方为${cleanName(ownerName)}。你知道自己是 AI 伙伴；鲸鱼娘动作、尾巴和生活场景是角色表达或想象，不是真实身体经历。`
    + '可以分享联想和虚拟设想，但不编造已经发生的现实生活、搜索或工具调用；工具结果如实说明。'
}

/** Only exact links produced by the installed Nekowhale Web plugin are eligible. */
export function stickerReference(value, port) {
  const source = String(value || '')
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  // Compare the raw URL too: reject parser-normalized traversal, credentials,
  // alternate loopback spellings, encoded path separators, query and fragment.
  const prefix = `http://127.0.0.1:${port}/x-nekowhale-stickers/`
  if (!source.startsWith(prefix)) return null
  const match = /^(s|r)\/([0-9a-f]{12,16})\.gif$/.exec(source.slice(prefix.length))
  if (!match || match[2].length !== (match[1] === 's' ? 12 : 16)) return null
  return { kind: match[1], id: match[2] }
}

/** Nekowhale's successful stock tool returns one Markdown line, then a footer. */
export function stockResultUrl(result, port) {
  const text = result.value?.text ?? result.content?.find(part => part?.type === 'text')?.text
  if (typeof text !== 'string') return ''
  const url = /^!\[[^\]\r\n]*\]\(([^\s)]+)\)(?:\r?\n|$)/.exec(text)?.[1]
  return stickerReference(url, port)?.kind === 's' ? url : ''
}

/** Keep candidate order. DSH renders the updated Neko value into the next model step. */
export function guideStockSearch(exec, result, scope) {
  if (!scope || exec.name !== 'sticker_search' || exec.callId !== exec.rootCallId || result?.isError !== false) return result
  const text = result.value?.text
  const name = typeof text === 'string' && /^([^｜\r\n]+)｜[^｜\r\n]*｜/u.exec(text)?.[1]
  if (!name) return result
  const example = JSON.stringify({ name })
  const hint = `挑到贴切的一张就用第一列的完整名称调用 sticker_send，例如 sticker_send(${example})。使用工具返回的图片行，不要用名称拼地址。`
  return { ...result, value: { ...result.value, text: text + '\n' + hint } }
}

/** Resolve only known library files, with realpath containment and bounded reads. */
export async function approvedGif(ref, { kit, dataDir }) {
  if (!isAbsolute(dataDir || '')) throw new Error('An absolute sticker data directory is required')
  const root = await realpath(dataDir)
  const path = ref.kind === 's' ? await kit.fileByHash(ref.id) : kit.renderPath(ref.id)
  if (!path || !isAbsolute(path)) throw new Error('Sticker file was not found')
  const actual = await realpath(path)
  const allowed = ['packs', 'byhash', 'renders'].some((dir) => inside(resolve(root, dir), actual))
  if (!allowed || !inside(root, actual)) throw new Error('Sticker file is outside its data directory')
  const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 13 || stat.size > MAX_IMAGE_BYTES) throw new Error('Invalid sticker size or file type')
    // Bounded read even if an unexpected writer grows the file during this operation.
    const bytes = Buffer.alloc(stat.size + 1)
    let read = 0
    while (read < bytes.length) {
      const got = await handle.read(bytes, read, bytes.length - read, read)
      if (!got.bytesRead) break
      read += got.bytesRead
    }
    if (read !== stat.size) throw new Error('Sticker changed while being read')
    const data = bytes.subarray(0, read)
    if (!['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) throw new Error('Not a GIF')
    return data
  } finally { await handle.close() }
}

/** These callbacks never throw: upstream ignores hook exceptions and would fail open. */
export function mediaHooks({ getPort, getKit, getDataDir, getOwner, policy = createStickerPolicy({ getKit }), takeStock = () => [], warn = () => {} }) {
  const approved = new Map()
  const notify = () => { try { warn('QQAI media adapter rejected an unapproved image') } catch {} }
  const prune = () => {
    for (const [key, entry] of approved) if (Date.now() - entry.at > 120_000) approved.delete(key)
  }
  return {
    async items(items, info) {
      try {
        if (info?.chatId !== `private:${getOwner()}`) return null
        const out = [], scope = policy.scope(info)
        if (info.stickerFinal === true && scope?.startsWith('qq:')) {
          const explicit = new Set(items.filter(i => i.kind === 'image').map(i => i.value))
          const missing = takeStock(scope).filter(url => !explicit.has(url))
          items = [...items, ...missing.map(value => ({ kind: 'image', value }))]
        }
        prune()
        for (const item of items) {
          if (item.kind !== 'image') { out.push(item); continue }
          const ref = stickerReference(item.value, getPort())
          if (!ref) { notify(); continue }
          try {
            if (!scope || !await policy.referenceAllowed(ref)) { notify(); continue }
            const bytes = await approvedGif(ref, { kit: getKit(), dataDir: getDataDir() })
            if (ref.kind === 'r' && digest(bytes).slice(0, 16) !== ref.id) { notify(); continue }
            if (!policy.reserve(scope, bytes)) continue
            const value = 'base64://' + bytes.toString('base64')
            const key = scope + '|' + digest(value)
            approved.set(key, { at: Date.now(), chatId: info.chatId })
            out.push({ ...item, value })
          } catch { notify() }
        }
        return out.length ? out : null
      } catch { notify(); return null }
    },
    send(message, info) {
      try {
        if (info?.chatId !== `private:${getOwner()}` || !Array.isArray(message)) return null
        prune()
        const out = [], consume = new Set(), scope = policy.scope(info)
        for (const segment of message) {
          // The initial deployment has no voice/file/video generation capability.
          if (!['text', 'face', 'reply', 'at', 'image'].includes(segment?.type)) return null
          if (segment.type !== 'image') { out.push(segment); continue }
          const key = scope + '|' + digest(String(segment.data?.file || ''))
          const token = approved.get(key)
          if (!scope || !token || token.chatId !== info.chatId || consume.has(key)) { notify(); return null }
          consume.add(key)
          // Original animated GIF bytes are preserved; OneBot uses the normal image path.
          // sub_type is opt-in only after the actual gateway has been verified.
          out.push(segment)
        }
        for (const key of consume) approved.delete(key)
        return out.length ? out : null
      } catch { notify(); return null }
    },
  }
}

// One receipt event represents the entire delivery, including all QQ bubbles.
// Only a count and recent opaque turn keys survive module reloads.
export function ownerStickerCadence(api, policy, state) {
  function enabled(chatId) {
    const cfg = api.config()
    const owner = cfg.ownerQQ && 'private:' + cfg.ownerQQ
    if (state.owner !== owner) Object.assign(state, { owner, plain: 0, session: '', seen: new Map() })
    return owner && chatId === owner && cfg.enabled && !cfg.dryRun && api.settings().stickerUsage === 'often'
  }
  function mark(key, status) {
    state.seen.set(key, status)
    if (state.seen.size > 64) state.seen.delete(state.seen.keys().next().value)
  }
  api.on('activity', event => {
    const receipt = event?.stickerReceipt
    if (event?.kind !== 'out' || !receipt || !enabled(event.chatId)) return
    const key = policy.scope({ stickerTurnKey: receipt.key })
    if (receipt.image) {
      if (key && state.seen.get(key) === 'image') return
      state.plain = 0
      state.session = ''
    } else {
      if (!receipt.final || !receipt.textOnly || !key.startsWith('qq:')) return
      const prior = state.seen.get(key)
      if (prior === 'text' || prior === 'image') return
      state.plain = prior === 'hint' ? 1 : Math.min(state.plain + 1, 3)
    }
    if (key) mark(key, receipt.image ? 'image' : 'text')
  })
  api.on('prompt', (content, { chat, sessionId, senderId, steer }) => {
    if (!steer && enabled(chat?.chatId) && chat.kind === 'private') {
      const ownerInput = String(senderId) === String(api.config().ownerQQ)
      state.session = ownerInput && state.plain === 3 ? sessionKey(sessionId) : ''
    }
    return content
  })
  api.context?.(({ chat, sessionId }) => {
    if (!enabled(chat?.chatId) || !state.session || state.session !== sessionKey(sessionId)) return ''
    return '最近几轮都是文字。如果这句适合用大肥鱼 GIF 表达你的反应，可以先用 sticker_search 找找；没有贴切的就照常回文字。'
  })
  return (session, event) => {
    if (event?.type !== 'turn/end' || !state.session || state.session !== sessionKey(session?.id)) return
    const key = qqStickerTurnKey(state.session, event.data?.turn)
    if (event.data?.reason?.kind === 'completed' && key && !state.seen.has(key)) mark(key, 'hint')
    state.session = ''
  }
}

export default {
  id: 'qqai-compat',
  name: 'QQAI 三插件兼容适配',
  version: '0.2.2',
  description: '鲸鱼娘人格来源接入与 Nekowhale 受控 GIF 传递；不改变原生聊天、记忆或调度',
  defaults: { personaSourcePath: '', stickersDataDir: '', botName: '大肥鱼', ownerName: '主人', personaText: '', stickerUsage: 'off' },
  settings: [{ key: 'stickerUsage', label: '表情使用积极程度', type: 'select',
    options: [{ value: 'off', label: '关闭主动配图（仍可点名）' }, { value: 'rare', label: '偶尔' },
      { value: 'normal', label: '正常' }, { value: 'often', label: '积极' }],
    hint: '由模型按语境选择，整轮最多 2 张；普通聊天、主动聊天、文章分享、追问和提醒共用此设置。' }],
  setup(api) {
    const settings = api.settings()
    if (!isAbsolute(settings.personaSourcePath) || !isAbsolute(settings.stickersDataDir)) {
      api.setConfig({ enabled: false, dryRun: true })
      throw new Error('Configure absolute personaSourcePath and stickersDataDir before enabling QQ')
    }
    let persona
    try { persona = whalePersona(readFileSync(settings.personaSourcePath, 'utf8'), settings) }
    catch (error) { api.setConfig({ enabled: false, dryRun: true }); throw error }
    const runtime = sharedStickerState(settings.stickersDataDir)
    const policy = createStickerPolicy({ getKit: () => api.dsh.get('stickers'),
      getUsage: () => api.settings().stickerUsage, state: runtime })
    const endCadence = ownerStickerCadence(api, policy, runtime.cadence ||= {})
    const turns = toolTurnTracker({ getOwner: () => String(api.config().ownerQQ || ''),
      stockUrl: result => stockResultUrl(result, api.dsh.get('webServer')?.port),
      chatOfSession: id => api.core.hub.chatOfSession(id), state: runtime.calls })
    const media = mediaHooks({
      getPort: () => api.dsh.get('webServer')?.port,
      getKit: () => api.dsh.get('stickers'),
      getDataDir: () => api.settings().stickersDataDir,
      getOwner: () => String(api.config().ownerQQ || ''),
      takeStock: turns.takeStock,
      policy,
      warn: (message) => api.log.warn(message),
    })
    api.on('persona', () => persona)
    api.route('/persona-state', () => ({ ok: true, personaSha256: digest(persona),
      personaCharacters: persona.length, customPersona: Boolean(settings.personaText?.trim()),
      personaSourceSha256: PERSONA_SHA256 }))
    api.route('/sticker-state', () => ({ ok: true, ...policy.state(), rulesSha256: digest(policy.rules()) }))
    api.on('rules', (text) => String(text) + '\n【表情与工具】\n'
      + '- ' + policy.rules()
      + '\n- 没有 Shell 或宿主文件系统操作权限。头像图片模板暂不开放。搜索、Fetch 的结果必须如实说明。'
      + '\n- 你知道自己是 AI；可以分享虚拟设想，不将想象描述成已发生的现实经历。')
    api.on('reply/items', media.items)
    api.on('send', media.send)
    // DSH rc.5 waterfall signature also used by Aurabot security/danger.js.
    // The upstream meme_render image argument can read any local image file.
    const off = api.dsh.on('tools/pre-execute', async (exec, next) => {
      if (exec?.name === 'meme_render' && exec.arguments?.image) {
        return { kind: 'deny', reason: 'Only template and text are enabled; local files and remote avatar URLs are unavailable.' }
      }
      if (exec?.name === 'meme_render') {
        try { await policy.template(exec.arguments?.template, exec.arguments?.text) }
        catch { return { kind: 'deny', reason: 'Only the five 大肥鱼 text templates with bounded text are enabled.' } }
      }
      return next()
    })
    api.onDispose(off)
    api.onDispose(api.dsh.on('session/event', (session, event) => {
      turns.observe(session, event)
      endCadence(session, event)
    }))
    api.onDispose(api.dsh.on('tools/result', turns.result))
    api.onDispose(api.dsh.on('tools/execute', async (exec, next) => {
      const run = async () => {
        const template = exec.name === 'meme_render' ? await policy.template(exec.arguments?.template, exec.arguments?.text) : null
        const result = await next()
        if (template && !result?.isError) {
          for (const part of result?.content || []) {
            if (part?.type !== 'text' || typeof part.text !== 'string') continue
            for (const match of part.text.matchAll(/!\[[^\]\r\n]*\]\(([^\s)]+)\)/g)) {
              const ref = stickerReference(match[1], api.dsh.get('webServer')?.port)
              if (ref?.kind === 'r') policy.approveRender(ref.id, template)
            }
          }
        }
        return guideStockSearch(exec, result, scope)
      }
      const scope = turns.scope(exec)
      return scope ? policy.withTurn(scope, run) : run()
    }))
    return { personaSourceSha256: PERSONA_SHA256, mediaPolicy: 'nekowhale-single-whale-two-per-turn',
      stickerPolicy: () => api.settings().stickerUsage === 'off' ? '' : policy.rules(),
      withStickerTurn: (scope, fn) => policy.withTurn(scope, fn),
      prepareStickerItems: media.items,
      renderTextSticker: (template, text) => policy.renderTextSticker(template, text) }
  },
}
