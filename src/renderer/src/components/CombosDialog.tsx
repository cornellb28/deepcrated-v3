// ── Find combos ───────────────────────────────────────────────────────────
// "Mixes well with": every track in the library ranked against one, by key,
// BPM and the DJ's energy goal, each with the reasons it scored (main/
// comboService.ts → shared/combos.ts). Opened from a track's ⋮ menu or the
// Inspector. Controls are remembered (app_settings 'combo_settings').
// Clicking a result opens it in the Inspector; + puts the pair in a crate.

import React, { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { useLibraryStore } from '../store/useLibraryStore'
import { useCombosStore } from '../store/useCombosStore'
import { useArtworkUrl } from '../hooks/useArtworkUrl'
import { Bpm } from './Bpm'
import { CratePickerModal } from './CratePickerModal'
import {
  BPM_TOLERANCE_CHOICES,
  DEFAULT_COMBO_SETTINGS,
  normalizeComboSettings,
  type ComboSettings,
  type EnergyGoal,
  type KeyStrictness
} from '../../../shared/combos'

const SETTINGS_KEY = 'combo_settings'

const GOALS: { id: EnergyGoal; label: string; hint: string }[] = [
  { id: 'keep', label: 'Keep energy', hint: 'Within one step' },
  { id: 'build', label: 'Build', hint: 'One or two steps up' },
  { id: 'down', label: 'Bring down', hint: 'One or two steps down' }
]
const KEYS: { id: KeyStrictness; label: string; hint: string }[] = [
  { id: 'strict', label: 'Strict', hint: 'Same key, ±1, relative' },
  { id: 'flexible', label: 'Flexible', hint: 'Also ±2' },
  { id: 'any', label: 'Any', hint: 'Every key, clashing ones last' }
]

const muted: React.CSSProperties = { fontSize: '11px', color: '#6a6a80' }

// A small radio group with arrow keys, like the app's other segmented controls.
function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange
}: {
  label: string
  options: { id: T; label: string; hint?: string }[]
  value: T
  onChange: (v: T) => void
}): React.JSX.Element {
  const index = options.findIndex((o) => o.id === value)
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
        if (!d) return
        e.preventDefault()
        const next = options[(index + d + options.length) % options.length]
        onChange(next.id)
      }}
      style={{
        display: 'flex',
        background: '#13131b',
        border: '0.5px solid #252535',
        borderRadius: '6px',
        padding: '2px'
      }}
    >
      {options.map((o) => {
        const active = o.id === value
        return (
          <button
            key={String(o.id)}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            title={o.hint}
            onClick={() => onChange(o.id)}
            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#7f77dd]"
            style={{
              fontSize: '11px',
              padding: '3px 9px',
              borderRadius: '4px',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              background: active ? '#252535' : 'transparent',
              color: active ? '#e8e8f0' : '#8a8aa0'
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function CombosDialog(): React.JSX.Element {
  const trackId = useCombosStore((s) => s.trackId)
  const hide = useCombosStore((s) => s.hide)
  return (
    <Dialog open={trackId !== null} onOpenChange={(o) => !o && hide()}>
      <DialogContent
        data-testid="combos-dialog"
        style={{
          background: '#13131b',
          border: '0.5px solid #1e1e2a',
          borderRadius: '12px',
          maxWidth: '760px',
          width: '100%',
          color: '#e8e8f0',
          padding: '20px'
        }}
      >
        {trackId !== null && <CombosBody key={trackId} trackId={trackId} />}
      </DialogContent>
    </Dialog>
  )
}

function CombosBody({ trackId }: { trackId: number }): React.JSX.Element {
  const hide = useCombosStore((s) => s.hide)
  const setActiveTrack = useLibraryStore((s) => s.setActiveTrack)
  const [settings, setSettings] = useState<ComboSettings | null>(null)
  const [data, setData] = useState<CombosResponse | null>(null)
  const [crateIds, setCrateIds] = useState<number[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.settings.get(SETTINGS_KEY).then((raw) => {
      if (cancelled) return
      let parsed: unknown = null
      try {
        parsed = raw ? JSON.parse(raw) : null
      } catch {
        // A damaged value just means the defaults.
      }
      setSettings(normalizeComboSettings(parsed ?? DEFAULT_COMBO_SETTINGS))
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!settings) return
    let cancelled = false
    void window.api.combos.find(trackId, settings).then((r) => {
      if (!cancelled) setData(r)
    })
    return () => {
      cancelled = true
    }
  }, [trackId, settings])

  function update(patch: Partial<ComboSettings>): void {
    if (!settings) return
    const next = { ...settings, ...patch }
    setSettings(next)
    void window.api.settings.set(SETTINGS_KEY, JSON.stringify(next))
  }

  const source = data?.status === 'ok' ? data.source : null
  const results = data?.status === 'ok' ? data.results : []

  return (
    <>
      <DialogTitle style={{ fontSize: '15px', fontWeight: 500 }}>
        Mixes well with {source?.title ? `“${source.title}”` : 'this track'}
      </DialogTitle>
      <DialogDescription asChild>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', ...muted }}>
          {source && (
            <>
              <Bpm size="row" value={source.bpm} />
              <span>{source.key_camelot ?? 'no key'}</span>
              <span>{source.energy !== null ? `Energy ${source.energy}` : 'no energy rating'}</span>
              {source.missing.length > 0 && (
                <span style={{ color: '#ba7517' }}>
                  Matching without {source.missing.join(' or ')}
                </span>
              )}
            </>
          )}
        </div>
      </DialogDescription>

      {settings && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '10px',
            margin: '14px 0 10px'
          }}
        >
          <Segmented
            label="Energy goal"
            options={GOALS}
            value={settings.goal}
            onChange={(goal) => update({ goal })}
          />
          <Segmented
            label="BPM tolerance"
            options={BPM_TOLERANCE_CHOICES.map((n) => ({ id: n as number, label: `±${n}%` }))}
            value={settings.bpmTolerancePct}
            onChange={(bpmTolerancePct) => update({ bpmTolerancePct })}
          />
          <Segmented
            label="Key strictness"
            options={KEYS}
            value={settings.keyStrictness}
            onChange={(keyStrictness) => update({ keyStrictness })}
          />
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              ...muted,
              cursor: 'pointer'
            }}
          >
            <input
              type="checkbox"
              checked={settings.halfDouble}
              onChange={(e) => update({ halfDouble: e.target.checked })}
            />
            Half/double time
          </label>
          <label
            title="Allow the +2 key move (8A → 10A)"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              ...muted,
              cursor: 'pointer'
            }}
          >
            <input
              type="checkbox"
              checked={settings.keyBoost}
              onChange={(e) => update({ keyBoost: e.target.checked })}
            />
            +2 energy boost
          </label>
        </div>
      )}

      <div
        aria-live="polite"
        style={{
          maxHeight: '440px',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px'
        }}
      >
        {data === null && <div style={muted}>Finding combos…</div>}
        {data?.status === 'not-found' && (
          <div style={muted}>This track is no longer in the library.</div>
        )}
        {data?.status === 'ok' && results.length === 0 && (
          <div style={muted}>
            Nothing fits these settings. Try a wider BPM tolerance or a looser key setting.
          </div>
        )}
        {results.map((r) => (
          <ComboRow
            key={r.id}
            item={r}
            onOpen={() => {
              setActiveTrack(r.id)
              hide()
            }}
            onCrate={() => setCrateIds([trackId, r.id])}
          />
        ))}
        {data?.status === 'ok' && results.length > 0 && (
          <div style={{ ...muted, padding: '4px 2px' }}>
            Top {results.length} of {data.considered.toLocaleString()} candidates that fit the key
            and BPM settings.
          </div>
        )}
      </div>

      <CratePickerModal
        trackIds={crateIds ?? []}
        open={crateIds !== null}
        onClose={() => setCrateIds(null)}
      />
    </>
  )
}

