// Reviewed delivery-result patch for the fixed Aurabot 1.1.24 source.
// Hub input is the existing QQAI GIF-only media patch output, not upstream raw.
// Integrators must compose these edits into that file's single final hash guard.
import { createHash } from 'node:crypto'

const hash = (text) => createHash('sha256').update(text).digest('hex')
const receiptCheck = "typeof r?.message_id === 'number' ? Number.isSafeInteger(r.message_id) : typeof r?.message_id === 'string' && r.message_id.trim().length > 0"

export const QQ_DELIVERY_PATCHES = [
  {
    package: 'dsh-aurabot-qq', version: '1.1.24', rootIndex: 0, file: 'src/chat/hub.js',
    before: '13792168e58b88e2acfa6e94520b06c526037ac42a42d7a95aadba6bc7d8392c',
    after: '3c249d4683389f4d6dfafc54ec492d247e7188f573eba6468de02b9ba06750f9',
    edits: [
      {
        needle: "      const r = await onebot.call(action, params)\n      if (r && r.message_id !== undefined) {",
        replacement: "      const r = await onebot.call(action, params)\n"
          + `      if (!(${receiptCheck})) throw new Error('QQAI: gateway returned no valid message_id; delivery is unconfirmed')\n`
          + "      if (r && r.message_id !== undefined) {",
      },
      {
        needle: "    const missedAt = [] // 写了 @ 却没对上群里人的名字\n    for (let i = 0; i < items.length; i++) {",
        replacement: "    const missedAt = [] // 写了 @ 却没对上群里人的名字\n"
          + "    const confirmed = []\n    let failed = 0\n    let unverified = 0\n"
          + "    for (let i = 0; i < items.length; i++) {",
      },
      {
        needle: `      if (it.kind === 'text') await sendText(chatId, it.value, replyId, missedAt, userId)
      else if (it.kind === 'voice') {
        if (cfg.voice.enabled) await sendVoice(chatId, it.value, replyId, userId)
        else await sendText(chatId, it.value, replyId, missedAt, userId)
      } else if (it.kind === 'sticker') await sendSticker(chatId, it.value, replyId, userId)
      else if (it.kind === 'poke') { if (!opts.simulate) await pokeBack(chatId) }
      else if (it.kind === 'image') await sendImage(chatId, it.value, replyId, userId)`,
        replacement: `      let r = null
      let expectsReceipt = false
      if (it.kind === 'text') { expectsReceipt = true; r = await sendText(chatId, it.value, replyId, missedAt, userId) }
      else if (it.kind === 'voice') {
        if (cfg.voice.enabled) await sendVoice(chatId, it.value, replyId, userId)
        else { expectsReceipt = true; r = await sendText(chatId, it.value, replyId, missedAt, userId) }
      } else if (it.kind === 'sticker') await sendSticker(chatId, it.value, replyId, userId)
      else if (it.kind === 'poke') { if (!opts.simulate) await pokeBack(chatId) }
      else if (it.kind === 'image') { expectsReceipt = true; r = await sendImage(chatId, it.value, replyId, userId) }
      if (expectsReceipt) {
        if (${receiptCheck}) confirmed.push(it)
        else failed++
      } else unverified++`,
      },
      {
        needle: "    if (opts.simulate) return items\n    if (inGroup) {",
        replacement: "    if (opts.simulate) return items\n"
          + "    const delivery = { ok: confirmed.length > 0 && failed === 0 && unverified === 0, delivered: confirmed.length, failed, unverified, missedAt }\n"
          + "    if (!confirmed.length) return delivery\n    if (inGroup) {",
      },
      {
        needle: "    const said = items.map((i) => (i.kind === 'text' || i.kind === 'voice' ? i.value : `[${i.kind}]`)).join(' ')",
        replacement: "    const said = confirmed.map((i) => (i.kind === 'text' || i.kind === 'voice' ? i.value : `[${i.kind}]`)).join(' ')",
      },
      {
        needle: "    if (chatId === `private:${cfg.ownerQQ}`) lastBotToOwner = { at: Date.now(), text: items.filter((i) => i.kind === 'text' || i.kind === 'voice').map((i) => i.value).join('\\n') }\n    onActivity?.({ kind: 'out', chatId, reply: text, userText: opts.userText || '' })\n    return { missedAt }",
        replacement: "    if (chatId === `private:${cfg.ownerQQ}`) lastBotToOwner = { at: Date.now(), text: confirmed.filter((i) => i.kind === 'text' || i.kind === 'voice').map((i) => i.value).join('\\n') }\n"
          + "    onActivity?.({ kind: 'out', chatId, reply: delivery.ok ? text : said, userText: opts.userText || '' })\n    return delivery",
      },
    ],
  },
  {
    package: 'dsh-aurabot-qq', version: '1.1.24', rootIndex: 0, file: 'src/modules/qq-tools/index.js',
    before: 'bfcae29f15c0737cb3be7664fa95fc4132108fbc486bf126302b09a19dd38bf0',
    after: '59a57d510fcb26f3a1a9a70c03c83adf5bf332181c6deaedce29a4441ca79502',
    edits: [
      {
        needle: "          return r?.missedAt?.length ? { ok: true, message: `发出去了，但 ${r.missedAt.map((n) => '@' + n).join('、')} 没对上群里的人（群名片和昵称里没有），只是文字、对方收不到提醒。要真 @ 得写 <at:QQ号>，不知道就问主人要他的群名片或 QQ 号` } : { ok: true, message: '发出去了' }",
        replacement: "          if (!r?.ok) return { ok: false, message: `投递未全部确认：网关接受 ${r?.delivered || 0} 条，失败 ${r?.failed || 0} 条，其他类型状态未验证 ${r?.unverified || 0} 条；不要自动重发，以免重复消息。` }\n"
          + "          return r.missedAt?.length ? { ok: true, message: `网关已接受 ${r.delivered} 条消息，但 ${r.missedAt.map((n) => '@' + n).join('、')} 未匹配到群成员，没有产生对应提醒。` } : { ok: true, message: `网关已接受 ${r.delivered} 条消息` }",
      },
    ],
  },
]

export function applyDeliveryEdits(source, spec) {
  let output = source
  for (const { needle, replacement } of spec.edits) {
    if (output.split(needle).length !== 2) throw new Error(`${spec.file}: delivery patch anchor is not unique`)
    output = output.replace(needle, replacement)
  }
  return output
}

export function patchedDeliverySource(raw, spec) {
  const source = String(raw).trimEnd() + '\n'
  const current = hash(source)
  if (current === spec.after) return source
  if (current !== spec.before) throw new Error(`${spec.file}: unreviewed delivery source hash ${current}`)
  const output = applyDeliveryEdits(source, spec)
  if (hash(output) !== spec.after) throw new Error(`${spec.file}: generated delivery patch hash mismatch`)
  return output
}
