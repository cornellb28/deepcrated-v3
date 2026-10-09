import { test, expect } from '@playwright/test'
import {
  PLANS,
  PAID_PLAN_ORDER,
  cheapestPlanFor,
  describePlan,
  hasCapability,
  planBadge
} from '../../src/renderer/src/lib/plan'

// The Account page's tier wording. Nothing here gates anything — the risk
// this covers is telling a DJ the wrong thing about their own subscription,
// e.g. showing a healthy "Sync" for a card that has failed.

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
    entitlement({ plan: 'sync', current_period_end: '2027-03-01T00:00:00Z' })
  )
  expect(plan.name).toBe('Sync')
  expect(plan.paid).toBe(true)
  expect(plan.note?.startsWith('Renews')).toBe(true)
})

test('a subscription set to cancel says it ends, not that it renews', () => {
  const plan = describePlan(
    entitlement({
      plan: 'sync',
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
      plan: 'sync',
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
      entitlement({ plan: 'sync', status, current_period_end: '2027-03-01T00:00:00Z' })
    )
    expect(plan.note).toContain(expected)
  }
})

// A row with a junk timestamp should lose the date, not print "Invalid Date"
// at a DJ.
test('an unreadable period end degrades instead of leaking Invalid Date', () => {
  const plan = describePlan(entitlement({ plan: 'sync', current_period_end: 'not-a-date' }))
  expect(plan.note).toBeNull()
  const failed = describePlan(
    entitlement({ plan: 'sync', status: 'past_due', current_period_end: 'not-a-date' })
  )
  expect(failed.note).toBe('Payment failed')
})

test('a paid tier includes everything free includes', () => {
  const free = describePlan(null)
  const paid = describePlan(entitlement({ plan: 'sync' }))
  for (const item of free.includes) expect(paid.includes).toContain(item)
  expect(paid.includes.length).toBeGreaterThan(free.includes.length)
})

// The tier names are provisional and the website can start writing a new
// one before a desktop build knows about it. An unknown paid plan has to
// render as itself rather than blank — nothing gates on it, so showing it
// is strictly better than hiding it.
test('each paid tier has its own name', () => {
  expect(describePlan(entitlement({ plan: 'sync' })).name).toBe('Sync')
  expect(describePlan(entitlement({ plan: 'library' })).name).toBe('Library')
  expect(describePlan(entitlement({ plan: 'touring' })).name).toBe('Touring')
})

// Prices and caps are the margin guardrail's inputs. Changing one means
// re-checking the >75% worst-case margin, so a change must be deliberate.
test('the price and storage table matches the approved model', () => {
  expect(PAID_PLAN_ORDER).toEqual(['sync', 'library', 'touring'])
  expect(PLANS.sync).toMatchObject({ priceMonthlyUsd: 5, storageGb: 0 })
  expect(PLANS.library).toMatchObject({ priceMonthlyUsd: 19, storageGb: 250 })
  expect(PLANS.touring).toMatchObject({ priceMonthlyUsd: 65, storageGb: 1000 })
})

test('worst-case gross margin stays above 75% for every paid tier', () => {
  // Storage: originals in R2 IA at $0.01/GB, proxies (~20% of originals) in
  // R2 Standard at $0.015/GB. Stripe 2.9% + $0.30. ~$0.50 db/support.
  for (const id of PAID_PLAN_ORDER) {
    const { priceMonthlyUsd: price, storageGb: gb } = PLANS[id]
    const cost = gb * 0.01 + gb * 0.2 * 0.015 + (price * 0.029 + 0.3) + 0.5
    expect((price - cost) / price, id).toBeGreaterThan(0.75)
  }
})

test('free has no cloud capability; sync has metadata only; storage needs library or touring', () => {
  const caps = ['cloudSync', 'mobileBrowse', 'cloudStorage', 'mobileListening'] as const
  expect(caps.map((c) => hasCapability(null, c))).toEqual([false, false, false, false])
  expect(caps.map((c) => hasCapability(entitlement({ plan: 'free' }), c))).toEqual([
    false,
    false,
    false,
    false
  ])
  expect(caps.map((c) => hasCapability(entitlement({ plan: 'sync' }), c))).toEqual([
    true,
    true,
    false,
    false
  ])
  for (const plan of ['library', 'touring'] as const) {
    expect(caps.map((c) => hasCapability(entitlement({ plan }), c))).toEqual([true, true, true, true])
  }
  expect(cheapestPlanFor('cloudSync').id).toBe('sync')
  expect(cheapestPlanFor('cloudStorage').id).toBe('library')
})

test('a paid plan this build has never heard of still renders', () => {
  // Cast: the point is a value outside the union arriving at runtime from
  // a DB row the website wrote.
  const future = describePlan(entitlement({ plan: 'cloud_studio' as Entitlement['plan'] }))
  expect(future.paid).toBe(true)
  expect(future.name).toBe('cloud studio')
  // Unknown paid ids get the least a paid plan can be: Sync.
  expect(hasCapability(entitlement({ plan: 'cloud_studio' as Entitlement['plan'] }), 'cloudSync')).toBe(true)
  expect(hasCapability(entitlement({ plan: 'cloud_studio' as Entitlement['plan'] }), 'cloudStorage')).toBe(false)
  expect(future.includes.length).toBeGreaterThan(0)
})
