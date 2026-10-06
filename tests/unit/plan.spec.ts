import { test, expect } from '@playwright/test'
import { describePlan, planBadge } from '../../src/renderer/src/lib/plan'

// The Account page's tier wording. Nothing here gates anything — the risk
// this covers is telling a DJ the wrong thing about their own subscription,
// e.g. showing a healthy "Cloud Sync" for a card that has failed.

function entitlement(over: Partial<Entitlement> = {}): Entitlement {
  return {
    plan: 'free',
    status: 'active',
    current_period_end: null,
    cancel_at_period_end: false,
    seats: 1,
    ...over
  }
}

test('no row yet reads as Free rather than blank', () => {
  const plan = describePlan(null)
  expect(plan.name).toBe('Free')
  expect(plan.paid).toBe(false)
  expect(plan.note).toBeNull()
  expect(planBadge(null)).toBe('Free')
})

// A lapsed subscription comes back as plan 'free' with whatever status
// Stripe last sent. The DJ is on Free — saying "canceled" next to it would
// read as though something of theirs had been taken away.
test('a free row says nothing about status', () => {
  expect(describePlan(entitlement({ status: 'canceled' })).note).toBeNull()
  expect(describePlan(entitlement({ status: 'past_due' })).note).toBeNull()
})

test('free lists what the desktop app already includes', () => {
  const plan = describePlan(null)
  expect(plan.includes.length).toBeGreaterThan(0)
  expect(plan.tagline).toContain('no cost')
})

test('a healthy subscription shows its renewal date', () => {
  const plan = describePlan(
    entitlement({ plan: 'cloud_mobile', current_period_end: '2027-03-01T00:00:00Z' })
  )
  expect(plan.name).toBe('Cloud + Mobile')
  expect(plan.paid).toBe(true)
  expect(plan.note?.startsWith('Renews')).toBe(true)
})

test('a subscription set to cancel says it ends, not that it renews', () => {
  const plan = describePlan(
    entitlement({
      plan: 'cloud_mobile',
      cancel_at_period_end: true,
      current_period_end: '2027-03-01T00:00:00Z'
    })
  )
  expect(plan.note?.startsWith('Ends')).toBe(true)
})

// past_due is retryable, so it has to read as "fix your card", not as
// "you have been cut off" — the website keeps access to the period end.
test('a failed payment says so and gives the deadline', () => {
  const plan = describePlan(
    entitlement({
      plan: 'cloud_mobile',
      status: 'past_due',
      current_period_end: '2027-03-01T00:00:00Z'
    })
  )
  expect(plan.note).toContain('Payment failed')
  expect(plan.note).toContain('access until')
})

test('every other Stripe status gets plain words', () => {
  const cases: [Entitlement['status'], string][] = [
    ['trialing', 'Trial ends'],
    ['paused', 'Paused'],
    ['canceled', 'Canceled'],
    ['unpaid', 'Unpaid'],
    ['revoked', 'Revoked'],
    ['incomplete', 'Not finished'],
    ['incomplete_expired', 'Not finished']
  ]
  for (const [status, expected] of cases) {
    const plan = describePlan(
      entitlement({ plan: 'cloud_mobile', status, current_period_end: '2027-03-01T00:00:00Z' })
    )
    expect(plan.note).toContain(expected)
  }
})

// A row with a junk timestamp should lose the date, not print "Invalid Date"
// at a DJ.
test('an unreadable period end degrades instead of leaking Invalid Date', () => {
  const plan = describePlan(entitlement({ plan: 'cloud_mobile', current_period_end: 'not-a-date' }))
  expect(plan.note).toBeNull()
  const failed = describePlan(
    entitlement({ plan: 'cloud_mobile', status: 'past_due', current_period_end: 'not-a-date' })
  )
  expect(failed.note).toBe('Payment failed')
})

test('a paid tier includes everything free includes', () => {
  const free = describePlan(null)
  const paid = describePlan(entitlement({ plan: 'cloud_mobile' }))
  for (const item of free.includes) expect(paid.includes).toContain(item)
  expect(paid.includes.length).toBeGreaterThan(free.includes.length)
})

// The tier names are provisional and the website can start writing a new
// one before a desktop build knows about it. An unknown paid plan has to
// render as itself rather than blank — nothing gates on it, so showing it
// is strictly better than hiding it.
test('both provisional paid tiers have their own name', () => {
  expect(describePlan(entitlement({ plan: 'cloud_mobile' })).name).toBe('Cloud + Mobile')
  expect(describePlan(entitlement({ plan: 'cloud_mobile_plus' })).name).toBe('Cloud + Mobile Plus')
})

test('a paid plan this build has never heard of still renders', () => {
  // Cast: the point is a value outside the union arriving at runtime from
  // a DB row the website wrote.
  const future = describePlan(entitlement({ plan: 'cloud_studio' as Entitlement['plan'] }))
  expect(future.paid).toBe(true)
  expect(future.name).toBe('cloud studio')
  expect(future.includes.length).toBeGreaterThan(0)
})
