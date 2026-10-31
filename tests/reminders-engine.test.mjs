// Synthetic scheduler regressions only; these are not live DeepSeek/QQ evidence.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createReminderEngine, nextOccurrence, normalizeReminder } from '../adapters/qqai-reminders/engine.mjs'

const OWNER = '12345678', OTHER = '87654321'
const BASE = Date.parse('2026-10-31T16:30:00+08:00'), DAY = 86_400_000
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(t, options = {}) {
  let data = structuredClone(options.state ?? {}), clock = options.clock ?? BASE, permit = true, broken = false
  const saves = [], sent = [], registry = options.registry ?? new Map(), leaseKey = options.leaseKey ?? Symbol('reminders-test')
  const load = () => structuredClone(data)
  const save = value => { if (broken) throw new Error('synthetic private details'); data = structuredClone(value); saves.push(structuredClone(value)) }
  const send = async task => { sent.push(structuredClone(task)); if (options.send) return options.send(task); return { message_id: 123000 + sent.length } }
  const allowed = async task => options.isAllowed ? options.isAllowed(task) : permit
  const make = () => createReminderEngine({ load, save, now: () => clock, send, isAllowed: allowed, registry, leaseKey })
  let engine = make()
  t.after(() => engine.dispose())
  return { get engine() { return engine }, saves, sent, registry, leaseKey,
    now: () => clock, at: value => { clock = value }, advance: value => { clock += value },
    state: () => structuredClone(data), forbid: () => { permit = false }, permit: () => { permit = true },
    breakSave: () => { broken = true }, reload: () => { engine = make(); return engine } }
}
const create = (f, args = {}) => f.engine.create({ text: '合成测试：喝一杯水', delayMinutes: 1, ...args }, OWNER)

test('Beijing explicit date and relative delay do not depend on process timezone', () => {
  assert.equal(normalizeReminder({ text: '日期测试', at: '2026-10-31T17:30+08:00' }, BASE).nextAt, BASE + 3600_000)
  assert.equal(normalizeReminder({ text: '秒测试', at: '2026-10-31T16:30:01+08:00' }, BASE).nextAt, BASE + 1000)
  assert.equal(normalizeReminder({ text: '延迟测试', delayMinutes: 1 / 60 }, BASE).nextAt, BASE + 1000)
  for (const at of ['2026-10-31T17:30:00Z', '2026-10-31 17:30:00', '2026-02-30T17:30:00+08:00',
    '2026-10-31T24:30:00+08:00', '2026-10-31T16:30:00+08:00', '2028-10-31T17:30:00+08:00']) {
    assert.throws(() => normalizeReminder({ text: '测试', at }, BASE), at)
  }
  for (const delayMinutes of [0, -1, 0.0001, Infinity, NaN, '2', 527041]) {
    assert.throws(() => normalizeReminder({ text: '测试', delayMinutes }, BASE))
  }
})

test('recurring daily/weekly calculations cross Beijing midnight and calendar boundaries', () => {
  assert.equal(nextOccurrence({ repeat: 'daily', time: '00:10' }, Date.parse('2026-10-31T23:59:00+08:00')), Date.parse('2026-11-01T00:10:00+08:00'))
  assert.equal(nextOccurrence({ repeat: 'weekly', time: '20:00', weekday: 6 }, BASE), Date.parse('2026-10-31T20:00:00+08:00'))
  assert.equal(nextOccurrence({ repeat: 'weekly', time: '16:00', weekday: 6 }, BASE), Date.parse('2026-11-07T16:00:00+08:00'))
  assert.equal(nextOccurrence({ repeat: 'weekly', time: '08:00', weekday: 1 }, BASE), Date.parse('2026-11-02T08:00:00+08:00'))
  assert.equal(nextOccurrence({ repeat: 'daily', time: '16:30' }, BASE), BASE + DAY)
  assert.throws(() => nextOccurrence({ repeat: 'weekly', time: '09:00', weekday: 0 }, BASE))
  assert.throws(() => nextOccurrence({ repeat: 'daily', time: '9:00' }, BASE))
})

test('invalid content, arbitrary target and conflicting schedules are rejected', t => {
  const f = fixture(t)
  for (const args of [{ text: '' }, { text: 'a'.repeat(301) }, { text: '跨行\n任务' }, { text: '不可见\u202e任务' },
    { target: OTHER }, { text: 1 }, { repeat: 'hourly' }, { at: '2026-10-31T18:00:00+08:00' }, { time: '18:00' }]) {
    assert.equal(create(f, args).ok, false, JSON.stringify(args))
  }
  assert.equal(f.engine.create({ text: '测试', delayMinutes: 1 }, '0').ok, false)
  assert.equal(f.state().tasks, undefined)
})

