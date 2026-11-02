// Run against stopped, pinned installed packages. Refuse every unknown source hash.
import { createHash } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { QQ_DELIVERY_PATCHES } from './qq-delivery-patch-spec.mjs'
import { MEMORY_LIMIT_PATCHES } from './memory-limits-patch-spec.mjs'
import { PROACTIVE_LIMIT_PATCHES } from './proactive-limits-patch-spec.mjs'
import { NEKO_NETWORK_PATCHES } from './neko-network-patch-spec.mjs'
import { STICKER_TURN_PATCHES } from './sticker-turn-patch-spec.mjs'

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
// Preserve the previously deployed GIF-only hash as an explicit migration stage.
export const GIF_MEDIA_PATCH = {
    package: 'dsh-aurabot-qq', version: '1.1.24', rootIndex: 0, file: 'src/chat/hub.js',
    before: '63d8df994316a6286428ad53cfc530015c340c57cfb9c556fc08c2576a714caf',
    after: '13792168e58b88e2acfa6e94520b06c526037ac42a42d7a95aadba6bc7d8392c',
    needle: '      const buf = await fetchImage(src, { maxBytes: 10 * 1024 * 1024 })',
    replacement: String.raw`      // QQAI_DSH: only verified adapter bytes; never resolve model-supplied paths or URLs.
      const encoded = String(src || '')
      if (!/^base64:\/\/[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 14 * 1024 * 1024) throw new Error('QQAI: unapproved image source')
      const buf = Buffer.from(encoded.slice(9), 'base64')
      if (buf.length < 13 || buf.length > 10 * 1024 * 1024 || !['GIF87a', 'GIF89a'].includes(buf.subarray(0, 6).toString('ascii'))) throw new Error('QQAI: invalid GIF')`,
  }

