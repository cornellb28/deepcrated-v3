import { BulkEditModal } from './BulkEditModal'
import React, { useRef, useState } from 'react'
import { toast } from 'sonner'
import { useLibraryStore } from '../store/useLibraryStore'
import { Button } from './ui/button'
import { MoveToModal } from './MoveToModal'
import { CratePickerModal } from './CratePickerModal'
import { reanalyzeSummary, reanalyzeTracks, type ReanalyzeTally } from '../lib/reanalyze'

interface BulkBarProps {
  // ReadonlySet, not Set: nothing here mutates the selection, and the
  // callers build a fresh set for every change.
  selectedIds: ReadonlySet<number>
  onClearSelect: () => void
  onSelectAll: () => void
  totalCount: number
  // When set, BulkBar is rendered inside that crate's own track list — swaps
  // in a "Remove from crate" action instead of (well, in addition to)
  // "Add to crate", since the selection is already scoped to one crate.
  crateId?: number
}

// Every action here is available to everyone: the desktop app is free, so
// there is no tier to gate on and none is planned. One implementation,
// shared by list and grid.
export function BulkBar({
  selectedIds,
  onClearSelect,
  totalCount,
  onSelectAll,
  crateId
}: BulkBarProps): React.JSX.Element | null {
  const { removeTracksFromCrateLocally, updateTrack, trackAnalysis } = useLibraryStore()
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [moveModalOpen, setMoveModalOpen] = useState(false)
  const [cratePickerOpen, setCratePickerOpen] = useState(false)

  // Non-null only while a bulk re-analysis is running. The stop flag is a ref,
  // not state: the pool reads it between tracks, and a re-render is neither
  // needed nor wanted at that moment.
  const [analysis, setAnalysis] = useState<{ tally: ReanalyzeTally; total: number } | null>(null)
  const stopRequested = useRef(false)

  // Hide when nothing is selected
  if (selectedIds.size === 0) return null

  const selectedArray = Array.from(selectedIds)
  const busy = analysis !== null
  const settled = analysis ? analysis.tally.ok + analysis.tally.failed + analysis.tally.skipped : 0
  const activeTrackProgress = analysis
    ? selectedArray.reduce((sum, id) => {
        const progress = trackAnalysis.get(id)
        return sum + (progress && progress.steps > 0 ? progress.step / progress.steps : 0)
      }, 0)
    : 0
  const progressPercent = analysis
    ? Math.min(100, Math.round(((settled + activeTrackProgress) / analysis.total) * 100))
    : 0

  // Runs the same per-track routine the ⋮ menu's Re-analyze uses, four at a
  // time, so each card shows its own progress bar as its turn comes up. The
  // selection is deliberately left alone: the bar's counter is the only place
  // the overall progress is shown, and it disappears with the selection.
  async function handleReanalyze(): Promise<void> {
    if (analysis) return
    stopRequested.current = false
    const ids = selectedArray
    setAnalysis({ tally: { ok: 0, failed: 0, skipped: 0, stopped: false }, total: ids.length })

    try {
      const tally = await reanalyzeTracks(ids, {
        onSettled: (progress) => setAnalysis({ tally: progress, total: ids.length }),
        shouldStop: () => stopRequested.current
      })
      const summary = reanalyzeSummary(tally)
      if (tally.failed > 0) toast.error('Re-analyze finished with errors', { description: summary })
      else toast.success(summary)
    } finally {
      setAnalysis(null)
    }
  }

  // One image, applied to every selected track. Content-addressed storage
  // means the fifty rows share one file rather than fifty copies of it — see
  // the artwork:pick handler.
  async function handleArtwork(): Promise<void> {
    const result = await window.api.artwork.pick(selectedArray)
    // No error and not ok means the file dialog was cancelled: not worth a
    // toast, the DJ knows they just pressed Cancel.
    if (!result.ok) {
      if (result.error) toast.error('Could not set artwork', { description: result.error })
      return
    }
    for (const id of selectedArray) updateTrack(id, { artwork_hash: result.hash ?? null })
    toast.success(
      result.applied === 1 ? 'Artwork set' : `Artwork set on ${result.applied} tracks`
    )
  }

  async function handleRemoveFromCrate(): Promise<void> {
    if (crateId === undefined) return
    const result = await window.api.crates.removeTracks(crateId, selectedArray)
    if (result.ok) {
      removeTracksFromCrateLocally(crateId, selectedArray)
      toast.success(
        `Removed ${selectedArray.length} track${selectedArray.length !== 1 ? 's' : ''} from crate`
      )
      onClearSelect()
    } else {
      toast.error('Could not remove from crate', { description: result.error })
    }
  }

  return (
    <>
      {/* Bulk edit modal */}
      <BulkEditModal
        trackIds={selectedArray}
        open={editModalOpen}
        onClose={() => setEditModalOpen(false)}
      />

      {/* Destination picker — owns the cross-device warning, the job
          dispatch and the recent-destinations list. */}
      <MoveToModal
        trackIds={selectedArray}
        open={moveModalOpen}
        onClose={() => setMoveModalOpen(false)}
        onMoveStarted={onClearSelect}
      />

      <div
        style={{
          background: '#1e1b3a',
          borderBottom: '0.5px solid #3a3060',
          padding: '7px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flexShrink: 0,
          flexWrap: 'wrap'
        }}
      >
        {/* Count */}
        <span
          style={{
            fontSize: '12px',
            fontWeight: 500,
            color: '#a09be8',
            flexShrink: 0
          }}
        >
          {selectedIds.size} selected
        </span>

        {/* Select all */}
        <button
          onClick={onSelectAll}
          disabled={busy}
          style={{
            background: 'none',
            border: '0.5px solid #3a3060',
            borderRadius: '5px',
            color: '#a09be8',
            fontSize: '11px',
            padding: '3px 10px',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.5 : 1,
            fontFamily: 'inherit'
          }}
        >
          Select all {totalCount}
        </button>

        {/* Edit labels button */}
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setEditModalOpen(true)}
          className="text-xs"
          style={{ borderColor: '#7f77dd', color: '#a09be8' }}
        >
          Edit labels
        </Button>

        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void handleArtwork()}
          className="text-xs"
          style={{ borderColor: '#7f77dd', color: '#a09be8' }}
          title="Set one cover image on every selected track"
        >
          Artwork
        </Button>

        {/* Keep the original control in place during analysis. The green fill
            reflects both settled tracks and live per-track sidecar progress. */}
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void handleReanalyze()}
          className="text-xs"
          aria-label={
            busy
              ? `Re-analyzing ${settled} of ${analysis.total} tracks`
              : 'Re-analyze selected tracks'
          }
          style={{
            position: 'relative',
            overflow: 'hidden',
            isolation: 'isolate',
            borderColor: busy ? '#287557' : '#7f77dd',
            color: busy ? '#d5f5e8' : '#a09be8'
          }}
        >
          {busy && (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                zIndex: 0,
                inset: '0 auto 0 0',
                width: `${progressPercent}%`,
                background: 'linear-gradient(90deg, #1d9e7555, #1d9e7533)',
                transition: 'width 250ms ease-out',
                pointerEvents: 'none'
              }}
            />
          )}
          <span style={{ position: 'relative', zIndex: 1, fontVariantNumeric: 'tabular-nums' }}>
            {busy ? `Re-analyzing ${settled} / ${analysis.total}` : 'Re-analyze'}
          </span>
        </Button>

        {busy && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                stopRequested.current = true
              }}
              className="text-xs"
              style={{ borderColor: '#3a3060', color: '#a09be8' }}
            >
              Stop
            </Button>
          </>
        )}

        {/* Add to crate button */}
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setCratePickerOpen(true)}
          className="text-xs"
          style={{ borderColor: '#7f77dd', color: '#a09be8' }}
        >
          Add to crate
        </Button>
        <CratePickerModal
          trackIds={selectedArray}
          open={cratePickerOpen}
          onClose={() => setCratePickerOpen(false)}
        />

        {/* Remove from crate — only when BulkBar is scoped to one crate's view */}
        {crateId !== undefined && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void handleRemoveFromCrate()}
            className="text-xs"
            style={{ borderColor: '#3a3060', color: '#a09be8' }}
          >
            Remove from crate
          </Button>
        )}

        {/* Move to... button */}
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setMoveModalOpen(true)}
          className="text-xs"
          style={{ borderColor: '#7f77dd', color: '#a09be8' }}
        >
          Move to...
        </Button>

        {/* Deselect */}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onClearSelect}
          className="text-xs ml-auto"
          style={{ color: '#555' }}
        >
          Deselect all
        </Button>
      </div>
    </>
  )
}
