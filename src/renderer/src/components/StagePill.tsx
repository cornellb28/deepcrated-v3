// ── Stage pill ────────────────────────────────────────────────────────────
// The coloured pill on a track, turned into a button: each click advances to
// the next stage and wraps past the last one.
//
// Two components, because two callers want different halves:
//   StageCycler — presentational and controlled. Renders a stage, calls back
//                 on click. BulkEditModal uses this to PICK a value it will
//                 apply on save, touching nothing until then.
//   StagePill   — track-bound. Owns the optimistic store update and the
//                 debounced database write. Everywhere a real track is shown.

import React from 'react'
import { useLibraryStore } from '../store/useLibraryStore'
import { queueStageWrite } from '../lib/stageCommit'
import { cycleHint, nextStageId, stageById, STAGE_NOUN } from '../lib/stages'

type StageVariant = 'pill' | 'inline'
type StageSize = 'sm' | 'md'

interface StageCyclerProps {
  stages: readonly Board[]
  stageId: number | null
  onCycle: (nextId: number) => void
  variant?: StageVariant
  size?: StageSize
  // Shown instead of a stage name when a bulk selection spans several
  // stages and no target has been chosen yet.
  placeholder?: string
  disabled?: boolean
}

export function StageCycler({
  stages,
  stageId,
  onCycle,
  variant = 'pill',
  size = 'sm',
  placeholder,
  disabled = false
}: StageCyclerProps): React.JSX.Element | null {
  const stage = stageById(stages, stageId)

  // Nothing to cycle through. Rendering a dead button would be worse than
  // rendering nothing.
  if (stages.length === 0) return null
  if (!stage && !placeholder) return null

  const label = stage?.name ?? placeholder ?? STAGE_NOUN
  const color = stage?.color ?? '#6a6a80'
  const fontSize = size === 'md' ? '11px' : variant === 'inline' ? '9px' : '10px'
  const dot = size === 'md' ? '6px' : variant === 'inline' ? '6px' : '5px'

  function handleClick(e: React.MouseEvent): void {
    // The row and the card both act on a click of their own — TrackRow plays
    // the track and opens the Inspector, TrackCard does the same. Neither
    // should fire because someone nudged a stage along.
    e.stopPropagation()
    e.preventDefault()
    if (disabled) return
    const next = nextStageId(stages, stageId)
    if (next !== null) onCycle(next)
  }

  const shared: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
    fontFamily: 'inherit',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    // Colour moves with the stage, so the change is visible even at a
    // glance across a long list.
    transition: 'background 0.12s ease, border-color 0.12s ease, color 0.12s ease'
  }

  const chrome: React.CSSProperties =
    variant === 'pill'
      ? {
          background: color + '22',
          border: `0.5px solid ${color}44`,
          borderRadius: '4px',
          padding: size === 'md' ? '3px 9px' : '2px 7px'
        }
      : {
          background: 'none',
          border: 'none',
          padding: 0
        }

  return (
    <button
      type="button"
      onClick={handleClick}
      // A row-level mousedown would start a drag or a selection before the
      // click ever lands.
      onMouseDown={(e) => e.stopPropagation()}
      disabled={disabled}
      title={cycleHint(stages, stageId)}
      aria-label={cycleHint(stages, stageId)}
      style={{ ...shared, ...chrome }}
    >
      <span
        style={{
          width: dot,
          height: dot,
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
          transition: 'background 0.12s ease'
        }}
      />
      <span
        style={{
          fontSize,
          color: variant === 'pill' ? color : '#6a6a80',
          fontWeight: variant === 'pill' ? 500 : 400,
          whiteSpace: 'nowrap'
        }}
      >
        {label}
      </span>
    </button>
  )
}

interface StagePillProps {
  track: Track
  variant?: StageVariant
  size?: StageSize
}

// The track-bound pill. Clicking updates the store immediately and queues the
// database write — see lib/stageCommit.ts for why the write is debounced and
// why the timer does not live in this component.
export function StagePill({ track, variant, size }: StagePillProps): React.JSX.Element | null {
  const boards = useLibraryStore((s) => s.boards)
  const updateTrack = useLibraryStore((s) => s.updateTrack)

  return (
    <StageCycler
      stages={boards}
      stageId={track.board_id ?? null}
      variant={variant}
      size={size}
      onCycle={(nextId) => {
        // Store first: the pill, the tab counts and any other view of this
        // track all move together on the same render.
        updateTrack(track.id, { board_id: nextId })
        queueStageWrite(track.id, nextId)
      }}
    />
  )
}
