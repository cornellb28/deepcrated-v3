import React, { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { GripVertical, ChevronUp, ChevronDown, UploadCloud } from 'lucide-react'
import { useLibraryStore } from '../store/useLibraryStore'
import { TrackRow } from '../components/TrackRow'
import { TrackCard } from '../components/TrackCard'
import { TRACK_GRID_GAP, trackGridColumns } from '../lib/trackCard'
import { BulkBar } from '../components/BulkBar'
import { SeratoRunningConfirmDialog } from '../components/SeratoRunningConfirmDialog'
import { useViewMode } from '../hooks/useViewMode'
import { ViewModeToggle } from '../components/ViewModeToggle'

interface CrateViewProps {
  crateId: number
}

type SortColumn = 'title' | 'artist' | 'bpm' | 'key_camelot' | 'genre' | 'duration_sec'

const COLUMNS: { key: SortColumn; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'artist', label: 'Artist' },
  { key: 'genre', label: 'Genre' },
  { key: 'bpm', label: 'BPM' },
  { key: 'key_camelot', label: 'Key' },
  { key: 'duration_sec', label: 'Time' }
]

const UNDO_WINDOW_MS = 10_000

function compareTracks(a: Track, b: Track, column: SortColumn): number {
  const av = a[column]
  const bv = b[column]
  if (av == null && bv == null) return 0
  if (av == null) return 1 // nulls sort last regardless of direction
  if (bv == null) return -1
  if (typeof av === 'number' && typeof bv === 'number') return av - bv
  return String(av).localeCompare(String(bv))
}

// The one place that computes a block-move result — used by both drag
// (single row or the whole selection, dragged together) and the keyboard
// nudge. Moving tracks keep their existing relative order; everything else
// shifts to make room.
function reorderIds(
  allIds: number[],
  movingIds: number[],
  targetId: number,
  after: boolean
): number[] {
  const moving = new Set(movingIds)
  const remaining = allIds.filter((id) => !moving.has(id))
  const orderedMoving = allIds.filter((id) => moving.has(id))
  const targetIndex = remaining.indexOf(targetId)
  const insertAt = targetIndex === -1 ? remaining.length : after ? targetIndex + 1 : targetIndex
  return [...remaining.slice(0, insertAt), ...orderedMoving, ...remaining.slice(insertAt)]
}