function ComboRow({
  item,
  onOpen,
  onCrate
}: {
  item: ComboItem
  onOpen: () => void
  onCrate: () => void
}): React.JSX.Element {
  const art = useArtworkUrl(item.artwork_hash, 'thumb')
  const pct = Math.round(item.score * 100)
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="combo-result"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen()
      }}
      className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#7f77dd]"
      style={{
        display: 'grid',
        gridTemplateColumns: '36px 1fr auto auto',
        gap: '10px',
        alignItems: 'center',
        padding: '6px 8px',
        background: '#1a1a26',
        border: '0.5px solid #252535',
        borderRadius: '6px',
        cursor: 'pointer'
      }}
    >
      <div
        style={{
          width: '36px',
          height: '36px',
          borderRadius: '4px',
          background: '#13131b',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#333'
        }}
      >
        {art ? (
          <img src={art} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          '♪'
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: '12px',
            color: '#e8e8f0',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {item.title ?? 'Untitled'}
          <span style={{ color: '#555' }}>{item.artist ? ` — ${item.artist}` : ''}</span>
          {item.partial && (
            <span
              title="Scored on the factors this track has"
              style={{
                marginLeft: '6px',
                fontSize: '9px',
                letterSpacing: '0.08em',
                color: '#ba7517',
                border: '0.5px solid #ba751766',
                borderRadius: '3px',
                padding: '0 4px'
              }}
            >
              PARTIAL
            </span>
          )}
        </div>
        <div style={{ fontSize: '10px', color: '#8a8aa0', marginTop: '2px' }}>
          {item.reasons.join(' · ')}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Bpm size="row" value={item.bpm} />
        <span style={{ fontSize: '10px', color: '#3db88a', minWidth: '24px' }}>
          {item.key_camelot ?? '—'}
        </span>
        <span style={{ fontSize: '10px', color: '#d4537e', minWidth: '22px' }}>
          {item.energy !== null ? `E${item.energy}` : 'E–'}
        </span>
        <span
          aria-label={`${pct} percent match`}
          style={{ fontSize: '11px', color: '#e8e8f0', minWidth: '34px', textAlign: 'right' }}
        >
          {pct}%
        </span>
      </div>
      <button
        type="button"
        title="Put both tracks in a crate"
        aria-label="Put both tracks in a crate"
        onClick={(e) => {
          e.stopPropagation()
          onCrate()
        }}
        style={{
          background: 'none',
          border: '0.5px solid #2a2a3a',
          borderRadius: '5px',
          color: '#c0c0d8',
          cursor: 'pointer',
          padding: '4px',
          display: 'flex'
        }}
      >
        <Plus size={12} />
      </button>
    </div>
  )
}
