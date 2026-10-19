// ── Tap tempo, beside the edit modal's hero BPM ───────────────────────────
// Tap (button, Space while armed, or T) to measure a tempo by hand; ÷2 and ×2
// fix a half/double-time reading. Taps only change a draft shown in the hero
// number: nothing is saved until "Save BPM", which goes through the modal's
// own save. The math lives in lib/tapTempo.ts.
//
// Space is the app's play/pause key (PlayerBar), so tap tempo takes it only
// while ARMED: armed when the Tap button is clicked or focused, disarmed on
// Esc, when it loses focus, when the window blurs, or when the modal closes.
// The listener is on window in the capture phase, so it sees Space before
// the PlayerBar's document listener; it stops the event there, and PlayerBar
// also checks useTapTempoStore. Keys are left alone while typing in a field.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Bpm } from './Bpm'
import { bpmColor, formatBpm } from '../lib/bpm'
import {
  EMPTY_TAPS,
  acceptsTapKey,
  doubleTime,
  halfTime,
  isStale,
  tap,
  type TapState
} from '../lib/tapTempo'
import { isTypingTarget, matchesShortcut, useTapTempoStore } from '../lib/shortcuts'

interface TapTempoProps {
  storedBpm: number | null | undefined
  draft: number | null
  onDraft: (bpm: number | null) => void
  onSave: (bpm: number) => void
  saving: boolean
  analyzing: boolean
}

const glowColor = (c: string, pct: number): string =>
  `color-mix(in srgb, ${c} ${pct}%, transparent)`

export function TapTempo({
  storedBpm,
  draft,
  onDraft,
  onSave,
  saving,
  analyzing
}: TapTempoProps): React.JSX.Element {
  const armed = useTapTempoStore((s) => s.armed)
  const setArmed = useTapTempoStore((s) => s.setArmed)
  const taps = useRef<TapState>(EMPTY_TAPS)
  const [tapCount, setTapCount] = useState(0)

  // The latest onDraft, for the window listener (registered once).
  const onDraftRef = useRef(onDraft)
  useEffect(() => {
    onDraftRef.current = onDraft
  }, [onDraft])

  const doTap = useCallback((): void => {
    const now = performance.now()
    if (isStale(taps.current, now)) taps.current = EMPTY_TAPS
    const result = tap(taps.current, now)
    taps.current = result.state
    setTapCount(result.state.taps.length)
    if (result.bpm !== null) onDraftRef.current(result.bpm)
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return
      const isArmed = useTapTempoStore.getState().armed
      if (isArmed && e.key === 'Escape') {
        // Disarm only; the modal stays open.
        e.preventDefault()
        e.stopPropagation()
        setArmed(false)
        return
      }
      if (isArmed && matchesShortcut(e, 'tapArmed')) {
        e.preventDefault()
        e.stopPropagation()
        if (acceptsTapKey(e)) doTap()
        return
      }
      if (matchesShortcut(e, 'tap')) {
        e.preventDefault()
        e.stopPropagation()
        if (acceptsTapKey(e)) doTap()
      }
    }
    // A focused button activates on Space keyup; armed, that press was a tap.
    const onKeyUp = (e: KeyboardEvent): void => {
      if (
        useTapTempoStore.getState().armed &&
        matchesShortcut(e, 'tapArmed') &&
        !isTypingTarget(e.target)
      ) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    const onBlur = (): void => setArmed(false)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      // Modal closed (or moved to another track): never leave Space taken.
      setArmed(false)
    }
  }, [setArmed, doTap])

  const shown = draft ?? storedBpm ?? null
  const live = draft ?? (typeof storedBpm === 'number' ? storedBpm : null)
  const color = bpmColor(live)
  const unsaved = draft !== null && draft !== storedBpm

  function startOver(): void {
    taps.current = EMPTY_TAPS
    setTapCount(0)
    onDraft(null)
  }

  return (
    <div
      data-testid="tap-tempo"
      data-armed={armed ? 'true' : 'false'}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        padding: '6px 10px',
        borderRadius: '10px',
        border: `1px solid ${armed ? color : 'transparent'}`,
        boxShadow: armed ? `0 0 18px ${glowColor(color, 45)}` : 'none'
      }}
    >
      <Bpm size="modal" value={shown} busy={analyzing} testId="edit-modal-bpm" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '96px' }}>
        <div
          style={{
            fontSize: '10px',
            fontWeight: 700,
            letterSpacing: '0.14em',
            color: armed ? color : '#55556a',
            height: '12px'
          }}
        >
          {armed ? 'TAPPING' : unsaved ? 'NOT SAVED' : ''}
        </div>
        <button
          type="button"
          data-testid="tap-tempo-button"
          aria-pressed={armed}
          aria-label="Tap tempo. Space or T taps while this is armed; Escape stops."
          title="Click, then tap Space or T in time. Esc stops."
          onFocus={() => setArmed(true)}
          onBlur={() => setArmed(false)}
          onClick={(e) => {
            // Keyboard activation (detail 0) is already a tap from the key
            // listener; only a real click taps here.
            if (e.detail === 0) return
            setArmed(true)
            doTap()
          }}
          style={{
            height: '34px',
            borderRadius: '8px',
            border: `1px solid ${armed ? color : '#2a2a3a'}`,
            background: armed ? glowColor(color, 18) : '#1a1a26',
            color: armed ? '#fff' : '#c0c0d8',
            fontSize: '12px',
            fontWeight: 700,
            letterSpacing: '0.1em',
            cursor: 'pointer'
          }}
        >
          TAP{tapCount > 1 ? ` · ${tapCount}` : ''}
        </button>
        <div style={{ display: 'flex', gap: '6px' }}>
          <SmallButton
            label="÷2"
            title="Half time"
            disabled={live === null}
            onClick={() => live !== null && onDraft(halfTime(live))}
          />
          <SmallButton
            label="×2"
            title="Double time"
            disabled={live === null}
            onClick={() => live !== null && onDraft(doubleTime(live))}
          />
        </div>
        {unsaved && (
          <div style={{ display: 'flex', gap: '6px' }}>
            <SmallButton
              label={saving ? 'Saving…' : 'Save BPM'}
              title="Save this tempo to the track"
              primary
              disabled={saving}
              onClick={() => draft !== null && onSave(draft)}
              testId="tap-tempo-save"
            />
            <SmallButton label="Reset" title="Discard the tapped tempo" onClick={startOver} />
          </div>
        )}
      </div>

      {/* Announced politely as the tempo settles. */}
      <div
        aria-live="polite"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap'
        }}
      >
        {draft !== null ? `Tapped tempo ${formatBpm(draft)} BPM` : ''}
      </div>
    </div>
  )
}

function SmallButton({
  label,
  title,
  onClick,
  disabled = false,
  primary = false,
  testId
}: {
  label: string
  title: string
  onClick: () => void
  disabled?: boolean
  primary?: boolean
  testId?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        flex: 1,
        height: '24px',
        borderRadius: '6px',
        border: `0.5px solid ${primary ? '#7f77dd' : '#2a2a3a'}`,
        background: primary ? '#7f77dd' : '#1a1a26',
        color: primary ? '#fff' : '#c0c0d8',
        fontSize: '11px',
        fontWeight: 600,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1
      }}
    >
      {label}
    </button>
  )
}
