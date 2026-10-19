import React, { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { Slider } from '@renderer/components/ui/slider'
import {
  applyGigPreset,
  DEFAULT_PROFILE,
  normalizeProfile,
  rebalanceTagWeights,
  TAG_TYPES,
  type MixProfile,
  type TagType
} from '../../../shared/trackMatch'
import { SURVEY_STEPS, TAG_LABELS } from '../lib/mixProfileLabels'

// The Mix Profile survey: six questions, one per screen, each skippable,
// then a live preview built from the DJ's own library. Opened from the
// first-launch prompt (MixProfilePrompt) and Settings > Mixing. The answers
// tune Track Match (Inspector > Related); they live in DeepCrated's database
// and never in audio tags.

interface Option<T> {
  value: T
  label: string
  detail?: string
}

const KEY_OPTIONS: Option<MixProfile['keyMode']>[] = [
  { value: 'strict', label: 'Strict Camelot', detail: 'Same key, ±1, or the relative major/minor' },
  { value: 'flexible', label: 'Flexible', detail: 'Also ±2 and energy-boost jumps' },
  { value: 'loose', label: "Key doesn't matter much" }
]
const BPM_OPTIONS: Option<MixProfile['bpmWindow']>[] = [
  { value: 3, label: '±3 BPM' },
  { value: 6, label: '±6 BPM' },
  { value: 10, label: '±10 BPM' },
  { value: 'wide', label: 'Wide', detail: '±16 BPM' }
]
const ENERGY_OPTIONS: Option<MixProfile['energyMovement']>[] = [
  { value: 'gradual', label: 'Build gradually' },
  { value: 'swings', label: 'Allow big swings' },
  { value: 'manual', label: 'I control energy myself' }
]
const GIG_OPTIONS: Option<NonNullable<MixProfile['gig']>>[] = [
  { value: 'club', label: 'Club' },
  { value: 'open', label: 'Open format' },
  { value: 'wedding', label: 'Wedding / event' },
  { value: 'radio', label: 'Radio / mixtape' }
]
const VARIETY_OPTIONS: Option<MixProfile['variety']>[] = [
  { value: 'same_ok', label: 'Same artist often is fine' },
  { value: 'favor_variety', label: 'Favor variety' }
]

const QUESTIONS = [
  'How strict are you about key?',
  'How far can the tempo move?',
  'How do you move energy?',
  'What do you play?',
  'Artists back to back?',
  'What matters most in your tags?'
]

interface SurveyProps {
  open: boolean
  initialProfile: MixProfile | null
  startStep?: number
  // From the first-launch prompt: "Skip survey" saves the defaults.
  onboarding?: boolean
  onClose: () => void
  onSaved: (stored: StoredMixProfile) => void
}

// The dialog shell. Its content unmounts whenever it closes, so every open
// starts fresh from what is stored and the step asked for.
export function MixProfileSurvey(props: SurveyProps): React.JSX.Element {
  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent
        data-testid="mix-profile-survey"
        style={{
          background: '#13131b',
          border: '0.5px solid #1e1e2a',
          borderRadius: '12px',
          maxWidth: '480px',
          width: '100%',
          color: '#e8e8f0',
          padding: '20px'
        }}
      >
        <SurveyBody {...props} />
      </DialogContent>
    </Dialog>
  )
}

