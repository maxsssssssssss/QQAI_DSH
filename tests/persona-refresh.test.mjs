import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { normalizePersonaSurface } from '../scripts/refresh-qq-session-persona.mjs'

const previousPersona = '旧版小鲸'
const currentPersona = '新版小鲸'
const rendered = currentPersona + '\n\nQQ 当前规则'
const createSystemMessage = text => ({ role: 'system', id: randomUUID(), source: { kind: 'system-prompt' },
  content: text ? [{ type: 'text', text }] : [] })
const options = { previousPersona, currentPersona, rendered, createSystemMessage }

function fixture(systems) {
  const events = [], nodes = []
  function add(type, message) {
    nodes.push(events.length)
    events.push({ type, seq: events.length, data: { turn: 1, step: 1, message } })
  }
  for (const [i, text] of systems.entries()) {
    add('system/message', createSystemMessage(text))
    for (const role of ['user', 'assistant']) add(role + '/message', { role, id: role + i,
      content: [{ type: 'text', text: '合成对话' + i }] })
  }
  return { events, surface: { nodes }, eventAt: seq => events[seq],
    deriveMessages: () => nodes.map(seq => events[seq].data.message).filter(message => message.content.length),
    append(type, data, { surfaceOp, sourceEventSeqs }) {
      assert.equal(type, 'system/message')
      assert.equal(surfaceOp.op, 'replace')
      assert.equal(surfaceOp.startSeq, surfaceOp.endSeq)
      const seq = surfaceOp.startSeq, index = nodes.indexOf(seq)
      assert.ok(index >= 0)
      assert.deepEqual(sourceEventSeqs, [seq])
      assert.equal(events[seq].type, 'system/message')
      nodes[index] = events.length
      events.push({ type, seq: events.length, data, surfaceOp, sourceEventSeqs })
    } }
}

test('refresh replaces only the old system head and nonempty tails, preserving original events and all dialogue', async () => {
  const session = fixture([previousPersona + '\n旧规则', '', rendered])
  const originals = structuredClone(session.events)
  const history = session.deriveMessages().filter(message => message.role !== 'system')
  const preview = await normalizePersonaSurface(session, { ...options, dryRun: true })
  assert.equal(preview.plannedReplacements, 2)
  assert.equal(preview.appliedReplacements, 0)
  assert.equal(preview.leadingIsCurrent, false)
  assert.deepEqual(session.events, originals)
  const applied = await normalizePersonaSurface(session, options)
  assert.equal(applied.appliedReplacements, 2)
  assert.equal(applied.activeSystemAfter, 1)
  assert.equal(applied.nonSystemMessages, history.length)
  assert.equal(applied.leadingIsCurrent, true)
  assert.deepEqual(session.events.slice(0, originals.length), originals)
  assert.deepEqual(session.deriveMessages().slice(1), history)
  assert.equal((await normalizePersonaSurface(session, options)).appliedReplacements, 0)
})

test('partly completed refresh can be retried without replacing the new head twice', async () => {
  const session = fixture([previousPersona, previousPersona + '\n另一套历史规则', rendered])
  const append = session.append
  let calls = 0
  session.append = (...args) => {
    if (++calls === 2) throw new Error('simulated interruption')
    return append(...args)
  }
  await assert.rejects(normalizePersonaSurface(session, options), /interruption/)
  const fixedHeadId = session.deriveMessages()[0].id
  session.append = append
  const retried = await normalizePersonaSurface(session, options)
  assert.equal(retried.appliedReplacements, 2)
  assert.equal(retried.activeSystemAfter, 1)
  assert.equal(session.deriveMessages()[0].id, fixedHeadId)
})

test('a persona-only edit on the old head takes effect before the next turn', async () => {
  const oldRendering = 'QQ 私聊\n' + previousPersona + '\n陪伴设置'
  const newRendering = 'QQ 私聊\n' + currentPersona + '\n陪伴设置'
  const currentOptions = { ...options, rendered: newRendering }
  const session = fixture([oldRendering])
  const history = session.deriveMessages().slice(1)
  const preview = await normalizePersonaSurface(session, { ...currentOptions, dryRun: true })
  assert.equal(preview.plannedReplacements, 1)
  assert.equal(preview.appliedReplacements, 0)
  const applied = await normalizePersonaSurface(session, currentOptions)
  assert.equal(applied.activeSystemAfter, 1)
  assert.equal(session.deriveMessages()[0].content[0].text, newRendering)
  assert.deepEqual(session.deriveMessages().slice(1), history)
  assert.equal((await normalizePersonaSurface(session, currentOptions)).appliedReplacements, 0)

  const unexpected = fixture([oldRendering + '额外指令'])
  const count = unexpected.events.length
  await assert.rejects(normalizePersonaSurface(unexpected, currentOptions), /match fresh rendering/)
  assert.equal(unexpected.events.length, count)
})

test('rejects unrelated prompts, a stale or projected latest system and non-DSH producers before writing', async () => {
  for (const session of [fixture(['第三方系统', rendered]), fixture([previousPersona, currentPersona]),
    fixture([previousPersona, '前言提及' + currentPersona, rendered])]) {
    const count = session.events.length
    await assert.rejects(normalizePersonaSurface(session, options))
    assert.equal(session.events.length, count)
  }
  const session = fixture([previousPersona, rendered])
  session.events[0].data.message.source.kind = 'third-party'
  await assert.rejects(normalizePersonaSurface(session, options), /Unrecognized/)
  session.events[0].data.message.source.kind = 'system-prompt'
  const derive = session.deriveMessages
  session.deriveMessages = () => derive().slice(1)
  await assert.rejects(normalizePersonaSurface(session, options), /Projected/)
})

test('detects unexpected changes to the retained dialogue even when its message count stays constant', async () => {
  const session = fixture([previousPersona, rendered])
  const append = session.append
  session.append = (...args) => {
    append(...args)
    session.events[1].data.message.content[0].text = '意外变化'
  }
  await assert.rejects(normalizePersonaSurface(session, options), /failed verification/)
})
