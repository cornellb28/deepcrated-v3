// ── <Bpm>: the tempo, everywhere it is shown ──────────────────────────────
// BPM is the number a DJ reads first, so it is the loudest thing wherever it
// appears and deliberately breaks from the app's palette and type: a heavy
// monospaced figure in its tempo colour (lib/bpm.ts). Sizes:
//   row        a pill, the most prominent badge in a track row
//   compact    a stat cell, for track cards and crate grids
//   inspector  a large display number with a small "BPM" label
//   modal      the biggest, for the edit modal
// Figures are tabular so lists don't jitter, an empty tempo reads "—", and
// the tooltip/label names the band in words, so colour is never the only cue.
// No animation: the large sizes get a static glow only.

import React, { useState } from 'react'
import { bpmBandLabel, bpmColor, bpmNumber, formatBpm } from '../lib/bpm'

export type BpmSize = 'row' | 'compact' | 'inspector' | 'modal'

const BPM_FONT = '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace'

const FIGURE: Record<BpmSize, React.CSSProperties> = {
  row: { fontSize: '11px', fontWeight: 800 },
  compact: { fontSize: '15px', fontWeight: 800 },
  inspector: { fontSize: '38px', fontWeight: 800, letterSpacing: '-0.03em' },
  modal: { fontSize: '64px', fontWeight: 800, letterSpacing: '-0.04em' }
}

const LABEL_SIZE: Record<BpmSize, string> = {
  row: '0',
  compact: '8px',
  inspector: '10px',
  modal: '12px'
}

const tint = (color: string, pct: number): string =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`

interface BpmProps {
  value: number | string | null | undefined
  size: BpmSize
  // Inspector only: click the number to type a tempo; saved by onChange on
  // blur or Enter, exactly as the old BPM input did.
  editable?: boolean
  onChange?: (value: string) => void
  // Analysis running: shown instead of the number, not editable.
  busy?: boolean
  testId?: string
}

export function Bpm({
  value,
  size,
  editable = false,
  onChange,
  busy = false,
  testId
}: BpmProps): React.JSX.Element {
  const n = bpmNumber(value)
  const color = bpmColor(n)
  const text = busy ? '…' : formatBpm(n)
  const band = bpmBandLabel(n)
  const spoken = busy ? 'BPM: detecting' : n === null ? 'BPM not set' : `${text} BPM, ${band}`
  const large = size === 'inspector' || size === 'modal'

  const figure: React.CSSProperties = {
    ...FIGURE[size],
    fontFamily: BPM_FONT,
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1,
    color,
    textShadow: large && n !== null && !busy ? `0 0 22px ${tint(color, 45)}` : undefined
  }

  if (size === 'row') {
    return (
      <span
        data-testid={testId}
        title={n === null ? 'BPM not set' : `${text} BPM · ${band}`}
        aria-label={spoken}
        style={{
          ...figure,
          display: 'inline-flex',
          alignItems: 'center',
          height: '20px',
          padding: '0 7px',
          borderRadius: '999px',
          background: tint(color, 14),
          border: `1px solid ${tint(color, 45)}`,
          flexShrink: 0
        }}
      >
        {text}
      </span>
    )
  }

  if (size === 'compact') {
    return (
      <div
        data-testid={testId}
        title={n === null ? 'BPM not set' : `${text} BPM · ${band}`}
        aria-label={spoken}
        style={{
          minWidth: '52px',
          padding: '4px 8px',
          borderRadius: '5px',
          background: tint(color, 12),
          border: `1px solid ${tint(color, 40)}`,
          textAlign: 'center'
        }}
      >
        <div style={figure}>{text}</div>
        <Caption size={size} color={color} />
      </div>
    )
  }

  return (
    <div
      data-testid={testId}
      title={n === null ? undefined : `${text} BPM · ${band}`}
      style={{ display: 'flex', alignItems: 'baseline', gap: '6px', minWidth: 0 }}
    >
      {editable && !busy ? (
        <EditableFigure
          text={n === null ? '' : String(n)}
          display={text}
          style={figure}
          spoken={spoken}
          onCommit={(v) => onChange?.(v)}
          testId={testId ? `${testId}-input` : undefined}
        />
      ) : (
        <span style={figure} aria-label={spoken}>
          {text}
        </span>
      )}
      <Caption size={size} color={color} busy={busy} />
    </div>
  )
}

function Caption({
  size,
  color,
  busy = false
}: {
  size: BpmSize
  color: string
  busy?: boolean
}): React.JSX.Element {
  return (
    <div
      aria-hidden
      style={{
        fontSize: LABEL_SIZE[size],
        fontWeight: 700,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: tint(color, 75),
        marginTop: size === 'compact' ? '2px' : 0,
        fontFamily: BPM_FONT
      }}
    >
      {busy ? 'Detecting' : 'BPM'}
    </div>
  )
}

// The number until clicked, then an input in the same type. Commits on blur;
// Enter and Escape both leave the field (and so commit), as before.
function EditableFigure({
  text,
  display,
  style,
  spoken,
  onCommit,
  testId
}: {
  text: string
  display: string
  style: React.CSSProperties
  spoken: string
  onCommit: (value: string) => void
  testId?: string
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`${spoken}. Edit BPM`}
        title="Click to edit BPM"
        className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#7f77dd] rounded"
        style={{ ...style, background: 'none', border: 'none', padding: 0, cursor: 'text' }}
      >
        {display}
      </button>
    )
  }
  return (
    <input
      autoFocus
      data-testid={testId}
      aria-label="BPM"
      inputMode="decimal"
      defaultValue={text}
      onFocus={(e) => e.target.select()}
      onBlur={(e) => {
        setEditing(false)
        onCommit(e.target.value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
      }}
      style={{
        ...style,
        width: '5.5ch', // room for 117.5
        background: '#1a1a26',
        border: '1px solid #7f77dd',
        borderRadius: '6px',
        padding: '0 4px',
        outline: 'none'
      }}
    />
  )
}
