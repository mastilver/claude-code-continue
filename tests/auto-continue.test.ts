import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOUR = 60 * 60_000
const NOW = Date.parse('2026-10-28T12:00:00Z')

function engine(on: On, resetsAt: string | undefined) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const submitted: string[] = []
  const toasts: string[] = []
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 200_000 },
      rateLimits: resetsAt === undefined ? [] : [{ kind: 'five_hour', percentUsed: 100, resetsAt }],
    },
  }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('classic.StopFailure', () => ({}))
  on('prompt.submit', (_, e) => (submitted.push(e.text), { text: e.text }))
  return { clock, submitted, toasts }
}

test('sends "continue" just after the window resets', async ($, on) => {
  const { clock, submitted } = engine(on, new Date(NOW + 2 * HOUR).toISOString())

  await $.classic.StopFailure({ error: 'rate_limit', session_id: 's1' })
  await clock.advance(2 * HOUR)
  expect(submitted).toEqual([])

  await clock.advance(2 * 60_000)
  expect(submitted).toEqual(['continue'])
})

test('falls back to the reset time in the message', async ($, on) => {
  const { clock, submitted } = engine(on, undefined)

  await $.classic.StopFailure({
    error: 'rate_limit',
    session_id: 's1',
    last_assistant_message: "You've hit your limit · resets 3pm (UTC)",
  })
  await clock.advance(3 * HOUR - 60_000)
  expect(submitted).toEqual([])

  await clock.advance(3 * 60_000)
  expect(submitted).toEqual(['continue'])
})

test('a transient 429 with no reset time does nothing', async ($, on) => {
  const { clock, submitted } = engine(on, undefined)

  await $.classic.StopFailure({ error: 'rate_limit', session_id: 's1' })
  await clock.advance(24 * HOUR)
  expect(submitted).toEqual([])
})

test('a prompt the person types cancels the pending continue', async ($, on) => {
  const { clock, submitted } = engine(on, new Date(NOW + HOUR).toISOString())

  await $.classic.StopFailure({ error: 'rate_limit', session_id: 's1' })
  await $.prompt.submit({ text: 'do something else', wait: false, origin: { kind: 'composer' } })
  await clock.advance(2 * HOUR)
  expect(submitted).toEqual(['do something else'])
})
