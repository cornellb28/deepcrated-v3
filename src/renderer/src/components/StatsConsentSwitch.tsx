import React, { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { SwitchButton } from './SwitchButton'
import { PRIVACY_URL, STATS_CONSENT_COPY } from '../lib/privacy'

// Opt-in switch for anonymous stats. Off until the user turns it on. The
// renderer only reads and requests the state; what is collected, and whether
// it is, is decided in the main process.
export function StatsConsentSwitch(): React.JSX.Element {
  const [enabled, setEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api.privacy.getConsent().then((state) => {
      if (cancelled) return
      setEnabled(state.enabled)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function toggle(): Promise<void> {
    if (busy || !loaded) return
    setBusy(true)
    const next = !enabled
    const result = await window.api.privacy.setConsent(next)
    setBusy(false)
    if (result.ok && result.state) setEnabled(result.state.enabled)
    else toast.error('Could not change this setting', { description: result.error })
  }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
      <SwitchButton
        checked={enabled}
        disabled={!loaded || busy}
        labelledBy="stats-consent-label"
        testId="stats-consent-switch"
        onClick={() => void toggle()}
      />
      <div>
        <div id="stats-consent-label" style={{ fontSize: '12px', color: '#c0c0d8' }}>
          Contribute anonymous stats
        </div>
        <div style={{ fontSize: '11px', color: '#555', lineHeight: 1.6, marginTop: '2px' }}>
          {STATS_CONSENT_COPY}{' '}
          <a
            href={PRIVACY_URL}
            onClick={(e) => {
              e.preventDefault()
              void window.api.openExternal(PRIVACY_URL)
            }}
            style={{ color: '#7f77dd' }}
          >
            Learn more
          </a>
        </div>
      </div>
    </div>
  )
}