export const MEMORY_CONSOLIDATION_PATCH = {
    package: 'dsh-aurabot-qq', version: '1.1.24', rootIndex: 0, file: 'src/features/memory.js',
    before: 'a024527ee4ac97ef1fbb5b978f421d1e2f4a14f33076347a538b3aa569a515d1',
    after: 'cdca6f6956d191426d175254a859142cee5855f60debf4415eea6cc98cddcf52',
    edits: [
      {
        needle: "return { ok: false, message: '内容太少', added: 0, insights: 0 }",
        replacement: "return { ok: false, reason: 'insufficient', message: '内容太少', added: 0, insights: 0 }",
      },
      {
        needle: 'for (const part of chunks.slice(-3)) n += await extractFacts',
        replacement: 'for (const part of chunks) n += await extractFacts',
      },
      {
        needle: '    const arr = m ? JSON.parse(m[0]) : []',
        replacement: `    // QQAI_DSH: an actual empty JSON array is successful; missing/invalid output is retryable.
    if (!m) throw new Error('Memory extraction returned no JSON array')
    const arr = JSON.parse(m[0])
    if (!Array.isArray(arr) || arr.some((x) => !x || typeof x !== 'object' || typeof x.text !== 'string' || !x.text.trim())) throw new Error('Memory extraction returned an invalid result')`,
      },
      {
        needle: `      for (const day of hub.chatLogDays()) {
        if (day > today || (day === today && !o.includeToday)) continue
        // 同一天整理过一部分的（比如下午那次），只处理之后新增的聊天
        const done = (load().processed || {})[day] || 0
        const all = hub.chatLogOf(day)
        const byChat = new Map()
        for (const l of all.slice(done)) {
          if (String(l.chatId).startsWith('system:')) continue
          if (!byChat.has(l.chatId)) byChat.set(l.chatId, [])
          byChat.get(l.chatId).push(l)
        }
        for (const [chatId, lines] of byChat) {
          const r = await extractLines(chatId, lines)
          added += r.added || 0
          insights += r.insights ? 1 : 0
        }
        const s = load()
        s.processed = s.processed || {}
        if (day < today) {
          hub.deleteChatLog(day) // 整理完清空（今天的留着，写日记还要用）
          delete s.processed[day]
        } else {
          s.processed[day] = all.length
        }
        save(s)
        days++
      }`,
        replacement: `      // QQAI_DSH: snapshot unread rows and combine sparse conversations across days.
      // A successful chat advances only its own cursor; failed/short batches retain
      // their original log rows and cursor. The old global cursor remains readable.
      const snapshots = new Map()
      const byChat = new Map()
      const initial = load()
      for (const day of [...hub.chatLogDays()].sort()) {
        if (day > today || (day === today && !o.includeToday)) continue
        const all = hub.chatLogOf(day)
        snapshots.set(day, all.slice())
        const done = (initial.processed || {})[day] || 0
        const perChat = (initial.processedByChat || {})[day] || {}
        for (let i = done; i < all.length; i++) {
          const l = all[i]
          const chatId = String(l.chatId)
          if (chatId.startsWith('system:') || i < (perChat[chatId] || 0)) continue
          if (!byChat.has(chatId)) byChat.set(chatId, [])
          byChat.get(chatId).push({ day, index: i, line: l })
        }
      }
      for (const [chatId, entries] of byChat) {
        const r = await extractLines(chatId, entries.map((entry) => entry.line))
        if (!r.ok) {
          pending++
          if (r.reason !== 'insufficient') failed++
          continue
        }
        added += r.added || 0
        insights += r.insights ? 1 : 0
        const s = load()
        s.processedByChat = s.processedByChat || {}
        for (const entry of entries) {
          const cursors = s.processedByChat[entry.day] ||= {}
          cursors[chatId] = Math.max(cursors[chatId] || 0, entry.index + 1)
        }
        save(s)
      }
      for (const [day, snapshot] of snapshots) {
        const s = load()
        s.processed = s.processed || {}
        s.processedByChat = s.processedByChat || {}
        const cursors = s.processedByChat[day] || {}
        let done = s.processed[day] || 0
        while (done < snapshot.length) {
          const chatId = String(snapshot[done].chatId)
          if (!chatId.startsWith('system:') && done >= (cursors[chatId] || 0)) break
          done++
        }
        // Do not delete rows that arrived while the asynchronous model was running.
        const complete = done === snapshot.length && hub.chatLogOf(day).length === snapshot.length
        if (day < today && complete) {
          hub.deleteChatLog(day)
          delete s.processed[day]
          delete s.processedByChat[day]
        } else {
          if (done > (s.processed[day] || 0)) s.processed[day] = done
          if (done === snapshot.length) delete s.processedByChat[day]
        }
        save(s)
        days++
      }`,
      },
      {
        needle: '    let profiles = 0\n    try {',
        replacement: '    let profiles = 0\n    let pending = 0\n    let failed = 0\n    try {',
      },
      {
        needle: '      s.lastConsolidate = { day: today, at: Date.now(), added, insights, days, forgot, profiles }',
        replacement: '      s.lastConsolidate = { day: today, at: Date.now(), added, insights, days, forgot, profiles, pending, failed }',
      },
      {
        needle: '      return { ok: true, added, insights, days, forgot, profiles, message:',
        replacement: `      if (failed) return { ok: false, added, insights, days, forgot, profiles, pending, failed, message: '部分记忆提炼失败；原始聊天流水和未完成游标已保留，将重试。' }
      return { ok: true, added, insights, days, forgot, profiles, pending, failed, message:`,
      },
      {
        needle: '      for (const day of hub.chatLogDays?.() || []) if (day < cutoff) hub.deleteChatLog(day)',
        replacement: `      // QQAI_DSH: the fallback retention job must not discard unprocessed rows.
      // This only cleans fully consumed log files; long-term memory forgetting is unchanged.
      const s = load()
      for (const day of hub.chatLogDays?.() || []) {
        if (day >= cutoff) continue
        const done = (s.processed || {})[day] || 0
        const cursors = (s.processedByChat || {})[day] || {}
        const consumed = hub.chatLogOf(day).every((line, i) =>
          String(line.chatId).startsWith('system:') || i < done || i < (cursors[String(line.chatId)] || 0))
        if (!consumed) continue
        hub.deleteChatLog(day)
        if (s.processed) delete s.processed[day]
        if (s.processedByChat) delete s.processedByChat[day]
        save(s)
      }`,
      },
    ],
  }

