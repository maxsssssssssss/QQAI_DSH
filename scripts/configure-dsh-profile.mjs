// Initialize this NEW deployment only. Never read or migrate another project.
// Usage: node configure-dsh-profile.mjs DSH_HOME WORKSPACE PORT
// Optional non-secret environment inputs: OWNER_QQ, BOT_QQ.
// API credentials stay in the service environment; this script never reads them.
import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { patchPackages } from './patch-plugin-media.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const qq = (value) => {
  if (value === undefined || value === null || value === '') return ''
  if (!/^\d{5,12}$/.test(String(value))) throw new Error('QQ identifier must contain 5–12 digits')
  return String(value)
}
async function atomic(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.qqai-${process.pid}.tmp`
  await writeFile(tmp, contents, { mode: 0o600, flag: 'wx' })
  await rename(tmp, path)
  await chmod(path, 0o600)
}
async function existingJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

export async function configureProfile(dshHome, workspace, port, env = process.env) {
  if (!isAbsolute(dshHome) || !isAbsolute(workspace)) throw new Error('DSH_HOME and WORKSPACE must be absolute paths')
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an unprivileged TCP port')
  const profile = join(dshHome, 'profiles', 'web')
  const packages = join(profile, 'node_modules')
  const aurabotPackage = join(packages, 'dsh-aurabot-qq')
  const nekoPackage = join(packages, 'dsh-nekowhale-stickers')
  const personaSource = join(packages, 'dsh-whale-musume-persona', 'cordis.patch.yml')
  // Missing source fixes must prevent configuration from being treated as deployable.
  await patchPackages([aurabotPackage, nekoPackage], { check: true })
  const { whalePersona } = await import('../adapters/qqai-compat/index.mjs')
  whalePersona(await readFile(personaSource, 'utf8'))
  const { DEFAULTS } = await import(pathToFileURL(join(aurabotPackage, 'src/core/config.js')))
  const { PROFILE_PERM_KEYS } = await import(pathToFileURL(join(aurabotPackage, 'src/chat/access.js')))
  const aurabotData = join(dshHome, 'plugins-data', 'aurabot')
  const stickersData = join(dshHome, 'nekowhale-stickers')
  const current = await existingJson(join(aurabotData, 'config.json'))
  const config = structuredClone(DEFAULTS)
  Object.assign(config, {
    enabled: false, dryRun: true, setupDone: false,
    ownerQQ: qq(env.OWNER_QQ ?? current?.ownerQQ), botQQ: qq(env.BOT_QQ ?? current?.botQQ),
    ownerName: '主人', ownerLevel: 'full', gateway: 'onebot', workspaceDir: workspace,
    longTasks: false, allow: { private: [], groups: [] },
    profilePerms: Object.fromEntries(PROFILE_PERM_KEYS.map((key) => [key, 'off'])),
    safeMode: false,
    model: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off', vision: 'auto' },
  })
  config.snowluma = { ...config.snowluma, dir: '', autoStart: false, autoAttach: false,
    httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001',
    // Preserve only same-project gateway tokens across a configuration re-run.
    httpToken: current?.snowluma?.httpToken || '', wsToken: current?.snowluma?.wsToken || '',
    webuiPassword: '', passwordAuto: false }
  config.files = { ...config.files, enabled: false, dirs: [] }
  config.voice = { ...config.voice, enabled: false, asr: false, autoChance: 0 }
  config.stickers = { ...config.stickers, enabled: false, faces: false, collect: false,
    fromGroups: false, fromPrivate: false, caption: false, autoChance: 0 }
  for (const name of ['diary', 'qzoneSocial', 'bili', 'douyin', 'heybox', 'imageGen', 'song']) config[name].enabled = false
  Object.assign(config.qzoneSocial, { replyOwn: false, commentFriends: false, like: false, friendChance: 0, ownerChance: 0 })
  Object.assign(config.bili, { autoBrowse: false, comment: false, reply: false, shareToOwner: false, like: false })
  Object.assign(config.douyin, { autoBrowse: false, ownerDm: false, caps: { like: 0, comment: 0, share: 0, atOwner: 0 } })
  Object.assign(config.heybox, { autoBrowse: false, likeDaily: 0, commentDaily: 0, maxPostsPerDay: 0 })
  config.local = { tts: false, image: false, song: false, asr: false }
  config.bridge = { ...config.bridge, dshTools: false, http: false, token: '', allowTargets: 'owner' }
  // Enable only after a real owner/bot identity and QQ sending have been verified.
  config.speakUp.enabled = false
  const disabled = ['stickers', 'voice', 'group-admin', 'imagegen', 'diary', 'qzone-social',
    'purpose', 'pet', 'bili', 'song', 'profile', 'contacts', 'douyin', 'heybox']
  config.modules = Object.fromEntries(disabled.map((id) => [id, { enabled: false }]))
  for (const id of ['memory', 'mood', 'speakup', 'qq-tools', 'qqai-compat']) config.modules[id] = { enabled: true }
  config.ext = { 'qqai-compat': { personaSourcePath: personaSource, stickersDataDir: stickersData,
    botName: '大肥鱼', ownerName: '主人' } }

  const manifestPath = join(profile, 'package.json')
  const manifest = await existingJson(manifestPath)
  if (!manifest) throw new Error('Install the web profile and three plugins first')
  for (const name of ['dsh-aurabot-qq', 'dsh-whale-musume-persona', 'dsh-nekowhale-stickers']) {
    if (!manifest.dependencies?.[name]) throw new Error(`Missing profile dependency ${name}`)
  }
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
    'dsh-aurabot-qq', 'dsh-nekowhale-stickers']
  const safe = await readFile(join(repo, 'config/safe-profile.patch.yml'), 'utf8')
  const extra = `\n# Install the selected persona's host entry without its obsolete preset patch.\n`
    + `- insert:\n    - id: qqai-whale-source\n      name: dsh-whale-musume-persona\n`
    + `- id: nekowhale-stickers\n  config:\n`
    + `    dataDir: ${JSON.stringify(stickersData)}\n    autoSync: lazy\n    promptMode: off\n`
    + `    pet: false\n    petBubbles: false\n    petBalance: false\n`
    + `    templates: true\n    agentCuration: true\n    returnImageToModel: false\n`
    + `    publicBaseUrl: ${JSON.stringify(`http://127.0.0.1:${port}`)}\n`
    + `    routePath: /x-nekowhale-stickers\n`
  const adapter = await readFile(join(repo, 'adapters/qqai-compat/index.mjs'), 'utf8')
  // All values above have been validated before writing runtime configuration.
  for (const dir of [dshHome, aurabotData, stickersData, workspace]) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
  }
  await atomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  await atomic(join(profile, 'cordis.patch.yml'), safe.trimEnd() + '\n' + extra)
  await atomic(join(aurabotData, 'modules/qqai-compat/index.mjs'), adapter)
  await atomic(join(aurabotData, 'config.json'), JSON.stringify(config, null, 2) + '\n')
  return { profile, aurabotData, stickersData, enabled: false, dryRun: true,
    ownerConfigured: Boolean(config.ownerQQ), botConfigured: Boolean(config.botQQ), port }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 3) throw new Error('Usage: node configure-dsh-profile.mjs DSH_HOME WORKSPACE PORT')
  console.log(JSON.stringify(await configureProfile(args[0], args[1], Number(args[2])), null, 2))
}