export function CrateView({ crateId }: CrateViewProps): React.JSX.Element {
  const crates = useLibraryStore((s) => s.crates)
  const crate = crates.find((c) => c.id === crateId)
  // Only re-fetches when THIS crate's membership actually changes (add/
  // remove from anywhere in the app — BulkBar, TrackRowMenu, this view's own
  // reorder never touches membership) — see crateTrackIds' per-crate Set
  // identity in useLibraryStore.
  const membership = useLibraryStore((s) => s.crateTrackIds.get(crateId))
  const patchCrateLocally = useLibraryStore((s) => s.patchCrateLocally)

  const [orderedTracks, setOrderedTracks] = useState<Track[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [sortState, setSortState] = useState<{
    column: SortColumn
    direction: 'asc' | 'desc'
  } | null>(null)
  const [mode, setMode] = useViewMode(`crate:${crateId}`, 'list')

  const [draggingId, setDraggingId] = useState<number | null>(null)
  const [handleActiveId, setHandleActiveId] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: number; after: boolean } | null>(null)

  const [undoState, setUndoState] = useState<{ crateId: number; trackIds: number[] } | null>(null)
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [seratoConfirmOpen, setSeratoConfirmOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  // Local state (selection, sort, undo) resets for free on a crate switch —
  // App.tsx renders this with key={crateId}, so switching crates remounts
  // the whole component instead of needing a reset effect here.
  useEffect(() => {
    let cancelled = false
    window.api.crates.tracks(crateId).then((tracks) => {
      if (!cancelled) {
        setOrderedTracks(tracks)
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [crateId, membership])

  function captureUndo(previousIds: number[]): void {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    setUndoState({ crateId, trackIds: previousIds })
    undoTimerRef.current = setTimeout(() => setUndoState(null), UNDO_WINDOW_MS)
  }

  // Takes its data as arguments rather than reading `undoState`/`orderedTracks`
  // off the component — the toast's action button below captures this at
  // creation time and never gets a fresh closure (sonner holds the same
  // onClick for the toast's whole lifetime), so anything it calls has to be
  // correct from data closed over at that moment, not state read later.
  async function restoreOrder(targetIds: number[], sourceTracks: Track[]): Promise<void> {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    const byId = new Map(sourceTracks.map((t) => [t.id, t]))
    const restored = targetIds.map((id) => byId.get(id)).filter((t): t is Track => !!t)
    setUndoState(null)
    setSortState(null)
    setOrderedTracks(restored)
    await window.api.crates.reorder(
      crateId,
      restored.map((t) => t.id)
    )
    toast.success('Reorder undone')
  }

  async function persistOrder(
    newTracks: Track[],
    previousIds: number[],
    message: string
  ): Promise<void> {
    setOrderedTracks(newTracks)
    captureUndo(previousIds)
    await window.api.crates.reorder(
      crateId,
      newTracks.map((t) => t.id)
    )
    toast.success(message, {
      action: { label: 'Undo', onClick: () => void restoreOrder(previousIds, newTracks) }
    })
  }

  // Only used by the cmd+Z keyboard shortcut below — that handler re-reads
  // undoState/orderedTracks fresh on every relevant state change (see the
  // effect's dependency array), so this one's closure never goes stale.
  async function handleUndo(): Promise<void> {
    if (!undoState || undoState.crateId !== crateId) return
    await restoreOrder(undoState.trackIds, orderedTracks)
  }

  async function handleSortClick(column: SortColumn): Promise<void> {
    const previousIds = orderedTracks.map((t) => t.id)
    const direction: 'asc' | 'desc' =
      sortState?.column === column && sortState.direction === 'asc' ? 'desc' : 'asc'
    const sorted = [...orderedTracks].sort((a, b) => {
      const cmp = compareTracks(a, b, column)
      return direction === 'asc' ? cmp : -cmp
    })
    setSortState({ column, direction })
    const label = COLUMNS.find((c) => c.key === column)?.label ?? column
    await persistOrder(sorted, previousIds, `Crate reordered by ${label}`)
  }

  async function handleDrop(targetId: number, after: boolean): Promise<void> {
    const sourceId = draggingId
    setDraggingId(null)
    setDropTarget(null)
    if (sourceId === null) return
    const movingIds =
      selectedIds.has(sourceId) && selectedIds.size > 1 ? [...selectedIds] : [sourceId]
    if (movingIds.includes(targetId)) return

    const previousIds = orderedTracks.map((t) => t.id)
    const newIds = reorderIds(previousIds, movingIds, targetId, after)
    const byId = new Map(orderedTracks.map((t) => [t.id, t]))
    const newTracks = newIds.map((id) => byId.get(id)!)
    setSortState(null) // manual reorder breaks the "sorted by X" indicator
    await persistOrder(newTracks, previousIds, 'Crate reordered')
  }

  function moveSelectionBy(direction: -1 | 1): void {
    if (selectedIds.size === 0) return
    const ids = orderedTracks.map((t) => t.id)
    const firstIndex = ids.findIndex((id) => selectedIds.has(id))
    const lastIndex = ids.length - 1 - [...ids].reverse().findIndex((id) => selectedIds.has(id))
    if (firstIndex === -1) return
    if (direction === -1 && firstIndex === 0) return
    if (direction === 1 && lastIndex === ids.length - 1) return

    const targetId = direction === -1 ? ids[firstIndex - 1] : ids[lastIndex + 1]
    const previousIds = ids
    const newIds = reorderIds(ids, [...selectedIds], targetId, direction === 1)
    const byId = new Map(orderedTracks.map((t) => [t.id, t]))
    const newTracks = newIds.map((id) => byId.get(id)!)
    setSortState(null)
    void persistOrder(newTracks, previousIds, 'Crate reordered')
  }

  // Keyboard: cmd/ctrl+↑/↓ nudges the selection, cmd/ctrl+Z undoes the last
  // sort or drag — both scoped to this crate, ignored while typing.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (undoState && undoState.crateId === crateId) {
          e.preventDefault()
          void handleUndo()
        }
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        moveSelectionBy(-1)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        moveSelectionBy(1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedTracks, selectedIds, undoState, crateId])

  async function ensureNotSeratoRunning(): Promise<boolean> {
    const running = await window.api.crates.isSeratoRunning()
    if (running) {
      setSeratoConfirmOpen(true)
      return false
    }
    return true
  }

  async function runExport(): Promise<void> {
    setExporting(true)
    const { jobId } = await window.api.crates.export([crateId])
    void jobId // progress surfaces globally via App.tsx's onCrateExportProgress -> jobs panel
    setExporting(false)
    patchCrateLocally(crateId, { last_exported_at: Math.floor(Date.now() / 1000) })
  }

  async function handleExportClick(): Promise<void> {
    if (await ensureNotSeratoRunning()) void runExport()
  }

  function toggleSelect(id: number): void {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const lastExportedLabel = crate?.last_exported_at
    ? new Date(crate.last_exported_at * 1000).toLocaleString()
    : null

  if (!crate) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#333',
          fontSize: '13px'
        }}
      >
        Crate not found
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div
        style={{
          padding: '14px 20px',
          borderBottom: '0.5px solid #1e1e2a',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          flexShrink: 0
        }}
      >
        <span
          style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: crate.color,
            flexShrink: 0
          }}
        />
        <span style={{ fontSize: '14px', fontWeight: 500, color: '#e8e8f0' }}>{crate.name}</span>
        <span style={{ fontSize: '12px', color: '#555' }}>
          {orderedTracks.length} track{orderedTracks.length !== 1 ? 's' : ''}
        </span>
        {lastExportedLabel && (
          <span style={{ fontSize: '11px', color: '#444' }}>Last exported {lastExportedLabel}</span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <ViewModeToggle mode={mode} onChange={setMode} />
          <button
            onClick={() => void handleExportClick()}
            disabled={exporting || orderedTracks.length === 0}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: 'none',
              border: '0.5px solid #7f77dd',
              borderRadius: '6px',
              color: '#a09be8',
              fontSize: '12px',
              padding: '5px 10px',
              cursor: exporting || orderedTracks.length === 0 ? 'default' : 'pointer',
              opacity: exporting || orderedTracks.length === 0 ? 0.5 : 1
            }}
          >
            <UploadCloud size={13} />
            {exporting ? 'Exporting…' : 'Export to Serato'}
          </button>
        </div>
      </div>

      {/* Bulk bar */}
      <BulkBar
        selectedIds={selectedIds}
        onClearSelect={() => setSelectedIds(new Set())}
        onSelectAll={() => setSelectedIds(new Set(orderedTracks.map((t) => t.id)))}
        totalCount={orderedTracks.length}
        crateId={crateId}
      />

      {/* Column headers — list mode only; sort persists as the crate's order */}
      {mode === 'list' && orderedTracks.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: '14px',
            padding: '6px 16px',
            borderBottom: '0.5px solid #1e1e2a',
            flexShrink: 0
          }}
        >
          <span style={{ width: '18px', flexShrink: 0 }} />
          {COLUMNS.map(({ key, label }) => {
            const active = sortState?.column === key
            return (
              <button
                key={key}
                onClick={() => void handleSortClick(key)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '3px',
                  background: 'none',
                  border: 'none',
                  color: active ? '#a09be8' : '#555',
                  fontSize: '10px',
                  fontWeight: 500,
                  letterSpacing: '0.5px',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                  padding: 0
                }}
              >
                {label}
                {active &&
                  (sortState!.direction === 'asc' ? (
                    <ChevronUp size={11} />
                  ) : (
                    <ChevronDown size={11} />
                  ))}
              </button>
            )
          })}
        </div>
      )}

      {loading ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#333',
            fontSize: '13px'
          }}
        >
          Loading…
        </div>
      ) : orderedTracks.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#333',
            fontSize: '13px'
          }}
        >
          No tracks in this crate yet — add some from Add to crate elsewhere in the library
        </div>
      ) : mode === 'list' ? (
        <div data-testid="track-list" style={{ flex: 1, overflowY: 'auto', padding: '8px 16px' }}>
          {orderedTracks.map((track) => {
            const isDropTarget = dropTarget?.id === track.id
            return (
              <div
                key={track.id}
                draggable={handleActiveId === track.id}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  setDraggingId(track.id)
                }}
                onDragEnd={() => {
                  setDraggingId(null)
                  setHandleActiveId(null)
                  setDropTarget(null)
                }}
                onDragOver={(e) => {
                  if (draggingId === null) return
                  e.preventDefault()
                  const rect = e.currentTarget.getBoundingClientRect()
                  const after = e.clientY - rect.top > rect.height / 2
                  setDropTarget({ id: track.id, after })
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  void handleDrop(track.id, dropTarget?.after ?? false)
                }}
                style={{
                  display: 'flex',
                  alignItems: 'stretch',
                  gap: '2px',
                  opacity: draggingId === track.id ? 0.4 : 1,
                  borderTop:
                    isDropTarget && !dropTarget?.after
                      ? '2px solid #7f77dd'
                      : '2px solid transparent',
                  borderBottom:
                    isDropTarget && dropTarget?.after
                      ? '2px solid #7f77dd'
                      : '2px solid transparent'
                }}
              >
                <div
                  onMouseDown={() => setHandleActiveId(track.id)}
                  onMouseUp={() => setHandleActiveId(null)}
                  title="Drag to reorder"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    width: '18px',
                    flexShrink: 0,
                    color: '#3a3a4a',
                    cursor: 'grab'
                  }}
                >
                  <GripVertical size={14} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <TrackRow
                    track={track}
                    isSelected={selectedIds.has(track.id)}
                    onSelected={toggleSelect}
                    crateId={crateId}
                  />
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div
          data-testid="track-list"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '12px 16px',
            display: 'grid',
            gridTemplateColumns: trackGridColumns,
            gap: `${TRACK_GRID_GAP}px`,
            alignContent: 'start'
          }}
        >
          {orderedTracks.map((track) => (
            <TrackCard
              key={track.id}
              track={track}
              isSelected={selectedIds.has(track.id)}
              onSelect={toggleSelect}
            />
          ))}
        </div>
      )}

      <SeratoRunningConfirmDialog
        open={seratoConfirmOpen}
        onCancel={() => setSeratoConfirmOpen(false)}
        onConfirm={() => {
          setSeratoConfirmOpen(false)
          void runExport()
        }}
      />
    </div>
  )
}
