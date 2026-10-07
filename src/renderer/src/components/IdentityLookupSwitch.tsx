import React, { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { SwitchButton } from './SwitchButton'
import { IDENTITY_LOOKUP_COPY, IDENTITY_LOOKUP_KEY } from '../lib/privacy'

// Optional online track identification. OFF unless the user turns it on,
// because it sends audio fingerprints (and the user's IP) to AcoustID and
// MusicBrainz. It is separate from the stats consent: it is not stats.
export function IdentityLookupSwitch(): React.JSX.Element {
  const [enabled, setEnabled] = useState(false)
  const [available, setAvailable] = useState(true)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.api.settings.get(IDENTITY_LOOKUP_KEY),
      window.api.identity.getStatus()
    ]).then(([stored, status]) => {
      if (cancelled) return
      setEnabled(stored === 'true')
      setAvailable(status.lookupAvailable)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function toggle(): Promise<void> {
    const next = !enabled
    const result = await window.api.settings.set(IDENTITY_LOOKUP_KEY, String(next))
    if (!result.ok) {
      toast.error('Could not change this setting', { description: result.error })
      return
    }
    setEnabled(next)
    // Start matching straight away rather than at the next scheduled run.
    if (next) void window.api.identity.kick()
  }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
      <SwitchButton
        checked={enabled && available}
        disabled={!loaded || !available}
        labelledBy="identity-lookup-label"
        testId="identity-lookup-switch"
        onClick={() => void toggle()}
      />
      <div>
        <div id="identity-lookup-label" style={{ fontSize: '12px', color: '#c0c0d8' }}>
          Identify tracks online
        </div>
        <div style={{ fontSize: '11px', color: '#555', lineHeight: 1.6, marginTop: '2px' }}>
          {available ? IDENTITY_LOOKUP_COPY : 'Not available in this build.'}
        </div>
      </div>
    </div>
  )
}
