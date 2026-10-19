import React, { useEffect, useRef, useState } from 'react'
import { useLibraryStore } from '../store/useLibraryStore'
import { DEFAULT_PROFILE } from '../../../shared/trackMatch'
import { MixProfileSurvey } from './MixProfileSurvey'

// First launch with a library: a one-time, dismissible prompt offering the
// Mix Profile survey. Shown only while no profile has ever been saved; any
// way out ("Not now", or closing the survey without saving) stores the
// defaults as 'skipped', so it never comes back. Settings > Mixing is where
// the survey can be retaken.

export function MixProfilePrompt(): React.JSX.Element | null {
  const hasTracks = useLibraryStore((s) => s.tracks.length > 0)
  const [show, setShow] = useState(false)
  const [surveyOpen, setSurveyOpen] = useState(false)
  const saved = useRef(false)
  const checked = useRef(false)

  useEffect(() => {
    if (!hasTracks || checked.current) return
    checked.current = true
    void window.api.mixProfile.get().then((stored) => {
      if (stored.state === 'defaults') setShow(true)
    })
  }, [hasTracks])

  async function skip(): Promise<void> {
    if (saved.current) return
    saved.current = true
    setShow(false)
    await window.api.mixProfile.save(DEFAULT_PROFILE as MixProfileAnswers, 'skipped')
  }

  if (!show && !surveyOpen) return null

  return (
    <>
      {show && !surveyOpen && (
        <div
          role="dialog"
          aria-label="Set your mixing preferences"
          data-testid="mix-profile-prompt"
          style={{
            position: 'fixed',
            right: '20px',
            bottom: '84px',
            zIndex: 40,
            width: '300px',
            padding: '14px 16px',
            background: '#13131b',
            border: '0.5px solid #252535',
            borderRadius: '10px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)'
          }}
        >
          <div style={{ fontSize: '13px', color: '#e8e8f0', marginBottom: '4px' }}>
            Tune your track suggestions
          </div>
          <div style={{ fontSize: '11px', color: '#777', lineHeight: 1.5, marginBottom: '12px' }}>
            Six quick questions on how you mix — key, tempo, energy and tags — so Related suggests
            tracks the way you would.
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
            <button
              type="button"
              data-testid="mix-profile-prompt-skip"
              onClick={() => void skip()}
              style={promptButton(true)}
            >
              Not now
            </button>
            <button
              type="button"
              data-testid="mix-profile-prompt-start"
              onClick={() => setSurveyOpen(true)}
              style={promptButton(false)}
            >
              Take the survey
            </button>
          </div>
        </div>
      )}
      <MixProfileSurvey
        open={surveyOpen}
        initialProfile={null}
        onboarding
        onSaved={() => {
          saved.current = true
          setShow(false)
        }}
        onClose={() => {
          setSurveyOpen(false)
          // Closed without saving: still a one-time prompt.
          if (!saved.current) void skip()
        }}
      />
    </>
  )
}

function promptButton(quiet: boolean): React.CSSProperties {
  return {
    fontSize: '12px',
    padding: '5px 12px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    border: quiet ? '0.5px solid #252535' : '0.5px solid #7f77dd',
    background: quiet ? 'transparent' : '#7f77dd',
    color: quiet ? '#888' : '#fff'
  }
}
