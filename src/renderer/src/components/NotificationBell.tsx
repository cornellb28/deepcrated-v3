// ── Pending-changes bell ──────────────────────────────────────────────────
// The watcher records everything it notices — a file added, moved or deleted
// behind the app's back — as a `pending_changes` row for the DJ to review.
// Until now the only way to reach that queue was Settings > Library, which
// meant a DJ had to already suspect something had happened.
//
// This is the "something happened" signal: a bell in the toolbar, a dot when
// the queue is non-empty, and the count on it.
//
// ── Why this polls instead of listening ──────────────────────────────────
// The obvious wiring is window.api.onTrackAdded/Moved/Deleted, which fire at
// exactly the moments a row is inserted. The problem is their teardown:
// offTrackAdded() is `removeAllListeners('watcher:track-added')`, so whichever
// component unmounts first silently deafens the other — and App.tsx already
// holds those three. A count that is a few seconds stale is a much smaller
// problem than a library view that stops refreshing, so this owns a cheap
// poll instead and refreshes immediately on the two moments that matter:
// the window regaining focus, and the review modal closing.

import React, { useCallback, useEffect, useState } from 'react'
import { Bell } from 'lucide-react'
import { ReconciliationModal } from './ReconciliationModal'

const POLL_MS = 8000
const ACCENT = '#7f77dd'

export function NotificationBell(): React.JSX.Element {
  const [count, setCount] = useState(0)
  const [open, setOpen] = useState(false)

  // Fetching and applying are split so the setState lands in a .then
  // callback rather than in the effect body — the same shape App.tsx uses
  // for its settings read, and what react-hooks/set-state-in-effect asks for.
  //
  // -1 is the "ask again later" sentinel. A failed count is not worth a
  // toast, and the bell keeps its last value rather than flashing to zero
  // and back on a single hiccup.
  const fetchCount = useCallback(async (): Promise<number> => {
    try {
      const changes = await window.api.watcher.pendingChanges()
      return Array.isArray(changes) ? changes.length : 0
    } catch {
      return -1
    }
  }, [])

  const refresh = useCallback(() => {
    void fetchCount().then((next) => {
      if (next >= 0) setCount(next)
    })
  }, [fetchCount])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  const has = count > 0
  // Past two digits the exact number stops being the useful part.
  const label = count > 99 ? '99+' : String(count)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={
          has
            ? `${count} change${count === 1 ? '' : 's'} to review`
            : 'No changes to review'
        }
        aria-label={
          has ? `${count} changes to review` : 'No changes to review'
        }
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '28px',
          height: '28px',
          borderRadius: '6px',
          background: 'none',
          border: 'none',
          color: has ? ACCENT : '#444',
          cursor: 'pointer',
          fontFamily: 'inherit',
          flexShrink: 0,
          transition: 'color 0.12s ease'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = has ? ACCENT : '#777'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = has ? ACCENT : '#444'
        }}
      >
        <Bell size={15} />

        {has && (
          <span
            // Both halves of what was asked for: a dot that reads as "there
            // is something here" at a glance, carrying the number for when
            // the DJ actually looks at it.
            style={{
              position: 'absolute',
              top: '1px',
              right: count > 9 ? '-2px' : '2px',
              minWidth: '13px',
              height: '13px',
              padding: '0 3px',
              borderRadius: '999px',
              background: ACCENT,
              color: '#fff',
              fontSize: '9px',
              fontWeight: 600,
              lineHeight: '13px',
              textAlign: 'center',
              // Sits over the toolbar, not the bell glyph.
              boxShadow: '0 0 0 2px #0f0f14'
            }}
          >
            {label}
          </span>
        )}
      </button>

      {/* Its own instance, the way SettingsView holds one — the modal is
          self-contained and two of them never render at once. */}
      <ReconciliationModal
        open={open}
        onClose={() => {
          setOpen(false)
          // Reviewing is the one action that reliably changes the count.
          refresh()
        }}
      />
    </>
  )
}