test('saving precedes send and a verified receipt completes only one literal task', async t => {
  let f
  f = fixture(t, { send: task => {
    const stored = f.state().tasks.find(item => item.id === task.id)
    assert.equal(stored.status, 'sending'); assert.equal(stored.attemptAt, f.now())
    assert.equal(task.text, '<voice>literal</voice>|||[CQ:at,qq=all]')
    return { message_id: '-77001' }
  } })
  const result = create(f, { text: '<voice>literal</voice>|||[CQ:at,qq=all]' })
  assert.equal(result.ok, true); assert.match(result.message, /北京时间/)
  await f.engine.tick(); assert.equal(f.sent.length, 0)
  f.advance(60_000); await f.engine.tick(); await f.engine.tick()
  assert.equal(f.sent.length, 1); assert.equal(f.state().tasks[0].status, 'completed')
  assert.equal(f.state().tasks[0].messageId, '-77001'); assert.equal(f.engine.status().totals.confirmed, 1)
})

test('pending tasks survive restart with exact due time and are not duplicated after completion', async t => {
  const f = fixture(t), made = create(f)
  const before = f.state()
  f.reload(); assert.deepEqual(f.state(), before)
  assert.equal(f.engine.list(OWNER).tasks[0].id, made.task.id)
  f.advance(60_000); await f.engine.tick(); f.reload(); await f.engine.tick()
  assert.equal(f.sent.length, 1); assert.equal(f.engine.list(OWNER).tasks.length, 0)
  assert.equal(f.engine.list(OWNER, { history: true }).tasks[0].status, 'completed')
})

test('owner scope protects listing and cancellation, and cancelled tasks never send', async t => {
  const f = fixture(t), made = create(f)
  assert.equal(f.engine.list(OTHER).tasks.length, 0)
  assert.equal(f.engine.cancel(made.task.id, OTHER).ok, false)
  assert.equal(f.engine.cancel(made.task.id, OWNER).ok, true)
  assert.equal(f.engine.cancel(made.task.id, OWNER).ok, true)
  f.advance(60_000); await f.engine.tick(); f.reload(); await f.engine.tick()
  assert.equal(f.sent.length, 0); assert.equal(f.engine.status().totals.cancelled, 1)
})

test('active duplicate absolute, relative and recurring calls reuse the existing job', t => {
  const f = fixture(t), first = create(f)
  f.advance(30_000)
  const duplicate = create(f)
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.task.id, first.task.id)
  const at = '2026-10-31T18:00:00+08:00', abs = f.engine.create({ text: '固定时间', at }, OWNER)
  assert.equal(f.engine.create({ text: '固定时间', at }, OWNER).task.id, abs.task.id)
  const daily = f.engine.create({ text: '每天事项', repeat: 'daily', time: '19:00' }, OWNER)
  assert.equal(f.engine.create({ text: '每天事项', repeat: 'daily', time: '19:00' }, OWNER).task.id, daily.task.id)
  f.engine.cancel(first.task.id, OWNER)
  assert.notEqual(create(f).task.id, first.task.id)
})

test('disconnected/muted preflight leaves pending and sends once on recovery', async t => {
  const f = fixture(t); create(f); f.forbid(); f.advance(90_000)
  await f.engine.tick(); assert.equal(f.sent.length, 0); assert.equal(f.state().tasks[0].status, 'pending')
  f.permit(); await f.engine.tick(); assert.equal(f.sent.length, 1)
  await f.engine.tick(); assert.equal(f.sent.length, 1)
})

test('second permission check can prevent a claimed job from sending', async t => {
  const f = fixture(t, { isAllowed: task => task.status !== 'sending' }); create(f); f.advance(60_000)
  await f.engine.tick()
  assert.equal(f.sent.length, 0); assert.equal(f.state().tasks[0].status, 'pending')
})

test('nighttime explicitly scheduled reminders are allowed independent of proactive chat', async t => {
  const f = fixture(t, { clock: Date.parse('2026-10-31T23:59:00+08:00') })
  create(f); f.advance(60_000); await f.engine.tick()
  assert.equal(f.sent.length, 1); assert.equal(f.engine.status().timezone, 'Asia/Shanghai')
})

test('missing, simulated, invalid and thrown receipts become uncertain and never retry', async t => {
  for (const receipt of [null, {}, { message_id: null }, { message_id: 0 }, { message_id: 'sim-1' }, new Error('private transport text')]) {
    const f = fixture(t, { send: () => { if (receipt instanceof Error) throw receipt; return receipt } })
    create(f); f.advance(60_000); await f.engine.tick(); await f.engine.tick(); f.reload(); await f.engine.tick()
    assert.equal(f.sent.length, 1); assert.equal(f.state().tasks[0].status, 'uncertain')
    assert.match(f.engine.list(OWNER).message, /已暂停/)
    assert.equal(f.engine.status().totals.uncertain, 1)
  }
})

test('concurrent ticks and hot reload cannot repeat an in-flight attempt or late-write old state', async t => {
  const barrier = deferred(), f = fixture(t, { send: () => barrier.promise })
  create(f); f.advance(60_000)
  const old = f.engine, run = old.tick()
  while (!f.sent.length) await Promise.resolve()
  await old.tick(); assert.equal(f.sent.length, 1)
  f.reload(); assert.equal(f.state().tasks[0].status, 'uncertain')
  const restored = f.state(); await f.engine.tick(); barrier.resolve({ message_id: 999 })
  await run; await f.engine.tick()
  assert.deepEqual(f.state(), restored); assert.equal(f.sent.length, 1); assert.equal(old.status().disposed, true)
})

