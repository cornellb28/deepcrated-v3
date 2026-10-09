// ── Plan / tier wording ───────────────────────────────────────────────────
// Turns an `entitlements` row into the words the Account and Plan pages show,
// and says which CLOUD features a plan unlocks.
//
// Read-only on purpose. The desktop app is free and gates no local feature,
// and plan/status are written only by the payments website's Stripe webhook.
// The only things a plan unlocks are cloud surfaces (sync, mobile, cloud
// storage), and the real enforcement of those is server-side: the website and
// Supabase decide, from the plan id, what a request may do. The locks in this
// app are a display of that, never the check itself.
//
// Final model (2026-10-08):
//   free     no cloud sync, no mobile
//   sync     $5/mo   metadata + tag sync, mobile browse/tag. NO audio upload
//   library  $19/mo  Sync + 250 GB cloud library + mobile listening
//   touring  $65/mo  Sync + 1 TB cloud library + mobile listening
// Margin guardrail: every tier must stay above 75% gross margin at worst case
// (subscriber fills the cap; Stripe 2.9% + $0.30; ~$0.50/user db+support).
// Do not change a price, cap or inclusion without re-checking that math.

export type PlanId = 'free' | 'sync' | 'library' | 'touring'

export type PlanCapability =
  | 'cloudSync' // metadata and tags synced across machines
  | 'mobileBrowse' // browse and tag from the mobile app
  | 'cloudStorage' // upload / download audio in the cloud library
  | 'mobileListening' // stream proxies in the mobile app

export interface PlanDefinition {
  id: PlanId
  name: string
  // Whole US dollars per month. 0 for free.
  priceMonthlyUsd: number
  // Display only. Enforced SERVER-SIDE from the plan id; a client-supplied cap
  // is never trusted. Counts originals only (confirmed default); proxies are
  // stored on top. TODO(storage-cap): confirm with the server constants.
  storageGb: number
  tagline: string
  highlights: string[]
  capabilities: readonly PlanCapability[]
}

// Everything on this list is in the free desktop app, for everyone. It is
// here so the Plan page can say what the DJ already has rather than only what
// they could buy.
const FREE_INCLUDES = [
  'Unlimited tracks, crates and tags',
  'BPM and key analysis',
  'Serato import and .crate export'
]

export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: 'free',
    name: 'Free',
    priceMonthlyUsd: 0,
    storageGb: 0,
    tagline: 'The full desktop app, at no cost — nothing here is locked.',
    highlights: FREE_INCLUDES,
    capabilities: []
  },
  sync: {
    id: 'sync',
    name: 'Sync',
    priceMonthlyUsd: 5,
    storageGb: 0,
    tagline: 'Your library metadata follows you between machines and your phone.',
    highlights: [
      'Cloud sync of library metadata and tags',
      'Mobile app: browse and tag',
      'Metadata only — no audio upload or cloud storage'
    ],
    capabilities: ['cloudSync', 'mobileBrowse']
  },
  library: {
    id: 'library',
    name: 'Library',
    priceMonthlyUsd: 19,
    storageGb: 250,
    tagline: 'Sync, plus a cloud library you can listen to on your phone.',
    highlights: [
      'Everything in Sync',
      '250 GB cloud library',
      'Mobile listening'
    ],
    capabilities: ['cloudSync', 'mobileBrowse', 'cloudStorage', 'mobileListening']
  },
  touring: {
    id: 'touring',
    name: 'Touring',
    priceMonthlyUsd: 65,
    storageGb: 1000,
    tagline: 'Sync, plus a 1 TB cloud library for a whole touring collection.',
    highlights: [
      'Everything in Sync',
      '1 TB cloud library',
      'Mobile listening'
    ],
    capabilities: ['cloudSync', 'mobileBrowse', 'cloudStorage', 'mobileListening']
  }
}

export const PAID_PLAN_ORDER: readonly PlanId[] = ['sync', 'library', 'touring']

