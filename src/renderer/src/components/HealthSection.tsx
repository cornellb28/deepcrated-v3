import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useLibraryStore } from '../store/useLibraryStore'
import { TrackRow } from './TrackRow'
import { BulkBar } from './BulkBar'
import { applySelection, selectAll, type SelectModifiers } from '../lib/selection'
import { ArtistCleanDialog } from './ArtistCleanDialog'

// ── Crate Health ──────────────────────────────────────────────────────────
// Counts and fix queues come from main (health:summary / health:queue), where
// each count is COUNT over the very query that builds its queue — so a box
// cannot say 128 and then list 130. The queue arrives as ids and is resolved
// against the library store, which keeps every row live (edits, selection,
// the ⋮ menu) without a second copy of the track data crossing IPC.
//
// Read-only: nothing here fixes anything automatically. Row actions are the
// existing TrackRow ones and the bulk actions are the existing BulkBar ones.
//
// Fix actions (FIX_ACTIONS_SLOT below). main/health/checks.ts lists them per
// check in HEALTH_FIX_ACTIONS; this renders whatever is listed and decides what
// each id does. 'review-artist-names' opens the artist-name review and
// re-clean (main/artist/) — that is where the artist cleanup hooks in.
//
// TODO(health): MusicBrainz auto-fill (Metadata Cleanup) registers the same
// way: add its action id to HEALTH_FIX_ACTIONS and handle it in runFixAction.
// Nothing else fixes anything automatically.

// How many rows the inline panel draws before it stops. This is a glance, not
// a work queue: a library with 8,000 untagged tracks would otherwise mount
// 8,000 rows on a single click. "Select all" still takes the whole queue.
const PANEL_LIMIT = 100

// Why analysis called a file bad, shown under its row in the unreadable-audio
// queue. Keyed by the stored code (see main/analysisIssue.ts).
const ISSUE_CAPTIONS: Record<AnalysisIssue, string> = {
  decode_failed: 'Could not be decoded',
  truncated: 'File looks cut off — shorter than its header says',
  damaged: 'Damaged audio data — BPM and key may be unreliable',
  timeout: 'Analysis timed out'
}

// Store updates arrive in bursts (analysis ticks, import batches, watcher
// events); one refetch per burst is plenty.
const REFRESH_DEBOUNCE_MS = 300

