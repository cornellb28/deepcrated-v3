// ── Account chip decisions ───────────────────────────────────────────────
// What the top-bar account chip shows, kept apart from the component so it
// can be tested in plain Node. Display only: none of this decides access.

import { describePlan } from './plan'

export type ChipMode = 'hidden' | 'awaitingBrowser' | 'signedOut' | 'signedIn'

export function chipMode(auth: AuthState | null): ChipMode {
  if (!auth) return 'hidden'
  if (auth.status === 'awaitingBrowser') return 'awaitingBrowser'
  // Expired reads as signed out, with a "Sign in again" nudge on top.
  if (auth.status === 'signedIn') return 'signedIn'
  return 'signedOut'
}

export type AccountMenuKey = 'profile' | 'settings' | 'account' | 'signOut'

// Exactly these, in this order. Account and billing details live on the
// website; "Account" opens it rather than showing anything here.
export const ACCOUNT_MENU_ITEMS: readonly { key: AccountMenuKey; label: string }[] = [
  { key: 'profile', label: 'Profile' },
  { key: 'settings', label: 'Settings' },
  { key: 'account', label: 'Account' },
  { key: 'signOut', label: 'Sign out' }
]

// The name a DJ reads for themselves: display name, else email.
export function accountLabel(user: AuthUser | null): string {
  return user?.displayName?.trim() || user?.email?.trim() || 'Account'
}

// Plan label for the Profile view and menu header. A signed-in DJ whose row
// has not been read (offline, nothing cached) sees that honestly rather
// than a guessed "Free".
export function profilePlanLabel(entitlement: Entitlement | null): string {
  return entitlement ? describePlan(entitlement).name : 'Plan unavailable'
}

// The letter shown when there is no photo, or it failed to load.
export function avatarInitial(user: AuthUser | null): string {
  const source = user?.displayName?.trim() || user?.email?.trim() || ''
  return source ? source[0].toUpperCase() : '♪'
}
