// ── Which view survives a reload ─────────────────────────────────────────
// Pure, so the rule is testable and lives in one place rather than inline in
// App.tsx's effect.

export const LAST_VIEW_KEY = 'last_view'

export type RestorableView = 'dashboard' | 'library' | 'folders' | 'settings'

// An allow-list, not a deny-list. 'tags' and 'crates' are excluded because
// they only mean anything alongside a selected tag or crate — component
// state that does not survive a reload — so restoring them would drop the
// DJ onto empty chrome. A view added later is not restorable until someone
// has decided whether it can be, which is the safe default.
// 'board' was here until the kanban view was removed; a DJ upgrading with
// it still stored lands on the dashboard through the fallback below, which
// is exactly what that fallback is for.
const RESTORABLE: readonly string[] = ['dashboard', 'library', 'folders', 'settings']

export const DEFAULT_VIEW: RestorableView = 'dashboard'

// Anything unrecognised — a stale value written by an older build, a view
// that has since been renamed, a null from a fresh install — falls back
// rather than throwing or leaving the app on a blank screen.
export function restoreView(stored: string | null | undefined): RestorableView {
  if (!stored) return DEFAULT_VIEW
  return RESTORABLE.includes(stored) ? (stored as RestorableView) : DEFAULT_VIEW
}

export function isRestorable(view: string): boolean {
  return RESTORABLE.includes(view)
}
