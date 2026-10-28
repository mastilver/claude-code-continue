import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

const PROMPT = 'continue'
const MARGIN_MS = 90_000
const RETRY_MS = 5 * 60_000
const MAX_RETRIES = 3
const TICK_MS = 30_000
const KEY = 'pending'

type Pending = { sessionId: string; resumeAt: number; retries: number }

const timers: { fire?: Timer; tick?: Timer } = {}

function stopTimers() {
  timers.fire?.cancel()
  timers.tick?.cancel()
  timers.fire = undefined
  timers.tick = undefined
}

async function disarm($: EngineInterface) {
  stopTimers()
  $.ui.status(undefined)
  await $.store.delete(KEY)
}

async function showWait($: EngineInterface, resumeAt: number) {
  $.ui.status(`auto-continue ${describeWait(resumeAt - (await $.clock.now()))}`)
}

async function arm($: EngineInterface, pending: Pending) {
  stopTimers()
  await $.store.set(KEY, pending)
  await showWait($, pending.resumeAt)
  timers.tick = $.clock.every(TICK_MS, () => void showWait($, pending.resumeAt))
  const wait = Math.max(0, pending.resumeAt - (await $.clock.now()))
  timers.fire = $.clock.after(wait, () => void resume($, pending))
}

async function resume($: EngineInterface, pending: Pending) {
  stopTimers()
  $.ui.status(undefined)
  // Kept (not deleted) so a repeat limit right after counts as a retry.
  await $.store.set(KEY, { ...pending, resumeAt: 0 })
  $.ui.toast('Usage limit reset: continuing')
  await $.prompt.submit({ text: PROMPT, asUser: true })
}

// A failing check must never hold up the stop or the person's prompt.
function report($: EngineInterface, error: unknown) {
  $.ui.log(`auto-continue: ${error instanceof Error ? error.message : String(error)}`)
}

async function onLimit($: EngineInterface, sessionId: string, text: string) {
  const now = await $.clock.now()
  const { rateLimits } = await $.session.usage()
  const resetAt = exhaustedResetAt(rateLimits) ?? parseResetText(text, now)
  if (resetAt === undefined) {
    // Not a usage limit we can time (a transient 429, or text we can't read).
    return
  }

  const previous = (await $.store.get(KEY)) as Pending | undefined
  const isRepeat = previous !== undefined && previous.sessionId === sessionId && previous.resumeAt === 0
  const retries = isRepeat ? previous.retries + 1 : 0
  if (retries > MAX_RETRIES) {
    await disarm($)
    $.ui.toast('auto-continue: still limited after several tries, giving up')
    return
  }

  // A reset time already past means the limit outlived its stated reset: back off.
  const resumeAt = resetAt > now ? resetAt + MARGIN_MS : now + RETRY_MS
  await arm($, { sessionId, resumeAt, retries })
  $.ui.toast(`Usage limit hit: will send "${PROMPT}" ${describeWait(resumeAt - now)}`)
}

async function onPersonPrompt($: EngineInterface) {
  if (timers.fire !== undefined) {
    await disarm($)
  } else {
    await $.store.delete(KEY)
  }
}

export const register: Register = on => {
  on('classic.StopFailure', async ($, e, next) => {
    const result = await next(e)
    if (e.error === 'rate_limit' && e.agent_id === undefined) {
      const text = `${e.error_details ?? ''}\n${e.last_assistant_message ?? ''}`
      await onLimit($, e.session_id, text).catch(error => report($, error))
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    // Our own "continue" passes through here too; anything else means the person took over.
    if (e.origin?.kind !== 'plugin' || e.origin.name !== 'auto-continue') {
      await onPersonPrompt($).catch(error => report($, error))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.reason === 'answer' && timers.fire === undefined) {
      await $.store.delete(KEY)
    }
    return result
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'auto-continue',
      description: 'Show or cancel the pending auto-continue (args: cancel)',
    })

    // A reload or restart loses timers: re-arm from the store for this same session.
    const pending = (await $.store.get(KEY)) as Pending | undefined
    if (pending !== undefined && pending.resumeAt > 0) {
      if (pending.sessionId === (await $.session.id())) {
        await arm($, pending)
      } else {
        await $.store.delete(KEY)
      }
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    stopTimers()
    return next(e)
  })

  on('command.run', { command: 'auto-continue' }, async ($, e) => {
    const pending = (await $.store.get(KEY)) as Pending | undefined
    const isArmed = timers.fire !== undefined && pending !== undefined && pending.resumeAt > 0
    if (e.args.trim() === 'cancel') {
      await disarm($)
      return { text: isArmed ? 'auto-continue cancelled.' : 'Nothing was pending.' }
    }
    if (!isArmed) {
      return { text: 'auto-continue: nothing pending. It arms itself when a usage limit stops a turn.' }
    }
    const wait = pending.resumeAt - (await $.clock.now())
    const at = new Date(pending.resumeAt).toISOString()
    return { text: `auto-continue will send "${PROMPT}" ${describeWait(wait)} (${at}). /auto-continue cancel to stop.` }
  })
}

function exhaustedResetAt(limits: readonly SessionRateLimit[]): number | undefined {
  const times = limits
    .filter(l => l.percentUsed >= 100 && l.resetsAt !== undefined)
    .map(l => Date.parse(l.resetsAt as string))
    .filter(t => Number.isFinite(t))
  return times.length > 0 ? Math.max(...times) : undefined
}

// Reads "resets 3pm (Europe/London)" or "resets 3:30am"; a reset with a date is left alone.
function parseResetText(text: string, now: number): number | undefined {
  const match = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i.exec(text)
  if (match === null) {
    return undefined
  }
  const [, h, m = '0', meridiem, zone] = match
  const hour = (Number(h) % 12) + (meridiem?.toLowerCase() === 'pm' ? 12 : 0)
  const target = hour * 60 + Number(m)

  let current: number
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone?.trim(),
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date(now))
    const get = (type: string) => Number(parts.find(p => p.type === type)?.value)
    current = get('hour') * 60 + get('minute') + get('second') / 60
  } catch {
    return undefined
  }
  if (!Number.isFinite(current)) {
    return undefined
  }

  let minutes = target - current
  if (minutes <= 0) {
    minutes += 24 * 60
  }
  return now + Math.round(minutes * 60_000)
}

function describeWait(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
  if (minutes < 1) {
    return 'now'
  }
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `in ${h > 0 ? `${h}h ${m}m` : `${m}m`}`
}
