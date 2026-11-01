// Preserve the QQ turn identity through asynchronous multi-bubble delivery.
// Tool dispatch uses the same normalized session/turn key in qqai-compat.
export const STICKER_TURN_PATCHES = [{
  package: 'dsh-aurabot-qq', version: '1.1.24', rootIndex: 0, file: 'src/chat/hub.js',
  before: 'aa6f08652dd1a7ebad7e04e0bf8041ad5b45492e9cac8b9f4b0c89b99e8341ab',
  after: '43aa7dc54ad209673bccc09509277f06fa57ed14653bed3c5cf7d275aea5cddb',
  edits: [
    {
      needle: 'const captureStore = new AsyncLocalStorage()',
      replacement: `const captureStore = new AsyncLocalStorage()
// QQAI_DSH: capture the originating turn, never the chat's latest mutable turn.
const stickerTurnStore = new AsyncLocalStorage()`,
    },
    {
      needle: 'const next = await hooks.send(message, { chatId, note, force })',
      replacement: 'const next = await hooks.send(message, { chatId, note, force, stickerTurnKey: stickerTurnStore.getStore() })',
    },
    {
      needle: '  async function deliver(chatId, text, opts = {}) {\n    const cfg = getConfig()',
      replacement: `  async function deliver(chatId, text, opts = {}) {
    if (opts.stickerTurnKey && stickerTurnStore.getStore() !== opts.stickerTurnKey) {
      return stickerTurnStore.run(opts.stickerTurnKey, () => deliver(chatId, text, opts))
    }
    const cfg = getConfig()`,
    },
    {
      needle: "const next = await hooks.reply(text, { chatId, userText: opts.userText || '' })",
      replacement: "const next = await hooks.reply(text, { chatId, userText: opts.userText || '', stickerTurnKey: stickerTurnStore.getStore() })",
    },
    {
      needle: "const next = await hooks.items(items, { chatId, text, userText: opts.userText || '' })",
      replacement: "const next = await hooks.items(items, { chatId, text, userText: opts.userText || '', stickerTurnKey: stickerTurnStore.getStore() })",
    },
    {
      needle: "deliver(chatId, text, { wantVoice, autoReply, userText: st.lastText || '', own: true })",
      replacement: "deliver(chatId, text, { wantVoice, autoReply, userText: st.lastText || '', own: true, stickerTurnKey: 'qq:' + key + ':' + d.turn })",
    },
  ],
}]
