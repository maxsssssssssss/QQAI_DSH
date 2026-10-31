// The launch URL is read from a protected log, never passed as a CLI argument.
// Default mode does not invoke any model. --real-api runs only synthetic prompts.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';

const argv = process.argv.slice(2);
const visionOnly = argv.includes('--vision-only');
const real = argv.includes('--real-api') || visionOnly;
const args = argv.filter(a => !['--real-api', '--vision-only'].includes(a));
if (args.length < 3 || args.length > 4) throw new Error('Usage: node inspect-dsh-runtime.mjs STARTUP_LOG WORKSPACE OUTPUT_JSON [AUDIT_DIR] [--real-api | --vision-only]');
const [logPath, workspace, output, auditDir] = args.map(a => resolve(a));
const log = await readFile(logPath, 'utf8');
const matched = [...log.matchAll(/dsh web: (https?:\/\/\S+)/g)].at(-1);
if (!matched) throw new Error('No DSH readiness URL in startup log');
const startup = new URL(matched[1]);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(startup.hostname)) throw new Error('Only loopback DSH targets are allowed');
const base = startup.origin;
const tokenExchange = await fetch(startup, { redirect: 'manual' });
if (![302, 303].includes(tokenExchange.status)) throw new Error(`Launch-token exchange HTTP ${tokenExchange.status}`);
const cookie = tokenExchange.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
if (!cookie) throw new Error('No authentication cookie returned');
async function rpc(method, args = {}) {
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const result = (await response.json()).result;
  if (!result?.ok) throw new Error(`${method}: ${result?.error?.code || 'RPC failure'}`);
  return result.value;
}
const publicRequest = { type: 'client-request', rpcId: randomUUID(), method: 'session/list', payload: { args: { request: {} } } };
const authStatus = await fetch(`${base}/api/session/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(publicRequest) });
const inventory = await rpc('pluginInventory/list');
const selected = ['aurabot', 'nekowhale-stickers', 'qqai-whale-source', 'terminal-controller', 'workspace-files', 'directory-picker'];
const evidence = {
  scope: real ? 'local DSH runtime and real API; no QQ connection' : 'local DSH runtime; no model API or QQ connection',
  at: new Date().toISOString(),
  unauthenticatedStatus: authStatus.status,
  nativeOpen: await rpc('session/canOpenWorkspacePath'),
  plugins: inventory.entries.filter(e => selected.includes(e.entryId.split(':').at(-1)))
    .map(e => ({ entryId: e.entryId, moduleName: e.moduleName, enabled: e.enabled, fiberPhase: e.fiberPhase })),
  sessions: [],
};
for (const preset of ['qqai-safe', 'aurabot-private', 'aurabot-private-long', 'aurabot-social']) {
  const id = `qqai-synthetic-${preset}-${randomUUID()}`;
  const created = await rpc('session/create', { request: { cwd: workspace, agentPreset: preset, sessionId: id } });
  const item = { preset, sessionId: created.sessionId };
  if (auditDir) {
    try { item.catalog = JSON.parse(await readFile(join(auditDir, `${created.sessionId}.catalog.json`), 'utf8')); }
    catch { item.catalog = { error: 'audit observer output unavailable' }; }
  }
  evidence.sessions.push(item);
}
async function prompt(sessionId, text, image) {
  await rpc('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' } });
  const before = (await rpc('session/projections', { request: { sessionId } }))?.asOfSeq || 0;
  await rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue',
    content: [{ type: 'text', text }, ...(image ? [image] : [])], clientTimeZone: 'Asia/Shanghai' } });
  const expires = Date.now() + 300_000;
  while (Date.now() < expires) {
    await delay(1500);
    const projection = await rpc('session/projections', { request: { sessionId } });
    if (!projection?.asOfSeq || projection.asOfSeq <= before) continue;
    const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: projection.asOfSeq, maxMessages: 100 } });
    const events = page.records.filter(r => r.type === 'event' && r.event.seq > before).map(r => r.event);
    const end = events.findLast(e => e.type === 'turn/end');
    if (!end) continue;
    // Never export request bodies, system prompts, reasoning, or tool contents.
    const content = events.filter(e => e.type === 'assistant/message').flatMap(e => {
      const parts = e.data?.content || e.data?.message?.content || [];
      return Array.isArray(parts) ? parts.filter(p => p.type === 'text').map(p => p.text) : [];
    });
    return { terminal: end.data?.reason?.kind || 'unknown', errorCode: end.data?.reason?.error?.code,
      assistantText: content.join('\n'), eventTypes: [...new Set(events.map(e => e.type))] };
  }
  await rpc('session/cancel', { request: { sessionId } });
  return { terminal: 'timeout' };
}
// Procedural test fixture, with no label or filename revealing its answer.
function visionFixture() {
  const width = 256, height = 128;
  const scanlines = Buffer.alloc(height * (1 + width * 3), 255);
  for (let y = 0; y < height; y++) {
    scanlines[y * (1 + width * 3)] = 0;
    for (let x = 0; x < width; x++) {
      const color = (x - 64) ** 2 + (y - 64) ** 2 <= 32 ** 2 ? [220, 30, 40]
        : x >= 164 && x < 220 && y >= 36 && y < 92 ? [25, 75, 220] : null;
      if (color) for (let c = 0; c < 3; c++) scanlines[y * (1 + width * 3) + 1 + x * 3 + c] = color[c];
    }
  }
  function chunk(type, bytes) {
    const name = Buffer.from(type), body = Buffer.concat([name, bytes]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const header = Buffer.alloc(4), footer = Buffer.alloc(4);
    header.writeUInt32BE(bytes.length); footer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, body, footer]);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
  return { type: 'image', mediaType: 'image/png', data: bytes.toString('base64'), name: 'synthetic-fixture.png' };
}
if (real) {
  const safe = evidence.sessions.find(s => s.preset === 'qqai-safe');
  const whale = evidence.sessions.find(s => s.preset === 'aurabot-private');
  evidence.realApi = [];
  const cases = [
    ['chinese-context', safe, '这是合成验收，不是真实个人资料。我的测试编号是海盐-741，测试宠物是一条蓝色鲸鱼。请用两句自然中文确认。'],
    ['followup-context', safe, '刚才的测试编号和宠物颜色是什么？只根据本会话回答。'],
    ['whale-persona', whale, '这是合成验收。请自然地介绍你的名字和身份，说明你是否有真实身体；用两到三条短气泡回答。'],
    ['sticker-tools', whale, '请实际调用 sticker_search 找一个开心的表情，再调用 sticker_send 选择它，把工具返回的 Markdown 图片行原样放进回复。不要猜图片路径。'],
    ['text-meme', whale, '请实际用 meme_render 工具制作一张写着“验收通过”的中文文字模板表情。先按工具定义选择可用的纯文字模板，不使用头像、文件路径或网络图片。返回生成的 Markdown 图片。'],
    ['search-fetch', safe, '请实际调用 web_search 搜索 DeepSeek Harness 官方 quickstart，然后调用 web_fetch 读取官方 quickstart 页面。用一句中文回答 Web UI 默认端口并给出官方链接；工具失败请如实说明。'],
    ['image-pixels', safe, '这是合成视觉验收图。只根据图片，描述左、右两侧分别是什么颜色和形状，并给出图形总数。', visionFixture()],
    ['image-followup', safe, '刚才那张图片右边的图形是什么颜色和形状？请根据图片回答。'],
  ];
  for (const [name, session, text, image] of cases.filter(c => !visionOnly || c[0].startsWith('image-'))) {
    const result = await prompt(session.sessionId, text, image);
    evidence.realApi.push({ name, preset: session.preset, ...result });
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ case: name, terminal: result.terminal, errorCode: result.errorCode }));
  }
}
if (auditDir) for (const session of evidence.sessions) {
  try {
    const metadata = await readFile(join(auditDir, `${session.sessionId}.events.jsonl`), 'utf8');
    session.runtimeEvents = metadata.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch { session.runtimeEvents = []; }
}
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ evidence: output, sessions: evidence.sessions.length, realApi: real }));
