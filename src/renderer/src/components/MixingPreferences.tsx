import React, { useEffect, useState } from 'react'
import { TAG_TYPES, type MixProfile } from '../../../shared/trackMatch'
import { MixProfileSurvey } from './MixProfileSurvey'
import { TAG_LABELS } from '../lib/mixProfileLabels'

// Settings > Mixing: the Mix Profile at a glance, each answer editable on its
// own (opens the survey at that question) or the whole survey retaken.

const KEY_TEXT: Record<MixProfile['keyMode'], string> = {
  strict: 'Strict Camelot',
  flexible: 'Flexible',
  loose: "Key doesn't matter much"
}
const ENERGY_TEXT: Record<MixProfile['energyMovement'], string> = {
  gradual: 'Build gradually',
  swings: 'Allow big swings',
  manual: 'I control energy myself'
}
const GIG_TEXT: Record<NonNullable<MixProfile['gig']>, string> = {
  club: 'Club',
  open: 'Open format',
  wedding: 'Wedding / event',
  radio: 'Radio / mixtape'
}

function bpmText(p: MixProfile): string {
  const w = p.bpmWindow === 'wide' ? 'Wide (±16)' : `±${p.bpmWindow} BPM`
  return `${w}${p.halfDouble ? ', half/double time on' : ''}`
}

export function MixingPreferences(): React.JSX.Element {
  const [stored, setStored] = useState<StoredMixProfile | null>(null)
  const [surveyStep, setSurveyStep] = useState<number | null>(null)

  useEffect(() => {
    void window.api.mixProfile.get().then(setStored)
  }, [])

  if (!stored) return <div style={{ fontSize: '12px', color: '#555' }}>Loading…</div>
  const p = stored.profile as MixProfile

  const rows: { label: string; value: string; step: number }[] = [
    { label: 'Key', value: KEY_TEXT[p.keyMode], step: 0 },
    { label: 'Tempo', value: bpmText(p), step: 1 },
    { label: 'Energy', value: ENERGY_TEXT[p.energyMovement], step: 2 },
    { label: 'You play', value: p.gig ? GIG_TEXT[p.gig] : 'Not set', step: 3 },
    {
      label: 'Variety',
      value: p.variety === 'favor_variety' ? 'Favor variety' : 'Same artist often is fine',
      step: 4
    },
    {
      label: 'Tag priorities',
      value: TAG_TYPES.map((t) => `${TAG_LABELS[t]} ${p.tagWeights[t]}`).join(' · '),
      step: 5
    }
  ]

  return (
    <div
      data-testid="mixing-preferences"
      style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
    >
      <div style={{ fontSize: '11px', color: '#555' }}>
        {stored.state === 'completed'
          ? 'From your survey answers.'
          : 'Using the defaults — take the survey to tune them.'}
      </div>
      {rows.map((r) => (
        <div
          key={r.label}
          style={{
            display: 'grid',
            gridTemplateColumns: '96px 1fr auto',
            gap: '10px',
            alignItems: 'baseline'
          }}
        >
          <span style={{ fontSize: '11px', color: '#555' }}>{r.label}</span>
          <span style={{ fontSize: '12px', color: '#c0c0d8' }}>{r.value}</span>
          <button
            type="button"
            onClick={() => setSurveyStep(r.step)}
            style={{
              background: 'none',
              border: 'none',
              color: '#7f77dd',
              fontSize: '11px',
              cursor: 'pointer',
              padding: 0,
              fontFamily: 'inherit'
            }}
          >
            Edit
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          data-testid="mixing-retake"
          onClick={() => setSurveyStep(0)}
          style={{
            marginTop: '6px',
            fontSize: '12px',
            padding: '5px 12px',
            borderRadius: '6px',
            border: '0.5px solid #7f77dd',
            background: 'transparent',
            color: '#a09be8',
            cursor: 'pointer',
            fontFamily: 'inherit'
          }}
        >
          {stored.state === 'completed' ? 'Retake the survey' : 'Take the survey'}
        </button>
      </div>
      <MixProfileSurvey
        open={surveyStep !== null}
        startStep={surveyStep ?? 0}
        initialProfile={p}
        onClose={() => setSurveyStep(null)}
        onSaved={setStored}
      />
    </div>
  )
}
