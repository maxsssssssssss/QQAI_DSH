// Bounded increases for the pinned Aurabot release; preserve the earlier stages.
export const MEMORY_LIMITS = Object.freeze({
  recallCount: 10,
  hintItems: 8,
  hintChars: 1600,
  chatLogChars: 2000,
})

export const MEMORY_LIMIT_PATCHES = [
  {
    package: 'dsh-aurabot-qq', version: '1.1.24', rootIndex: 0, file: 'src/chat/hub.js',
    before: '3c249d4683389f4d6dfafc54ec492d247e7188f573eba6468de02b9ba06750f9',
    after: 'aa6f08652dd1a7ebad7e04e0bf8041ad5b45492e9cac8b9f4b0c89b99e8341ab',
    needle: 'text: redact(String(text).slice(0, 500))',
    replacement: 'text: redact(String(text)).slice(0, 2000)',
  },
  {
    package: 'dsh-aurabot-qq', version: '1.1.24', rootIndex: 0, file: 'src/features/memory.js',
    before: 'cdca6f6956d191426d175254a859142cee5855f60debf4415eea6cc98cddcf52',
    after: 'cf165abe37d7a94ed581ece448f07f83447bd28598ea72aeb0dc1f2b0d22e2c2',
    edits: [
      {
        needle: `      // 太长就分段，每段最多 80 行
      const chunks = []
      for (let i = 0; i < talk.length; i += 80) chunks.push(talk.slice(i, i + 80))`,
        replacement: `      // QQAI_DSH: longer rows must not inflate one fact-extraction call without bound.
      // Keep all rows in order; an oversized legacy row is processed on its own.
      const chunks = []
      let chunk = []
      let chunkChars = 0
      for (const row of talk) {
        const chars = line(row).length
        if (chunk.length && (chunk.length >= 80 || chunkChars + 1 + chars > 40000)) {
          chunks.push(chunk)
          chunk = []
          chunkChars = 0
        }
        chunkChars += (chunk.length ? 1 : 0) + chars
        chunk.push(row)
      }
      if (chunk.length) chunks.push(chunk)`,
      },
      {
        needle: '不放进每轮都会追加的运行时上下文快照。最多 4 条、总长 ≤ 300 字。',
        replacement: '不放进每轮都会追加的运行时上下文快照。最多 8 条完整记忆、正文总长 ≤ 1600 字符。',
      },
      {
        needle: `    const hits = recall(q, { about, where: (chat && chat.chatId) || '', context: ctxText }).filter((h) => !shown.has(h.it.id)).slice(0, 4)
    if (!hits.length) return backdrop
    let body = hits.map((h) => memoryLine(h.it)).join('；')
    if (body.length > 300) body = body.slice(0, 300) + '…'`,
        replacement: `    const hits = recall(q, { about, where: (chat && chat.chatId) || '', context: ctxText }).filter((h) => !shown.has(h.it.id))
    // QQAI_DSH: keep complete facts; never truncate a correction or qualification.
    const selected = []
    let bodyChars = 0
    for (const hit of hits) {
      if (selected.length >= 8) break
      const line = memoryLine(hit.it)
      const addedChars = line.length + (selected.length ? 1 : 0)
      if (bodyChars + addedChars > 1600) continue
      selected.push(line)
      bodyChars += addedChars
    }
    if (!selected.length) return backdrop
    const body = selected.join('；')`,
      },
    ],
  },
]
