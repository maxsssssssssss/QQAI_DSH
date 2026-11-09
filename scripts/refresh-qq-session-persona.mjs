// Call inside the owner agent's runMaintenance(). The caller flushes the session.
import { createHash } from 'node:crypto'

function inspectSurface(session) {
  const systems = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (!event) throw new Error('Missing surface event')
    if (event.type !== 'system/message') continue
    const { message } = event.data
    const blocks = message.content
    if (message.role !== 'system' || message.source?.kind !== 'system-prompt'
      || !Array.isArray(blocks) || blocks.length > 1
      || (blocks.length && (blocks[0].type !== 'text' || typeof blocks[0].text !== 'string'))) {
      throw new Error('Unrecognized system message on the current surface')
    }
    systems.push({ seq, text: blocks[0]?.text ?? '' })
  }
  if (!systems.length || systems[0].seq !== session.surface.nodes[0] || !systems[0].text) {
    throw new Error('Expected a leading DSH persona message')
  }
  const active = systems.filter(node => node.text)
  const messages = session.deriveMessages()
  const projected = messages.filter(message => message.role === 'system')
  if (projected.length !== active.length || messages[0] !== projected[0]
    || !projected.every((message, i) => message.content.length === 1 && message.content[0].text === active[i].text)) {
    throw new Error('Projected system messages differ from retained nodes')
  }
  const digest = createHash('sha256')
  let nonSystemMessages = 0
  for (const message of messages) {
    if (message.role === 'system') continue
    digest.update(JSON.stringify(message)).update('\n')
    nonSystemMessages++
  }
  return { active, nonSystemMessages, digest: digest.digest('hex') }
}

export async function normalizePersonaSurface(session, {
  previousPersona, currentPersona, rendered, dryRun = false, createSystemMessage,
}) {
  if (![previousPersona, currentPersona, rendered].every(s => typeof s === 'string' && s.trim().length)
    || previousPersona === currentPersona || !rendered.includes(currentPersona) || rendered.includes(previousPersona)) {
    throw new Error('Expected distinct complete persona texts and the freshly rendered current system prompt')
  }
  const before = inspectSurface(session)
  const { active } = before
  if (active.at(-1).text !== rendered) throw new Error('Latest retained system does not match fresh rendering')
  const prefix = rendered.slice(0, rendered.indexOf(currentPersona))
  const hasPersona = (text, persona) => text === prefix + persona || text.startsWith(prefix + persona + '\n')
  if (!active.every(({ text }) => hasPersona(text, previousPersona) || hasPersona(text, currentPersona))) {
    throw new Error('Refusing to replace a system node with an unrecognized persona')
  }
  // Install the current head first and clear the latest current tail last.
  // Any interrupted prefix of this operation still admits the same retry.
  const replacements = []
  if (active[0].text !== rendered) replacements.push({ seq: active[0].seq, text: rendered })
  for (const { seq } of active.slice(1)) replacements.push({ seq, text: '' })
  if (!dryRun && replacements.length) {
    const makeMessage = createSystemMessage ??
      (await import('/opt/qqai-dsh/app/node_modules/@deepseek-ai/dsh-llm/lib/index.js')).createSystemMessage
    const { turn, step } = session.eventAt(active.at(-1).seq).data
    if (![turn, step].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Missing system event position')
    for (const { seq, text } of replacements) {
      session.append('system/message', { turn, step, message: makeMessage(text) }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
      })
    }
  }
  const after = inspectSurface(session)
  const leadingIsCurrent = after.active[0].text === rendered
  if (after.digest !== before.digest || after.nonSystemMessages !== before.nonSystemMessages
    || (!dryRun && (after.active.length !== 1 || !leadingIsCurrent))) {
    throw new Error('Retained history or resulting system surface failed verification')
  }
  return {
    dryRun, activeSystemBefore: active.length, activeSystemAfter: after.active.length,
    plannedReplacements: replacements.length, appliedReplacements: dryRun ? 0 : replacements.length,
    nonSystemMessages: after.nonSystemMessages, nonSystemDigestUnchanged: true, leadingIsCurrent,
  }
}
