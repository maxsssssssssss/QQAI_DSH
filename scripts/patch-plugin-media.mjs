// Run against stopped, pinned installed packages. Refuse every unknown source hash.
import { createHash } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
export const PATCHES = [
  {
    package: 'dsh-aurabot-qq', version: '1.1.24', rootIndex: 0, file: 'src/chat/hub.js',
    before: '63d8df994316a6286428ad53cfc530015c340c57cfb9c556fc08c2576a714caf',
    after: '13792168e58b88e2acfa6e94520b06c526037ac42a42d7a95aadba6bc7d8392c',
    needle: '      const buf = await fetchImage(src, { maxBytes: 10 * 1024 * 1024 })',
    replacement: String.raw`      // QQAI_DSH: only verified adapter bytes; never resolve model-supplied paths or URLs.
      const encoded = String(src || '')
      if (!/^base64:\/\/[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 14 * 1024 * 1024) throw new Error('QQAI: unapproved image source')
      const buf = Buffer.from(encoded.slice(9), 'base64')
      if (buf.length < 13 || buf.length > 10 * 1024 * 1024 || !['GIF87a', 'GIF89a'].includes(buf.subarray(0, 6).toString('ascii'))) throw new Error('QQAI: invalid GIF')`,
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
]

export function patchedSource(raw, spec) {
  const source = String(raw).trimEnd() + '\n'
  const current = sha256(source)
  if (current === spec.after) return source
  if (current !== spec.before) throw new Error(`${spec.package}: unreviewed source hash ${current}`)
  if (source.split(spec.needle).length !== 2) throw new Error(`${spec.package}: patch anchor is not unique`)
  const output = source.replace(spec.needle, spec.replacement)
  if (sha256(output) !== spec.after) throw new Error(`${spec.package}: generated patch hash mismatch`)
  return output
}

export async function patchPackages(roots, { check = false } = {}) {
  // Validate both packages before mutating either one.
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
