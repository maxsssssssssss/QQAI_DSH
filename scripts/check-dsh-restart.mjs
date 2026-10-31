// Read a saved synthetic session after a real service restart, then ask its model.
// This verifies session persistence, not Aurabot long-term memory or QQ reconnect.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const [startupLog, previousEvidence, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: node check-dsh-restart.mjs PRIVATE_STARTUP_LOG PREVIOUS_EVIDENCE OUTPUT');
const previous = JSON.parse(await readFile(previousEvidence, 'utf8'));
const sessionId = previous.sessions.find(s => s.preset === 'qqai-safe').sessionId;
if (!sessionId.startsWith('qqai-synthetic-')) throw new Error('Only synthetic sessions may be tested');
const urls = [...(await readFile(startupLog, 'utf8')).matchAll(/dsh web: (https?:\/\/\S+)/g)];
const start = new URL(urls.at(-1)?.[1]);
if (start.hostname !== '127.0.0.1') throw new Error('Only loopback is allowed');
const auth = await fetch(start, { redirect: 'manual' });
if (![302, 303].includes(auth.status)) throw new Error('Authentication exchange failed');
const cookie = auth.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
async function rpc(method, args) {
  const r = await fetch(start.origin + '/api/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
  const v = (await r.json()).result;
  if (!v?.ok) throw new Error('RPC did not succeed');
  return v.value;
}
const before = (await rpc('session/projections', { request: { sessionId } })).asOfSeq;
if (!before) throw new Error('Pre-restart session data is missing');
await rpc('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' } });
await rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', clientTimeZone: 'Asia/Shanghai',
  content: [{ type: 'text', text: '服务已重启。请根据本会话重启前的记录，回答最开始的合成测试编号和宠物颜色；不要猜测。' }] } });
const expires = Date.now() + 180_000;
let report = { scope: 'server restart and same-session persistence; not long-term memory or QQ', passed: false, sessionId };
while (Date.now() < expires) {
  await delay(1500);
  const p = await rpc('session/projections', { request: { sessionId } });
  const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: p.asOfSeq, maxMessages: 100 } });
  const events = page.records.filter(r => r.type === 'event' && r.event.seq > before).map(r => r.event);
  const end = events.findLast(e => e.type === 'turn/end');
  if (!end) continue;
  const text = events.filter(e => e.type === 'assistant/message').flatMap(e => {
    const parts = e.data?.content || e.data?.message?.content || [];
    return Array.isArray(parts) ? parts.filter(p => p.type === 'text').map(p => p.text) : [];
  }).join('\n');
  report = { ...report, terminal: end.data?.reason?.kind,
    passed: end.data?.reason?.kind === 'completed' && text.includes('海盐-741') && text.includes('蓝'),
    syntheticReply: text };
  break;
}
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ scope: report.scope, passed: report.passed, terminal: report.terminal || 'timeout' }));
if (!report.passed) process.exitCode = 1;
