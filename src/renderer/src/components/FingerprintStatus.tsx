import React, { useEffect, useState } from 'react'

// One read-only line under Track identification: whether this machine can
// make audio fingerprints, and with which fpcalc. Local only — it says
// nothing about the online lookup, which has its own switch below.
export function FingerprintStatus(): React.JSX.Element {
  const [status, setStatus] = useState<IdentityStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.identity.getStatus().then((s) => {
      if (!cancelled) setStatus(s)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div
      data-testid="fingerprint-status"
      style={{ fontSize: '12px', color: '#c0c0d8', marginBottom: '12px' }}
    >
      Fingerprinting:{' '}
      <span style={{ color: status?.fingerprintAvailable ? '#1d9e75' : '#888' }}>
        {describe(status)}
      </span>
    </div>
  )
}

function describe(status: IdentityStatus | null): string {
  if (!status) return 'Checking…'
  if (!status.fingerprintAvailable) return 'Not available'
  const where = status.fingerprintSource === 'bundled' ? 'bundled' : 'system'
  const version = status.fingerprintVersion ? `, v${status.fingerprintVersion}` : ''
  return `Available (${where}${version})`
}