test('cancel during asynchronous preflight prevents the outbound attempt', async t => {
  const barrier = deferred(), f = fixture(t, { isAllowed: () => barrier.promise }), made = create(f)
  f.advance(60_000); const run = f.engine.tick(); await Promise.resolve()
  assert.equal(f.engine.cancel(made.task.id, OWNER).ok, true)
  barrier.resolve(true); await run
  assert.equal(f.sent.length, 0); assert.equal(f.state().tasks[0].status, 'cancelled')
})

test('failed durable claim freezes engine before any send', async t => {
  const f = fixture(t); create(f); f.advance(60_000); f.breakSave()
  await f.engine.tick(); await f.engine.tick()
  assert.equal(f.sent.length, 0); assert.equal(f.engine.status().storageFailed, true)
  assert.equal(create(f, { text: '不应保存' }).ok, false)
  assert.equal(f.state().tasks[0].status, 'pending')
})

test('failed post-send save leaves a durable sending claim and restores uncertain', async t => {
  let f
  f = fixture(t, { send: () => { f.breakSave(); return { message_id: 7101 } } })
  create(f); f.advance(60_000); await f.engine.tick(); await f.engine.tick()
  assert.equal(f.sent.length, 1); assert.equal(f.state().tasks[0].status, 'sending')
  const restored = fixture(t, { state: f.state(), clock: f.now() })
  assert.equal(restored.state().tasks[0].status, 'uncertain'); await restored.engine.tick()
  assert.equal(restored.sent.length, 0)
})

test('24-hour catch-up is bounded and older once/reminder series do not create a burst', async t => {
  const f = fixture(t)
  create(f, { text: '单次逾期' })
  f.engine.create({ text: '每天逾期', repeat: 'daily', time: '17:00' }, OWNER)
  f.advance(3 * DAY); await f.engine.tick()
  assert.equal(f.sent.length, 0)
  assert.equal(f.engine.list(OWNER, { history: true }).tasks.find(task => task.text === '单次逾期').status, 'expired')
  const recurring = f.engine.list(OWNER).tasks[0]
  assert.equal(recurring.nextAt, Date.parse('2026-11-03T17:00:00+08:00')); assert.equal(recurring.skippedCount, 3)
  const delayed = fixture(t); create(delayed); delayed.advance(2 * 3600_000); await delayed.engine.tick()
  assert.equal(delayed.sent.length, 1); assert.equal(delayed.sent[0].delayed, true)
})

test('repeat advances to future once and each scheduler tick sends at most one job', async t => {
  const f = fixture(t)
  f.engine.create({ text: '每天测试', repeat: 'daily', time: '16:31' }, OWNER)
  create(f, { text: '同一时刻第二条' }); f.advance(60_000)
  await f.engine.tick(); assert.equal(f.sent.length, 1)
  await f.engine.tick(); assert.equal(f.sent.length, 2)
  const daily = f.engine.list(OWNER).tasks[0]
  assert.equal(daily.sentCount, 1); assert.equal(daily.nextAt, BASE + DAY + 60_000)
  f.advance(DAY); await f.engine.tick(); assert.equal(f.sent.length, 3)
})

test('50-active limit, private aggregate status and bounded history survive reload', async t => {
  const f = fixture(t)
  for (let i = 0; i < 50; i++) assert.equal(create(f, { text: `合成任务${i}` }).ok, true)
  assert.equal(create(f, { text: '超出上限' }).ok, false)
  const publicStatus = JSON.stringify(f.engine.status())
  assert.equal(publicStatus.includes(OWNER), false); assert.equal(publicStatus.includes('合成任务'), false)
  assert.equal(publicStatus.includes(f.state().tasks[0].id), false)
  for (const item of f.engine.list(OWNER).tasks) f.engine.cancel(item.id, OWNER)
  for (let i = 0; i < 210; i++) { const made = create(f, { text: `历史${i}` }); f.engine.cancel(made.task.id, OWNER) }
  assert.equal(f.state().tasks.length, 200); f.reload(); assert.equal(f.engine.list(OWNER, { history: true }).tasks.length, 50)
})

test('corrupted state fails closed and does not silently reset persisted jobs', t => {
  const f = fixture(t); create(f)
  const badStates = [null, [], { version: 99 }, { ...f.state(), stats: {} },
    { ...f.state(), tasks: [{ ...f.state().tasks[0], owner: 'invalid' }] },
    { ...f.state(), tasks: [f.state().tasks[0], f.state().tasks[0]] },
    { ...f.state(), tasks: [{ ...f.state().tasks[0], status: 'unknown' }] }]
  for (const state of badStates) assert.throws(() => createReminderEngine({ load: () => state, save: () => assert.fail('must not save corrupt data'), send: () => assert.fail('must not send'), registry: new Map() }), /存储/)
})
