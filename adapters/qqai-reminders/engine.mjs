// Durable owner-private reminders. Text is data; transport is supplied by the module.
import { randomUUID } from 'node:crypto'

const MINUTE = 60_000, DAY = 86_400_000, OFFSET = 8 * 3600_000
const MAX_FUTURE = 366 * DAY, MAX_ACTIVE = 50, MAX_HISTORY = 200
const STATUSES = new Set(['pending', 'sending', 'completed', 'cancelled', 'uncertain', 'expired'])
const ACTIVE = new Set(['pending', 'sending', 'uncertain'])
const QQ = /^[1-9]\d{4,11}$/, ID = /^[a-f0-9]{12}$/
const REGISTRY = Symbol.for('qqai.reminders.leases.v1')
const leases = globalThis[REGISTRY] ||= new Map()
const safeInt = value => Number.isSafeInteger(value) && value >= 0
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const fail = message => { throw new Error(message) }
const check = (condition, message = '提醒数据格式不正确') => { if (!condition) fail(message) }
const stamp = value => new Date(value + OFFSET).toISOString().slice(0, 19).replace('T', ' ') + '（北京时间）'
const statusName = status => ({ pending: '等待发送', sending: '正在发送', completed: '已发送', cancelled: '已取消', uncertain: '发送结果待核实，已暂停', expired: '逾期超过 24 小时，已失效' })[status]
const scheduleName = task => task.repeat === 'once' ? stamp(task.nextAt)
  : `${task.repeat === 'daily' ? '每天' : '每周' + '一二三四五六日'[task.weekday - 1]} ${task.time}（北京时间），下次 ${stamp(task.nextAt)}`
const summary = task => `#${task.id}｜${task.text}｜${scheduleName(task)}｜${statusName(task.status)}`
const receiptId = value => (typeof value === 'number' && Number.isSafeInteger(value) && value !== 0)
  || (typeof value === 'string' && /^-?[1-9]\d{0,29}$/.test(value))

