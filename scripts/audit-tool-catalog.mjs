// Temporary host observer for synthetic acceptance sessions only.
// Mount through an audit-only --patch. No tool, RPC, key or prompt is exposed.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

export const inject = ['tools', 'systemPrompt'];
export function apply(ctx) {
  const dir = process.env.DSH_AUDIT_DIR;
  if (!dir || !isAbsolute(dir)) throw new Error('DSH_AUDIT_DIR must be an absolute protected directory');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const identity = agent => {
    const id = agent?.session?.id;
    return typeof id === 'string' && /^qqai-synthetic-[a-zA-Z0-9-]+$/.test(id) ? id : null;
  };
  const record = (id, value) => appendFileSync(join(dir, `${id}.events.jsonl`), JSON.stringify(value) + '\n', { mode: 0o600 });
  ctx.on('agent/created', async ({ agent }) => {
    const id = identity(agent);
    if (!id) return;
    const schemas = ctx.tools.schemas(agent);
    const assembly = await ctx.systemPrompt.assemble({ scope: agent });
    const persona = assembly.variables.aurabot_persona || '';
    writeFileSync(join(dir, `${id}.catalog.json`), JSON.stringify({
      sessionId: id,
      tools: schemas.map(t => t.name),
      schemaSha256: createHash('sha256').update(JSON.stringify(schemas)).digest('hex'),
      personaReferencedByPrompt: assembly.sections.some(s => s.text.includes('{{aurabot_persona}}')),
      personaSha256: persona ? createHash('sha256').update(persona).digest('hex') : null,
      personaHasWhaleIdentity: /鲸鱼娘/.test(persona),
      personaHasAiIdentity: /AI 伙伴/.test(persona),
      personaHasDefaultName: /你的名字是大肥鱼/.test(persona),
    }, null, 2) + '\n', { mode: 0o600 });
  });
  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const config = await next();
    const id = identity(agent);
    if (id) record(id, { type: 'request-metadata', turn, step, provider: config.provider,
      model: config.model, reasoningEffort: config.reasoningEffort ?? null });
    return config;
  });
  ctx.on('tools/result', (exec, result) => {
    const id = identity(exec.agent);
    if (id) record(id, { type: 'tool-result-metadata', name: exec.name,
      isError: result.isError, errorCode: result.isError ? result.error?.code : undefined });
  });
}