function SurveyBody({
  initialProfile,
  startStep = 0,
  onboarding = false,
  onClose,
  onSaved
}: SurveyProps): React.JSX.Element {
  const [step, setStep] = useState(startStep)
  const [draft, setDraft] = useState<MixProfile>(() =>
    normalizeProfile(initialProfile ?? DEFAULT_PROFILE)
  )
  const [saving, setSaving] = useState(false)

  const set = <K extends keyof MixProfile>(key: K, value: MixProfile[K]): void =>
    setDraft((d) => ({ ...d, [key]: value }))

  async function save(state: 'completed' | 'skipped', profile: MixProfile): Promise<void> {
    setSaving(true)
    const res = await window.api.mixProfile.save(profile as MixProfileAnswers, state)
    setSaving(false)
    if (!res.ok || !res.profile) {
      toast.error('Could not save your mixing preferences', { description: res.error })
      return
    }
    onSaved(res as StoredMixProfile)
    onClose()
  }

  const next = (): void => setStep((s) => Math.min(SURVEY_STEPS, s + 1))
  const back = (): void => setStep((s) => Math.max(0, s - 1))

  return (
    <>
      <div
        style={{
          fontSize: '10px',
          color: '#555',
          letterSpacing: '0.8px',
          textTransform: 'uppercase'
        }}
      >
        Mixing preferences {step < SURVEY_STEPS ? `· ${step + 1} of ${SURVEY_STEPS}` : '· Preview'}
      </div>
      <DialogTitle style={{ fontSize: '16px', fontWeight: 500, margin: '6px 0 14px' }}>
        {step < SURVEY_STEPS ? QUESTIONS[step] : 'Here is what we would suggest'}
      </DialogTitle>

      {step === 0 && (
        <Choices options={KEY_OPTIONS} value={draft.keyMode} onPick={(v) => set('keyMode', v)} />
      )}
      {step === 1 && (
        <>
          <Choices
            options={BPM_OPTIONS}
            value={draft.bpmWindow}
            onPick={(v) => set('bpmWindow', v)}
          />
          <label
            style={{
              display: 'flex',
              gap: '8px',
              alignItems: 'center',
              marginTop: '12px',
              fontSize: '12px',
              color: '#c0c0d8'
            }}
          >
            <input
              type="checkbox"
              data-testid="survey-half-double"
              checked={draft.halfDouble}
              onChange={(e) => set('halfDouble', e.target.checked)}
            />
            Allow half / double time (e.g. 70 BPM with 140)
          </label>
        </>
      )}
      {step === 2 && (
        <>
          <Choices
            options={ENERGY_OPTIONS}
            value={draft.energyMovement}
            onPick={(v) => set('energyMovement', v)}
          />
          <p style={{ fontSize: '11px', color: '#555', marginTop: '10px', lineHeight: 1.5 }}>
            Energy is the 1–10 value you set in the Inspector. Tracks without it are matched on key,
            BPM and tags.
          </p>
        </>
      )}
      {step === 3 && (
        <>
          <Choices
            options={GIG_OPTIONS}
            value={draft.gig ?? undefined}
            onPick={(v) => setDraft((d) => applyGigPreset(d, v))}
          />
          <p style={{ fontSize: '11px', color: '#555', marginTop: '10px', lineHeight: 1.5 }}>
            This fills in sensible key, tempo, energy and variety answers. Go back to change any of
            them.
          </p>
        </>
      )}
      {step === 4 && (
        <Choices
          options={VARIETY_OPTIONS}
          value={draft.variety}
          onPick={(v) => set('variety', v)}
        />
      )}
      {step === 5 && (
        <TagPoints
          weights={draft.tagWeights}
          onChange={(type, value) =>
            set('tagWeights', rebalanceTagWeights(draft.tagWeights, type, value))
          }
        />
      )}
      {step === SURVEY_STEPS && <Preview draft={draft} />}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: '18px'
        }}
      >
        <div>
          {onboarding && (
            <SurveyButton
              quiet
              testId="survey-skip-all"
              disabled={saving}
              onClick={() => void save('skipped', DEFAULT_PROFILE)}
            >
              Skip survey
            </SurveyButton>
          )}
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {step > 0 && (
            <SurveyButton quiet onClick={back} testId="survey-back">
              Back
            </SurveyButton>
          )}
          {step < SURVEY_STEPS && (
            <SurveyButton quiet onClick={next} testId="survey-skip-question">
              Skip
            </SurveyButton>
          )}
          {step < SURVEY_STEPS ? (
            <SurveyButton onClick={next} testId="survey-next">
              Next
            </SurveyButton>
          ) : (
            <SurveyButton
              testId="survey-save"
              disabled={saving}
              onClick={() => void save('completed', draft)}
            >
              Save preferences
            </SurveyButton>
          )}
        </div>
      </div>
    </>
  )
}

