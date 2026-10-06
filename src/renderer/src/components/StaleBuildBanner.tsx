// ── "You are running an old build" ────────────────────────────────────────
// Dev only. The renderer hot-reloads; the main process and the preload do
// not. When they drift apart the symptom is never "restart the app" — it is
// a TypeError about an undefined function, or SQLite refusing to bind an
// array, both a long way from the cause.
//
// So the moment out/main or out/preload change under the running process,
// this says so in plain words. It is deliberately not dismissible: the app
// is in a state where any main-process call may behave as it did twenty
// minutes ago, and hiding that just moves the confusion later.

import React, { useCallback, useEffect, useState } from 'react'

const POLL_MS = 5000

export function StaleBuildBanner(): React.JSX.Element | null {
  const [changed, setChanged] = useState<string[]>([])

  // Fetch and apply are split so setState lands in a .then callback rather
  // than the effect body — react-hooks/set-state-in-effect.
  const fetchStatus = useCallback(async (): Promise<string[] | null> => {
    try {
      const status = await window.api.buildStatus()
      return status?.stale ? status.changed : []
    } catch {
      // An older preload has no buildStatus at all — which is itself the
      // condition this component exists to report, but there is nothing to
      // compare against, so stay quiet rather than cry wolf.
      return null
    }
  }, [])

  const refresh = useCallback(() => {
    void fetchStatus().then((next) => {
      if (next !== null) setChanged(next)
    })
  }, [fetchStatus])

  useEffect(() => {
    // Production bundles cannot change under a running process.
    if (!import.meta.env.DEV) return
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  if (changed.length === 0) return null

  const what = changed.join(' and ')

  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '7px 16px',
        background: '#3a2a12',
        borderBottom: '0.5px solid #6a4a1a',
        color: '#e8c98a',
        fontSize: '12px',
        flexShrink: 0
      }}
    >
      <span aria-hidden>⚠</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        The <strong style={{ fontWeight: 600 }}>{what}</strong>{' '}
        {changed.length === 1 ? 'bundle has' : 'bundles have'} been rebuilt since this window
        opened. Quit and restart — a reload will not pick{' '}
        {changed.length === 1 ? 'it' : 'them'} up.
      </span>
      <span style={{ color: '#a08650', fontSize: '11px', flexShrink: 0 }}>⌘Q, then npm run dev</span>
    </div>
  )
}