/** Beijing has no daylight-saving transition; timestamps never use host timezone. */
export function nextOccurrence({ repeat, time, weekday }, after) {
  check(['daily', 'weekly'].includes(repeat))
  check(typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
  check(repeat !== 'weekly' || (Number.isInteger(weekday) && weekday >= 1 && weekday <= 7))
  const day = Math.floor((after + OFFSET) / DAY) * DAY - OFFSET
  const [hour, minute] = time.split(':').map(Number)
  let candidate = day + hour * 3600_000 + minute * MINUTE
  if (repeat === 'daily') return candidate > after ? candidate : candidate + DAY
  const currentDay = new Date(day + OFFSET).getUTCDay() || 7
  candidate += ((weekday - currentDay + 7) % 7) * DAY
  return candidate > after ? candidate : candidate + 7 * DAY
}

export function normalizeReminder(input, now) {
  check(object(input), '请给出提醒内容和时间')
  check(Object.keys(input).every(key => ['text', 'at', 'delayMinutes', 'repeat', 'time', 'weekday'].includes(key)), '提醒参数包含不支持的字段')
  check(typeof input.text === 'string' && input.text.trim().length > 0 && input.text.trim().length <= 300
    && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(input.text), '提醒内容须为 1–300 字的单行文字')
  const text = input.text.trim(), repeat = input.repeat ?? 'once'
  check(['once', 'daily', 'weekly'].includes(repeat), '只支持单次、每天或每周提醒')
  if (repeat !== 'once') {
    check(input.at === undefined && input.delayMinutes === undefined, '重复提醒请只指定每天/每周的时间')
    check(repeat === 'weekly' || input.weekday === undefined, '每天提醒不需要星期参数')
    const normalized = { text, repeat, time: input.time, weekday: repeat === 'weekly' ? input.weekday : null,
      sourceKind: 'recurring', delayMs: null }
    return { ...normalized, nextAt: nextOccurrence(normalized, now) }
  }
  check(input.time === undefined && input.weekday === undefined, '单次提醒请使用明确日期时间或延迟分钟数')
  check((input.at !== undefined) !== (input.delayMinutes !== undefined), '单次提醒须且只能指定明确时间或延迟分钟数')
  let nextAt, delayMs = null, sourceKind
  if (input.delayMinutes !== undefined) {
    check(typeof input.delayMinutes === 'number' && Number.isFinite(input.delayMinutes), '延迟分钟数必须是数字')
    delayMs = Math.round(input.delayMinutes * MINUTE)
    check(delayMs >= 1000 && delayMs <= MAX_FUTURE, '提醒时间需在 1 秒至 366 天内')
    nextAt = now + delayMs; sourceKind = 'delay'
  } else {
    check(typeof input.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?\+08:00$/.test(input.at), '时间请使用 YYYY-MM-DDTHH:mm:ss+08:00（北京时间）')
    nextAt = Date.parse(input.at)
    const expanded = input.at.length === 22 ? input.at.slice(0, 16) + ':00+08:00' : input.at
    check(Number.isFinite(nextAt) && new Date(nextAt + OFFSET).toISOString().slice(0, 19) + '+08:00' === expanded, '指定的日期时间不存在')
    check(nextAt - now >= 1000 && nextAt - now <= MAX_FUTURE, '提醒时间需在 1 秒至 366 天内')
    sourceKind = 'absolute'
  }
  return { text, repeat, time: null, weekday: null, nextAt, sourceKind, delayMs }
}

const zeroStats = () => ({ created: 0, confirmed: 0, uncertain: 0, expired: 0, cancelled: 0, skipped: 0, lastAttemptAt: 0, lastConfirmedAt: 0 })
function parseState(raw) {
  check(object(raw), '提醒存储不可读取，已停止调度')
  if (!Object.keys(raw).length) return { version: 1, tasks: [], stats: zeroStats() }
  check(raw.version === 1 && Array.isArray(raw.tasks) && raw.tasks.length <= 1000 && object(raw.stats), '提醒存储格式损坏，已停止调度')
  const stats = zeroStats()
  for (const key of Object.keys(stats)) { check(safeInt(raw.stats[key]), '提醒统计损坏，已停止调度'); stats[key] = raw.stats[key] }
  const ids = new Set()
  const tasks = raw.tasks.map(value => {
    check(object(value) && ID.test(value.id) && !ids.has(value.id) && QQ.test(value.owner))
    ids.add(value.id)
    check(typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 300
      && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value.text))
    check(STATUSES.has(value.status) && ['once', 'daily', 'weekly'].includes(value.repeat))
    for (const key of ['createdAt', 'nextAt', 'attemptAt', 'lastSentAt', 'finishedAt', 'sentCount', 'skippedCount']) check(safeInt(value[key]))
    check(value.createdAt > 0 && value.nextAt > 0 && value.nextAt < 253402185600000)
    check(['absolute', 'delay', 'recurring'].includes(value.sourceKind))
    check(value.messageId === null || receiptId(value.messageId))
    if (value.repeat === 'once') {
      check(value.time === null && value.weekday === null && value.sourceKind !== 'recurring')
      check(value.sourceKind === 'delay' ? safeInt(value.delayMs) && value.delayMs >= 1000 && value.delayMs <= MAX_FUTURE : value.delayMs === null)
    } else {
      check(value.sourceKind === 'recurring' && value.delayMs === null)
      check(value.repeat === 'daily' ? value.weekday === null : Number.isInteger(value.weekday) && value.weekday >= 1 && value.weekday <= 7)
      check(nextOccurrence(value, value.nextAt - 1) === value.nextAt, '重复提醒时间损坏，已停止调度')
    }
    return Object.fromEntries(['id', 'owner', 'text', 'repeat', 'time', 'weekday', 'nextAt', 'sourceKind', 'delayMs',
      'createdAt', 'status', 'attemptAt', 'lastSentAt', 'finishedAt', 'sentCount', 'skippedCount', 'messageId'].map(key => [key, value[key]]))
  })
  return { version: 1, tasks, stats }
}