export const PATCHES = [
  {
    ...GIF_MEDIA_PATCH,
    after: STICKER_TURN_PATCHES.at(-1).after,
    stages: [GIF_MEDIA_PATCH, QQ_DELIVERY_PATCHES[0], MEMORY_LIMIT_PATCHES[0], ...STICKER_TURN_PATCHES],
  },
  {
    package: 'dsh-nekowhale-stickers', version: '1.1.1', rootIndex: 1, file: 'lib/core/image-input.js',
    before: 'fccad94722d5e2e10904633a752f7b7418a0184f64d6b1fc22678775d5e235d8',
    after: 'ffa783ad1d41c602678d4bfb4468133c4a952dff5cd21a21ae6556c32c4fa25d',
    needle: 'export async function loadImageInput(src, opts = {}) {',
    replacement: `export async function loadImageInput(src, opts = {}) {
    // QQAI_DSH: text templates only; no arbitrary local files or remote avatar URLs.
    throw new Error('QQAI: avatar image input is disabled; use a text template');`,
  },
  {
    package: 'dsh-aurabot-qq', version: '1.1.24', rootIndex: 0, file: 'src/features/companion.js',
    before: '6f515141959f0aae8697df8601e35c8fcf32e94be6dece64d487ad526c169400',
    after: '1aa6989025cca29b2050d06dcdfb34057141783c3f7bb946888528d1a952b5ea',
    needle: "    '分享一件你今天（编也行，符合你的人设）遇到的小事或想到的东西',",
    replacement: "    '分享你此刻想到的联想、点子或明确标为想象的鲸鱼娘小场景；不要编造已经发生的现实生活或工具经历',",
  },
  {
    package: 'dsh-aurabot-qq', version: '1.1.24', rootIndex: 0, file: 'src/core/llm.js',
    before: '6f9b89396e08a23d2adfa65e2de50349cbb5ac12f5b67fae1e291e32cbbf66a6',
    after: '5a34b943fc03bf0162fc3c2f795a150d10c2bf2597dea3253c266717bf10724e',
    needle: "o.reasoningEffort === undefined ? 'low' : o.reasoningEffort",
    replacement: "o.reasoningEffort === undefined ? (o.cfg?.model?.reasoningEffort ?? 'off') : o.reasoningEffort",
  },
  {
    ...MEMORY_CONSOLIDATION_PATCH,
    after: MEMORY_LIMIT_PATCHES[1].after,
    stages: [MEMORY_CONSOLIDATION_PATCH, MEMORY_LIMIT_PATCHES[1]],
  },
  QQ_DELIVERY_PATCHES[1],
  ...PROACTIVE_LIMIT_PATCHES,
  ...NEKO_NETWORK_PATCHES,
]

export function patchedSource(raw, spec) {
  const source = String(raw).trimEnd() + '\n'
  const current = sha256(source)
  if (current === spec.after) return source
  if (spec.stages) {
    // Only a reviewed stage boundary is an eligible upgrade input. Each stage
    // retains its complete source/output hash validation; arbitrary partial
    // edits cannot be interpreted as an already-installed migration.
    const start = spec.stages.findIndex((stage) => stage.before === current)
    if (start < 0) throw new Error(`${spec.package}: unreviewed source hash ${current}`)
    let output = source
    for (const stage of spec.stages.slice(start)) output = patchedSource(output, stage)
    if (sha256(output) !== spec.after) throw new Error(`${spec.package}: generated patch hash mismatch`)
    return output
  }
  if (current !== spec.before) throw new Error(`${spec.package}: unreviewed source hash ${current}`)
  let output = source
  for (const edit of spec.edits || [spec]) {
    if (output.split(edit.needle).length !== 2) throw new Error(`${spec.package}: patch anchor is not unique`)
    output = output.replace(edit.needle, edit.replacement)
  }
  if (sha256(output) !== spec.after) throw new Error(`${spec.package}: generated patch hash mismatch`)
  return output
}

export async function patchPackages(roots, { check = false } = {}) {
  // Validate both packages before mutating either one.
  const paths = PATCHES.map((spec) => resolve(roots[spec.rootIndex], spec.file))
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate patch destination; compose stages into one specification')
  const prepared = await Promise.all(PATCHES.map(async (spec) => {
    const root = resolve(roots[spec.rootIndex])
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    if (pkg.name !== spec.package || pkg.version !== spec.version) throw new Error(`${spec.package}: installed version mismatch`)
    const path = join(root, spec.file)
    const raw = await readFile(path, 'utf8')
    const output = patchedSource(raw, spec)
    const alreadyPatched = sha256(raw.trimEnd() + '\n') === spec.after
    if (check && !alreadyPatched) throw new Error(`${spec.package}: required media patch is missing`)
    return { spec, path, output, alreadyPatched }
  }))
  if (!check) for (const { path, output, alreadyPatched } of prepared) {
    if (alreadyPatched) continue
    const temp = `${path}.qqai-${process.pid}.tmp`
    await writeFile(temp, output, { mode: 0o644, flag: 'wx' })
    await rename(temp, path)
  }
  return prepared.map(({ spec, alreadyPatched }) => ({ package: spec.package, version: spec.version, file: spec.file,
    sha256: spec.after, status: check ? 'verified' : alreadyPatched ? 'already-patched' : 'patched' }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const check = args[0] === '--check'
  if (check) args.shift()
  if (args.length !== 2) throw new Error('Usage: node patch-plugin-media.mjs [--check] AURABOT_PACKAGE_DIR NEKOWHALE_PACKAGE_DIR')
  console.log(JSON.stringify(await patchPackages(args, { check }), null, 2))
}
