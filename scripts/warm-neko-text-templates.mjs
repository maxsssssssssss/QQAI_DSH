// Exercise the real five text renderers and warm their assets, without model/QQ calls.
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const [packageArg, dataArg] = process.argv.slice(2)
if (!packageArg || !dataArg) throw new Error('Usage: warm-neko-text-templates.mjs PACKAGE DATA_DIR')
const pkg = resolve(packageArg), dataDir = resolve(dataArg)
const { StickerKit } = await import(pathToFileURL(join(pkg, 'lib/core/index.js')))
const { decodeGif } = await import(pathToFileURL(join(pkg, 'lib/meme/gif.js')))
const kit = new StickerKit({ dataDir, packs: ['大肥鱼'], whitelist: ['pack:大肥鱼'],
  autoSync: 'lazy', bundledMeta: join(pkg, 'meta/nekowhale.json') })
const samples = { think: '想吃米饭', sign: '主人今天也很棒', scroll: '最后一把委员会宣布散会',
  couplet_top: '今天也要开心', couplet_bottom: '明天继续努力' }
const result = { scope: 'real-template-rendering-no-model-no-qq', templates: [] }
const templates = (await kit.templates()).filter(t => t.pack === '大肥鱼' && t.input === 'text')
if (templates.length !== 5) throw new Error('Unexpected text template catalog')
for (const template of templates) {
  const start = performance.now()
  const rendered = await kit.render(template.id, { text: samples[template.key] })
  const raw = await readFile(rendered.path), decoded = await decodeGif(raw)
  if (!['GIF89a', 'GIF87a'].includes(raw.subarray(0, 6).toString()) || !decoded.frames.length)
    throw new Error('Rendered template is not a decodable GIF')
  const item = { key: template.key, seconds: +( (performance.now() - start) / 1000).toFixed(3),
    bytes: raw.length, frames: decoded.frames.length, width: decoded.w, height: decoded.h,
    sha256: createHash('sha256').update(raw).digest('hex') }
  result.templates.push(item)
  console.log(JSON.stringify({ progress: item }))
}
console.log(JSON.stringify({ ...result, ok: result.templates.length === 5 }))
