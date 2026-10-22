import { test, expect } from '@playwright/test'
import {
  ACCOUNT_MENU_ITEMS,
  accountLabel,
  avatarInitial,
  chipMode,
  profilePlanLabel
} from '../../src/renderer/src/lib/accountChip'
import { planStatusLine } from '../../src/renderer/src/lib/plan'

// What the top-bar account chip shows. Display only; nothing here gates.

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'u1',
    email: 'dj@example.com',
    displayName: 'Nova Vega',
    avatarUrl: null,
    provider: 'google',
    created_at: null,
    ...overrides
  }
}

function auth(overrides: Partial<AuthState> = {}): AuthState {
  return {
    configured: true,
    status: 'signedOut',
    user: null,
    entitlement: null,
    persistent: true,
    offline: false,
    confirmingPurchase: false,
    links: { signIn: true, createAccount: true, passwordReset: false },
    ...overrides
  }
}

function entitlement(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    plan: 'free',
    status: 'active',
    current_period_end: null,
    cancel_at_period_end: false,
    seats: 1,
    ...overrides
  }
}

test('chip state follows auth status', () => {
  expect(chipMode(null)).toBe('hidden')
  expect(chipMode(auth())).toBe('signedOut')
  expect(chipMode(auth({ status: 'expired' }))).toBe('signedOut')
  expect(chipMode(auth({ status: 'awaitingBrowser' }))).toBe('awaitingBrowser')
  expect(chipMode(auth({ status: 'signedIn', user: user() }))).toBe('signedIn')
  // Offline with a cached session is still signed in; main reports it so.
  expect(chipMode(auth({ status: 'signedIn', user: user(), offline: true }))).toBe('signedIn')
})

test('the signed-in menu is exactly Profile, Settings, Account, Sign out', () => {
  expect(ACCOUNT_MENU_ITEMS.map((item) => item.label)).toEqual([
    'Profile',
    'Settings',
    'Account',
    'Sign out'
  ])
})

test('avatar falls back to the name, then the email, then a note', () => {
  expect(avatarInitial(user())).toBe('N')
  expect(avatarInitial(user({ displayName: null }))).toBe('D')
  expect(avatarInitial(user({ displayName: '   ', email: 'zed@example.com' }))).toBe('Z')
  expect(avatarInitial(user({ displayName: null, email: null }))).toBe('♪')
  expect(avatarInitial(null)).toBe('♪')
})

test('account label prefers the name, then the email', () => {
  expect(accountLabel(user())).toBe('Nova Vega')
  const long = `${'a'.repeat(120)}@example.com`
  expect(accountLabel(user({ displayName: null, email: long }))).toBe(long)
  expect(accountLabel(user({ displayName: null, email: null }))).toBe('Account')
})

test('plan label comes from the entitlement, and is honest when there is none', () => {
  expect(profilePlanLabel(entitlement())).toBe('Free')
  expect(profilePlanLabel(entitlement({ plan: 'touring' }))).toBe('Touring')
  expect(profilePlanLabel(null)).toBe('Plan unavailable')
})

test('plan status line uses words, not raw Stripe statuses', () => {
  expect(planStatusLine(entitlement())).toBe('Active')
  expect(planStatusLine(entitlement({ plan: 'sync', status: 'canceled' }))).toBe('Canceled')
  expect(planStatusLine(entitlement({ plan: 'library', status: 'past_due' }))).toBe('Payment failed')
})
