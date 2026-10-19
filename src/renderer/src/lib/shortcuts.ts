// ── Keyboard shortcuts: one definition ────────────────────────────────────
// Every app-level shortcut that more than one component cares about is named
// here, so two listeners can never disagree about which key is which, and so
// the keys can be made rebindable later by changing this table (no UI for that
// yet).
//
// Space has two owners and they must never both act on one press:
//   playPause  the PlayerBar, everywhere, unless the event is already handled
//   tapArmed   the edit modal's tap tempo, ONLY while tap mode is armed
// Arming is explicit (useTapTempoStore); PlayerBar checks it as well as
// defaultPrevented, and the tap listener runs first (window, capture phase).

import { create } from 'zustand'

export type ShortcutId = 'playPause' | 'tapArmed' | 'tap'

// event.key values, compared case-insensitively.
export const SHORTCUTS: Record<ShortcutId, readonly string[]> = {
  playPause: [' '],
  // Space taps only while armed.
  tapArmed: [' '],
  // T taps anywhere in the edit modal (not while typing).
  tap: ['t']
}

export function matchesShortcut(
  e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean },
  id: ShortcutId
): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  return SHORTCUTS[id].includes(key)
}

// Typing in a field always wins: Space there is a space. The same test the
// PlayerBar has always used.
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return el.closest('input, textarea, [contenteditable]') != null
}

interface TapTempoState {
  armed: boolean
  setArmed: (armed: boolean) => void
}

export const useTapTempoStore = create<TapTempoState>((set) => ({
  armed: false,
  setArmed: (armed) => set({ armed })
}))