function Choices<T extends string | number>({
  options,
  value,
  onPick
}: {
  options: Option<T>[]
  value: T | undefined
  onPick: (value: T) => void
}): React.JSX.Element {
  return (
    <div role="radiogroup" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onPick(o.value)}
            style={{
              textAlign: 'left',
              padding: '9px 12px',
              borderRadius: '8px',
              border: `0.5px solid ${on ? '#7f77dd' : '#252535'}`,
              background: on ? '#7f77dd22' : '#1a1a26',
              color: '#e8e8f0',
              cursor: 'pointer',
              fontFamily: 'inherit'
            }}
          >
            <div style={{ fontSize: '13px' }}>{o.label}</div>
            {o.detail && (
              <div style={{ fontSize: '11px', color: '#777', marginTop: '2px' }}>{o.detail}</div>
            )}
          </button>
        )
      })}
    </div>
  )
}

function TagPoints({
  weights,
  onChange
}: {
  weights: MixProfile['tagWeights']
  onChange: (type: TagType, value: number) => void
}): React.JSX.Element {
  const total = TAG_TYPES.reduce((a, t) => a + weights[t], 0)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ fontSize: '11px', color: '#777' }}>
        Spread 100 points. Moving one slider adjusts the others. Total: {total}
      </div>
      {TAG_TYPES.map((t) => (
        <div
          key={t}
          style={{
            display: 'grid',
            gridTemplateColumns: '84px 1fr 32px',
            gap: '10px',
            alignItems: 'center'
          }}
        >
          <span style={{ fontSize: '12px', color: '#c0c0d8' }}>{TAG_LABELS[t]}</span>
          <Slider
            data-testid={`survey-tag-${t}`}
            min={0}
            max={100}
            step={5}
            value={[weights[t]]}
            onValueChange={(v) => onChange(t, v[0])}
          />
          <span style={{ fontSize: '12px', color: '#a09be8', textAlign: 'right' }}>
            {weights[t]}
          </span>
        </div>
      ))}
    </div>
  )
}

function Preview({ draft }: { draft: MixProfile }): React.JSX.Element {
  const [data, setData] = useState<Awaited<ReturnType<Window['api']['match']['preview']>> | null>(
    null
  )

  useEffect(() => {
    let cancelled = false
    void window.api.match.preview(draft as MixProfileAnswers).then((d) => {
      if (!cancelled) setData(d)
    })
    return () => {
      cancelled = true
    }
  }, [draft])

  if (!data) return <div style={{ fontSize: '12px', color: '#555' }}>Finding matches…</div>
  if (!data.source || !data.result) {
    return (
      <div style={{ fontSize: '12px', color: '#777' }}>
        Import some tracks with a key and BPM to preview suggestions. You can save now and come
        back.
      </div>
    )
  }
  const items = data.result.status === 'ok' ? data.result.results.slice(0, 5) : []
  return (
    <div data-testid="survey-preview">
      <div style={{ fontSize: '12px', color: '#777', marginBottom: '10px' }}>
        After <span style={{ color: '#e8e8f0' }}>{data.source.title ?? 'Untitled'}</span>
        {data.source.artist ? ` — ${data.source.artist}` : ''}, we&apos;d suggest:
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: '12px', color: '#777' }}>
          Nothing fits these answers. Go back and widen the key or tempo rules.
        </div>
      ) : (
        <ol
          style={{
            margin: 0,
            paddingLeft: '18px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px'
          }}
        >
          {items.map((r) => (
            <li key={r.id} style={{ fontSize: '12px', color: '#c0c0d8' }}>
              {r.title ?? 'Untitled'}
              {r.artist ? <span style={{ color: '#666' }}> — {r.artist}</span> : null}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '3px' }}>
                {r.reasons.map((reason) => (
                  <span
                    key={reason}
                    style={{
                      fontSize: '10px',
                      color: '#a09be8',
                      background: '#7f77dd22',
                      borderRadius: '4px',
                      padding: '1px 5px'
                    }}
                  >
                    {reason}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function SurveyButton({
  children,
  onClick,
  quiet = false,
  disabled = false,
  testId
}: {
  children: React.ReactNode
  onClick: () => void
  quiet?: boolean
  disabled?: boolean
  testId?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      style={{
        fontSize: '12px',
        padding: '6px 14px',
        borderRadius: '6px',
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'inherit',
        opacity: disabled ? 0.5 : 1,
        border: quiet ? '0.5px solid #252535' : '0.5px solid #7f77dd',
        background: quiet ? 'transparent' : '#7f77dd',
        color: quiet ? '#888' : '#fff'
      }}
    >
      {children}
    </button>
  )
}
