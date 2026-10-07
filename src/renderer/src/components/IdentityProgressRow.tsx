import React, { useEffect, useState } from 'react'

// A quiet one-line status for the track-identity backfill: only on screen
// while it is running, no bar except for the quick tag-reading pass, and
// nothing to dismiss or cancel — it pauses itself during imports.
function label(s: IdentityStatus): string {
  const { total, tagsPending, fingerprintPending, lookupPending } = s.progress
  if (s.phase === 'tags') {
    return `Reading track info — ${total - tagsPending} of ${total}`
  }
  if (s.phase === 'fingerprint') {
    return `Identifying tracks — ${fingerprintPending.toLocaleString()} left`
  }
  return `Matching tracks online — ${lookupPending.toLocaleString()} left`
}

export function IdentityProgressRow(): React.JSX.Element | null {
  const [status, setStatus] = useState<IdentityStatus | null>(null)

  useEffect(() => {
    window.api.identity.onProgress(setStatus)
    return () => window.api.identity.offProgress()
  }, [])

  if (!status || !status.active) return null

  const showBar = status.phase === 'tags' && status.progress.total > 0
  const pct = showBar
    ? Math.round(
        ((status.progress.total - status.progress.tagsPending) / status.progress.total) * 100
      )
    : 0

  return (
    <div style={{ marginBottom: '1rem' }} data-testid="identity-progress">
      <div style={{ color: '#555', marginBottom: showBar ? '4px' : 0, fontSize: '11px' }}>
        {label(status)}
      </div>
      {showBar && (
        <div
          style={{ background: '#1e1e2a', borderRadius: '4px', height: '3px', overflow: 'hidden' }}
        >
          <div
            style={{
              background: '#3a3a55',
              height: '100%',
              width: `${pct}%`,
              transition: 'width 0.2s ease'
            }}
          />
        </div>
      )}
    </div>
  )
}