export function HealthSection(): React.JSX.Element {
  const { tracks, trackTags } = useLibraryStore()

  const [summary, setSummary] = useState<HealthSummary | null>(null)
  const [failed, setFailed] = useState(false)
  const [openId, setOpenId] = useState<HealthCheckId | null>(null)
  const [artistDialogOpen, setArtistDialogOpen] = useState(false)
  const [queueIds, setQueueIds] = useState<number[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [anchorId, setAnchorId] = useState<number | null>(null)

  // Only the newest request may write state: a slow answer to an older
  // request must not overwrite a newer one.
  const requestSeq = useRef(0)
  const lastOpenId = useRef<HealthCheckId | null>(null)

  // Refresh whenever the library changes — an edit, an import batch, a
  // watcher event all end up replacing `tracks` or `trackTags` in the store.
  useEffect(() => {
    const seq = ++requestSeq.current
    // Opening or closing a check is a click and should answer at once; only
    // store churn is debounced.
    const delay = lastOpenId.current === openId ? REFRESH_DEBOUNCE_MS : 0
    lastOpenId.current = openId
    const timer = setTimeout(async () => {
      try {
        const [nextSummary, nextQueue] = await Promise.all([
          window.api.health.summary(),
          openId ? window.api.health.queue(openId) : Promise.resolve<number[]>([])
        ])
        if (seq !== requestSeq.current) return
        setSummary(nextSummary)
        setQueueIds(nextQueue)
        setFailed(false)
      } catch {
        if (seq === requestSeq.current) setFailed(true)
      }
    }, delay)
    return () => clearTimeout(timer)
  }, [tracks, trackTags, openId])

  const tracksById = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks])

  // Ids the store no longer has (deleted since the query ran) just drop out;
  // the next refresh corrects the count.
  const queueTracks = useMemo(
    () => queueIds.map((id) => tracksById.get(id)).filter((t): t is Track => t !== undefined),
    [queueIds, tracksById]
  )
  const shownTracks = queueTracks.slice(0, PANEL_LIMIT)
  const shownIds = shownTracks.map((t) => t.id)

  const openCheck = summary?.checks.find((c) => c.id === openId) ?? null

  // Switching or closing a check drops the selection with it, so a bulk
  // action can never hit a set the list above no longer shows.
  function openCheckById(next: HealthCheckId | null): void {
    setOpenId(next)
    setQueueIds([])
    setSelectedIds(new Set())
    setAnchorId(null)
  }

  function handleSelect(id: number, modifiers?: SelectModifiers): void {
    const result = applySelection(selectedIds, shownIds, id, modifiers, anchorId)
    setSelectedIds(result.selected)
    setAnchorId(result.anchorId)
  }

  function runFixAction(actionId: string): void {
    if (actionId === 'review-artist-names') setArtistDialogOpen(true)
  }

  const healthyPct =
    summary && summary.liveTracks > 0
      ? Math.floor(((summary.liveTracks - summary.flaggedTracks) / summary.liveTracks) * 100)
      : null

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          marginBottom: '10px',
          minHeight: '20px'
        }}
      >
        <span
          style={{
            fontSize: '11px',
            fontWeight: 500,
            letterSpacing: '0.8px',
            textTransform: 'uppercase',
            color: '#444'
          }}
        >
          Crate health
        </span>
        {summary && (
          <span
            style={{
              fontSize: '11px',
              color: summary.flaggedTracks === 0 ? '#1d9e75' : '#ba7517'
            }}
          >
            {summary.liveTracks === 0
              ? 'No tracks yet'
              : summary.flaggedTracks === 0
                ? 'All tracks healthy'
                : `${healthyPct}% healthy · ${summary.flaggedTracks.toLocaleString()} of ${summary.liveTracks.toLocaleString()} tracks need attention`}
          </span>
        )}
      </div>

      {failed && !summary && (
        <div style={{ fontSize: '12px', color: '#555', marginBottom: '24px' }}>
          Could not read crate health.
        </div>
      )}

      {summary && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '10px',
            marginBottom: openCheck ? '10px' : '24px'
          }}
        >
          {summary.checks.map((check) => {
            const isOpen = openId === check.id
            // A box at zero has nothing to show: a plain div, never a button
            // offering a click that would open an empty panel.
            const clickable = check.count > 0
            const shared: React.CSSProperties = {
              background: isOpen ? '#191521' : '#13131b',
              border: isOpen
                ? '0.5px solid #ba751788'
                : check.count > 0
                  ? '0.5px solid #ba751733'
                  : '0.5px solid #1e1e2a',
              borderRadius: '10px',
              padding: '14px',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              width: '100%'
            }
            const body = (
              <>
                <div
                  style={{
                    fontSize: '20px',
                    fontWeight: 500,
                    color: check.count > 0 ? '#ba7517' : '#1d9e75',
                    minWidth: '40px'
                  }}
                >
                  {check.count > 0 ? check.count.toLocaleString() : '✓'}
                </div>
                <div
                  style={{
                    fontSize: '12px',
                    color: isOpen ? '#c0c0d8' : '#555',
                    textAlign: 'left',
                    flex: 1
                  }}
                >
                  {check.label}
                </div>
                {clickable && (
                  <span
                    aria-hidden
                    style={{
                      fontSize: '10px',
                      color: isOpen ? '#ba7517' : '#3a3a48',
                      transform: isOpen ? 'rotate(180deg)' : 'none',
                      transition: 'transform 0.15s ease, color 0.15s ease',
                      flexShrink: 0
                    }}
                  >
                    ▾
                  </span>
                )}
              </>
            )
            if (!clickable) {
              return (
                <div key={check.id} style={shared}>
                  {body}
                </div>
              )
            }
            return (
              <button
                key={check.id}
                type="button"
                onClick={() => openCheckById(isOpen ? null : check.id)}
                aria-expanded={isOpen}
                aria-controls="crate-health-panel"
                style={{
                  ...shared,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                  transition: 'background 0.15s ease, border-color 0.15s ease'
                }}
              >
                {body}
              </button>
            )
          })}
        </div>
      )}

      {/* The fix queue. Sits directly under the boxes it belongs to, and
          collapses back to nothing so the dashboard below stays put. */}
      {openCheck && (
        <div
          id="crate-health-panel"
          style={{
            background: '#13131b',
            border: '0.5px solid #ba751733',
            borderRadius: '10px',
            overflow: 'hidden',
            marginBottom: '24px'
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '12px 14px',
              borderBottom: queueTracks.length > 0 ? '0.5px solid #1e1e2a' : 'none'
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '12px', color: '#c0c0d8' }}>
                {openCheck.count.toLocaleString()} · {openCheck.label.toLowerCase()}
              </div>
              <div style={{ fontSize: '11px', color: '#555', marginTop: '3px' }}>
                {openCheck.hint}
              </div>
            </div>
            {/* FIX_ACTIONS_SLOT — see the note at the top of this file. */}
            {openCheck.fixActions.map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={() => runFixAction(action.id)}
                style={{
                  background: '#7f77dd',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#fff',
                  fontSize: '11px',
                  cursor: 'pointer',
                  padding: '4px 10px',
                  fontFamily: 'inherit',
                  flexShrink: 0
                }}
              >
                {action.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => openCheckById(null)}
              style={{
                background: 'none',
                border: '0.5px solid #252535',
                borderRadius: '6px',
                color: '#555',
                fontSize: '11px',
                cursor: 'pointer',
                padding: '4px 10px',
                fontFamily: 'inherit',
                flexShrink: 0
              }}
            >
              Close
            </button>
          </div>

          {/* Renders null until something is selected. "Select all" takes the
              WHOLE queue, not just the rendered slice. */}
          <BulkBar
            selectedIds={selectedIds}
            onClearSelect={() => {
              setSelectedIds(new Set())
              setAnchorId(null)
            }}
            onSelectAll={() => {
              setSelectedIds(selectAll(queueTracks.map((t) => t.id)))
              setAnchorId(null)
            }}
            totalCount={queueTracks.length}
          />

          {queueTracks.length === 0 ? (
            // Reachable: the panel stays open while edits land, so the last
            // track leaving the queue ends up here rather than on a blank.
            <div style={{ padding: '14px', fontSize: '12px', color: '#1d9e75' }}>
              ✓ All done — nothing {openCheck.label.toLowerCase()} any more.
            </div>
          ) : (
            <div style={{ maxHeight: '420px', overflowY: 'auto', padding: '8px 10px' }}>
              {shownTracks.map((track) => (
                <React.Fragment key={track.id}>
                  <TrackRow
                    track={track}
                    isSelected={selectedIds.has(track.id)}
                    onSelected={handleSelect}
                  />
                  {openCheck.id === 'unreadable_audio' && track.analysis_error && (
                    <div
                      style={{
                        fontSize: '11px',
                        color: '#d85a30',
                        padding: '0 12px 8px 44px'
                      }}
                    >
                      {ISSUE_CAPTIONS[track.analysis_error] ?? 'Problem reading this file'}
                    </div>
                  )}
                </React.Fragment>
              ))}
            </div>
          )}

          {queueTracks.length > PANEL_LIMIT && (
            <div
              style={{
                padding: '10px 14px',
                borderTop: '0.5px solid #1e1e2a',
                fontSize: '11px',
                color: '#444'
              }}
            >
              Showing the first {PANEL_LIMIT} of {queueTracks.length.toLocaleString()} — Select all
              still takes every one.
            </div>
          )}
        </div>
      )}

      <ArtistCleanDialog
        open={artistDialogOpen}
        onClose={() => {
          setArtistDialogOpen(false)
          // Decisions made in the dialog change what the checks report.
          setSummary(null)
          requestSeq.current++
          void window.api.health.summary().then(setSummary)
        }}
      />
    </>
  )
}
