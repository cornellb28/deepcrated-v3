import React, { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { SwitchButton } from './SwitchButton'
import { Button } from '@renderer/components/ui/button'
import { ArtistCleanDialog } from './ArtistCleanDialog'

// app_settings keys read by main/artist/service.ts. Auto-clean is ON unless
// explicitly set to 'false'; suggest-only is OFF unless set to 'true'.
const ENABLED_KEY = 'artist_clean_enabled'
const SUGGEST_ONLY_KEY = 'artist_clean_suggest_only'

export function ArtistCleanSettings(): React.JSX.Element {
  const [enabled, setEnabled] = useState(true)
  const [suggestOnly, setSuggestOnly] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [dialog, setDialog] = useState<'review' | 'reclean' | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.api.settings.get(ENABLED_KEY),
      window.api.settings.get(SUGGEST_ONLY_KEY)
    ]).then(([e, s]) => {
      if (cancelled) return
      setEnabled(e !== 'false')
      setSuggestOnly(s === 'true')
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function save(key: string, value: boolean, apply: (v: boolean) => void): Promise<void> {
    const r = await window.api.settings.set(key, String(value))
    if (r.ok) apply(value)
    else toast.error('Could not change this setting', { description: r.error })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
        <SwitchButton
          checked={enabled}
          disabled={!loaded}
          labelledBy="artist-clean-label"
          testId="artist-clean-enabled"
          onClick={() => void save(ENABLED_KEY, !enabled, setEnabled)}
        />
        <div>
          <div id="artist-clean-label" style={{ fontSize: '12px', color: '#c0c0d8' }}>
            Auto-clean on import
          </div>
          <div style={{ fontSize: '11px', color: '#555', lineHeight: 1.6, marginTop: '2px' }}>
            Names that match an artist you already have (differing only in case, punctuation or a
            leading &quot;The&quot;) are changed to match, in the file too. Anything less certain is
            offered for review instead.
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '12px',
          opacity: enabled ? 1 : 0.5
        }}
      >
        <SwitchButton
          checked={suggestOnly}
          disabled={!loaded || !enabled}
          labelledBy="artist-suggest-label"
          testId="artist-clean-suggest-only"
          onClick={() => void save(SUGGEST_ONLY_KEY, !suggestOnly, setSuggestOnly)}
        />
        <div>
          <div id="artist-suggest-label" style={{ fontSize: '12px', color: '#c0c0d8' }}>
            Suggest only
          </div>
          <div style={{ fontSize: '11px', color: '#555', lineHeight: 1.6, marginTop: '2px' }}>
            Never change anything automatically. Every suggestion waits for you in Review.
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px' }}>
        <Button size="sm" variant="outline" onClick={() => setDialog('review')}>
          Review suggestions
        </Button>
        <Button size="sm" variant="outline" onClick={() => setDialog('reclean')}>
          Re-clean library…
        </Button>
      </div>

      <ArtistCleanDialog
        open={dialog !== null}
        initialTab={dialog ?? 'review'}
        onClose={() => setDialog(null)}
      />
    </div>
  )
}