export function createReminderEngine({ load, save, now = Date.now, send, isAllowed = () => true,
  leaseKey = 'qqai-reminders', registry = leases }) {
  check(typeof load === 'function' && typeof save === 'function' && typeof send === 'function')
  const token = Symbol('reminder-generation'), slot = registry.get(leaseKey) || { generation: null, work: null }
  registry.set(leaseKey, slot); slot.generation = token
  let disposed = false, storageFailed = false, lastTickAt = 0, state
  const alive = () => !disposed && slot.generation === token
  const ready = () => alive() && !storageFailed
  try { state = parseState(load()) } catch { storageFailed = true; fail('提醒存储不可读取或格式损坏，已停止调度') }
  function prune() {
    const active = state.tasks.filter(task => ACTIVE.has(task.status))
    const history = state.tasks.filter(task => !ACTIVE.has(task.status)).sort((a, b) => (b.finishedAt || b.createdAt) - (a.finishedAt || a.createdAt)).slice(0, MAX_HISTORY)
    state.tasks = [...active, ...history]
  }
  function persist() {
    if (!ready()) fail('提醒模块不可用，未执行操作')
    prune()
    try { save(structuredClone(state)) }
    catch { storageFailed = true; fail('提醒保存失败，已停止调度；请检查服务状态') }
  }
  let recovered = false
  for (const task of state.tasks) if (task.status === 'sending') {
    task.status = 'uncertain'; state.stats.uncertain++; recovered = true
  }
  if (recovered) persist()
  const unavailable = () => ({ ok: false, message: storageFailed ? '提醒存储异常，已停止调度；不能确认任务保存或发送成功' : '提醒模块已停止，请稍后重试' })
  const operation = fn => {
    if (!ready()) return unavailable()
    try { return fn() } catch (error) { return { ok: false, message: error.message } }
  }
  const exportTask = task => ({ id: task.id, text: task.text, repeat: task.repeat, time: task.time, weekday: task.weekday,
    nextAt: task.nextAt, nextAtBeijing: stamp(task.nextAt), status: task.status, sentCount: task.sentCount,
    lastSentAt: task.lastSentAt, skippedCount: task.skippedCount })
  function create(input, owner) {
    return operation(() => {
      check(typeof owner === 'string' && QQ.test(owner), '只能给主人创建私聊提醒')
      const timestamp = now(), normalized = normalizeReminder(input, timestamp)
      const duplicate = state.tasks.find(task => task.owner === owner && ACTIVE.has(task.status)
        && task.text === normalized.text && task.repeat === normalized.repeat
        && (normalized.repeat !== 'once' ? task.time === normalized.time && task.weekday === normalized.weekday
          : task.nextAt === normalized.nextAt || (normalized.sourceKind === 'delay' && task.sourceKind === 'delay'
            && task.delayMs === normalized.delayMs && timestamp >= task.createdAt && timestamp - task.createdAt <= 120_000)))
      if (duplicate) return { ok: true, duplicate: true, task: exportTask(duplicate), message: `已有相同提醒，未重复创建：${summary(duplicate)}` }
      check(state.tasks.filter(task => task.owner === owner && ACTIVE.has(task.status)).length < MAX_ACTIVE, '最多保留 50 个待处理提醒，请先取消不需要的任务')
      let id
      do { id = randomUUID().replaceAll('-', '').slice(0, 12) } while (state.tasks.some(task => task.id === id))
      const task = { ...normalized, id, owner, createdAt: timestamp, status: 'pending', attemptAt: 0,
        lastSentAt: 0, finishedAt: 0, sentCount: 0, skippedCount: 0, messageId: null }
      state.tasks.push(task); state.stats.created++; persist()
      return { ok: true, duplicate: false, task: exportTask(task), message: `已保存提醒：${summary(task)}。到点发送一次，不因未回复追问；明确预约的夜间提醒也会按时发送。` }
    })
  }
  function list(owner, { history = false } = {}) {
    return operation(() => {
      check(typeof owner === 'string' && QQ.test(owner), '只能查看主人的私聊提醒')
      const found = state.tasks.filter(task => task.owner === owner && (history || ACTIVE.has(task.status)))
        .sort((a, b) => history ? b.createdAt - a.createdAt : a.nextAt - b.nextAt)
      const tasks = found.slice(0, 50)
      return { ok: true, count: found.length, tasks: tasks.map(exportTask), message: tasks.length
        ? `${history ? '最近提醒（包含历史）' : '当前提醒'}，均按北京时间：\n${tasks.map(summary).join('\n')}${found.length > 50 ? '\n仅显示前 50 条。' : ''}`
        : history ? '还没有提醒记录。' : '当前没有待处理的提醒。' }
    })
  }
  function cancel(id, owner) {
    return operation(() => {
      check(typeof owner === 'string' && QQ.test(owner) && typeof id === 'string' && ID.test(id), '请提供要取消的提醒编号')
      const task = state.tasks.find(task => task.id === id && task.owner === owner)
      check(task, '未找到这个提醒，请先查看提醒列表')
      if (task.status === 'cancelled') return { ok: true, task: exportTask(task), message: `提醒 #${id} 已取消，无需重复操作。` }
      check(task.status !== 'sending', '这条提醒正在发送，无法保证撤回；请稍后查看结果再取消后续提醒')
      check(ACTIVE.has(task.status), '这条提醒已经结束，不会再次发送')
      task.status = 'cancelled'; task.finishedAt = now(); state.stats.cancelled++; persist()
      return { ok: true, task: exportTask(task), message: `已取消提醒 #${id}：${task.text}。不会再发送后续提醒。` }
    })
  }
  async function allowed(task) {
    if (!ready() || task.status !== 'pending') return false
    try { return (await isAllowed(structuredClone(task))) === true && ready() && task.status === 'pending' }
    catch { return false }
  }
  async function tick() {
    if (!ready() || slot.work) return
    lastTickAt = now()
    const work = Symbol('tick'); slot.work = work
    try {
      const due = state.tasks.filter(task => task.status === 'pending' && task.nextAt <= now()).sort((a, b) => a.nextAt - b.nextAt)
      for (const task of due) {
        if (!(await allowed(task))) continue
        const timestamp = now()
        if (timestamp - task.nextAt > DAY) {
          if (task.repeat === 'once') { task.status = 'expired'; task.finishedAt = timestamp; state.stats.expired++ }
          else {
            const following = nextOccurrence(task, timestamp), skipped = Math.round((following - task.nextAt) / (task.repeat === 'daily' ? DAY : 7 * DAY))
            task.nextAt = following; task.skippedCount += skipped; state.stats.skipped += skipped
          }
          persist(); continue
        }
        const scheduledAt = task.nextAt
        // This durable claim is the single automatic attempt for this occurrence.
        task.status = 'sending'; task.attemptAt = timestamp; state.stats.lastAttemptAt = timestamp; persist()
        let permission = false
        try { permission = (await isAllowed(structuredClone(task))) === true } catch {}
        if (!ready()) return
        if (!permission) { task.status = 'pending'; persist(); continue }
        let receipt
        try { receipt = await send(Object.freeze({ ...structuredClone(task), scheduledAt,
          dueAt: scheduledAt, delayed: timestamp - scheduledAt >= MINUTE })) } catch {}
        if (!ready()) return
        if (receiptId(receipt?.message_id)) {
          task.messageId = String(receipt.message_id); task.sentCount++; task.lastSentAt = now()
          state.stats.confirmed++; state.stats.lastConfirmedAt = task.lastSentAt
          if (task.repeat === 'once') { task.status = 'completed'; task.finishedAt = now() }
          else { task.status = 'pending'; task.nextAt = nextOccurrence(task, Math.max(now(), scheduledAt)) }
        } else { task.status = 'uncertain'; state.stats.uncertain++ }
        persist()
        return // At most one actual outbound attempt per tick, including errors.
      }
    } catch {
      // A storage failure freezes this engine. Never retry the uncertain send.
    } finally { if (slot.work === work) slot.work = null }
  }
  function status() {
    const counts = Object.fromEntries([...STATUSES].map(name => [name, state.tasks.filter(task => task.status === name).length]))
    const pending = state.tasks.filter(task => task.status === 'pending')
    return { version: 1, timezone: 'Asia/Shanghai', ready: ready(), storageFailed, disposed: !alive(),
      inFlight: Boolean(slot.work), counts, totals: { ...state.stats }, lastTickAt,
      nextAt: pending.length ? Math.min(...pending.map(task => task.nextAt)) : null,
      maximumActive: MAX_ACTIVE, maximumCatchUpHours: 24 }
  }
  return { create, list, cancel, tick, status, dispose() { disposed = true } }
}