// TODO(addon): extra storage in 250 GB blocks at $15/mo (proposed, not built).
// TODO(annual): annual billing is not built. If added, cap the discount at 10%.
// TODO(grace): cloud data is kept for a grace period after a plan lapses
//   before deletion — the owner decides the length; nothing deletes anything
//   from this app.
// TODO(cloud-delete): removing a track from the cloud deletes it permanently
//   and needs a clear warning in the UI that does it.
// TODO(fair-use): a full-library restore costs ~$0.01/GB in retrieval fees;
//   a fair-use limit is needed before restore ships.
// TODO(offline-trust): an entitlement cache for offline launch needs a storage
//   decision and a trust window; none is persisted today, so offline the plan
//   reads as unavailable and cloud locks stay shown.
// TODO(entitled): which statuses count as entitled is decided once, on the
//   website's server (active/trialing, or past_due until period end). Here a
//   lapsed subscription is expected to arrive as plan 'free' (the webhook's
//   canceled/none fallback), so capabilities follow the plan id alone.

function planOf(entitlement: Entitlement | null): PlanId {
  const plan = entitlement?.plan
  if (!plan || plan === 'free') return 'free'
  // A paid id this build has never heard of (the website shipped a new tier
  // first): treat it like Sync, the least it can be, and show its raw name.
  return plan in PLANS ? (plan as PlanId) : 'sync'
}

export function hasCapability(entitlement: Entitlement | null, cap: PlanCapability): boolean {
  return PLANS[planOf(entitlement)].capabilities.includes(cap)
}

// The cheapest plan that unlocks `cap`, for "Available on …" lock labels.
export function cheapestPlanFor(cap: PlanCapability): PlanDefinition {
  return PLANS[PAID_PLAN_ORDER.find((id) => PLANS[id].capabilities.includes(cap)) ?? 'touring']
}

export interface PlanSummary {
  // The tier name as the DJ should read it, e.g. 'Free' or 'Library'.
  name: string
  // One supporting line under the name.
  tagline: string
  // Set only when the subscription is not simply healthy, or is ending.
  note: string | null
  // What this tier gets you.
  includes: string[]
  // True for a paid tier. Styling only — never a gate.
  paid: boolean
}

// A value the website added after this desktop build shipped still has to
// render as something: its own name, rather than a blank or a crash.
function paidName(plan: string): string {
  return PLANS[plan as PlanId]?.name ?? plan.replace(/_/g, ' ')
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// A subscription's health, in a DJ's words rather than Stripe's. Returns
// null when there is nothing worth saying.
function subscriptionNote(e: Entitlement): string | null {
  const end = formatDate(e.current_period_end)

  switch (e.status) {
    case 'active':
      if (e.cancel_at_period_end) return end ? `Ends ${end}` : 'Ends at the end of this period'
      return end ? `Renews ${end}` : null
    case 'trialing':
      return end ? `Trial ends ${end}` : 'Trial'
    // Retryable: a card that failed is not a cancellation, and the website
    // keeps access alive to the end of the paid period so a bad card can't
    // cut a DJ off mid-set.
    case 'past_due':
      return end ? `Payment failed — access until ${end}` : 'Payment failed'
    case 'paused':
      return 'Paused'
    case 'canceled':
      return 'Canceled'
    case 'unpaid':
      return 'Unpaid'
    case 'revoked':
      return 'Revoked'
    default:
      // incomplete / incomplete_expired — a checkout that never finished.
      return 'Not finished'
  }
}

// `null` means the row has not been read yet (or there is no session). Free
// is the honest answer for both: the desktop app is free, and every account
// starts on a free row.
export function describePlan(entitlement: Entitlement | null): PlanSummary {
  if (!entitlement || entitlement.plan === 'free') {
    return {
      name: PLANS.free.name,
      tagline: PLANS.free.tagline,
      note: null,
      includes: PLANS.free.highlights,
      paid: false
    }
  }

  const def = PLANS[planOf(entitlement)]
  return {
    name: paidName(entitlement.plan),
    tagline: def.tagline,
    note: subscriptionNote(entitlement),
    includes: [...FREE_INCLUDES, ...def.highlights.filter((h) => !h.startsWith('Everything in'))],
    paid: true
  }
}

// Short form for the places that have room for a word, not a card — the
// dashboard account chip and the empty state's signed-in line.
export function planBadge(entitlement: Entitlement | null): string {
  return describePlan(entitlement).name
}
