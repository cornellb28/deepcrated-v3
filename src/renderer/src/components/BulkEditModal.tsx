import React, { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Check, ChevronLeft, ChevronRight, Activity } from 'lucide-react'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { TagInput } from './TagInput'
import { useLibraryStore } from '../store/useLibraryStore'
import { useArtworkUrl } from '../hooks/useArtworkUrl'
import { fieldToMetaKey, withTrackIdentity } from '../lib/tagMeta'
import { StagePill } from './StagePill'
import { reanalyzeTrack } from '../lib/reanalyze'
import { flushStageWrites } from '../lib/stageCommit'
import { STAGE_NOUN } from '../lib/stages'

// ─── Types ───────────────────────────────────────────────

interface BulkEditModalProps {
  trackIds: number[]
  open: boolean
  onClose: () => void
}

// Fields that use TagInput (badge system). These save themselves the moment
// a badge is added or removed — they are NOT part of this modal's dirty
// state, and the footer says so, otherwise "Save" would look like it covers
// them too.
const TAG_FIELDS = [
  { field: 'genre', label: 'Genre', color: '#9b8ed4' },
  { field: 'comment', label: 'Comment', color: '#7f77dd' },
  { field: 'grouping', label: 'Grouping', color: '#1d9e75' },
  { field: 'remixer', label: 'Remixer', color: '#d85a30' },
  { field: 'label', label: 'Label', color: '#378add' }
]

const YEARS = Array.from(
  { length: new Date().getFullYear() - 1950 + 1 },
  (_, i) => new Date().getFullYear() - i
)

const ACCENT = '#7f77dd'

type FileWrite = { filepath: string; meta: EditTagsMeta }

// How long typing has to stop before an autosave fires. Long enough that a
// DJ typing a genre does not trigger a write per word — each save reaches the
// audio FILE through edit_tags.py, not just the database — short enough that
// leaving the modal a second later has already saved.
const AUTOSAVE_MS = 900

// How long the "Saved" tick stays up before fading back to idle.
const SAVED_FLASH_MS = 2000

// There is no unsaved state to guard any more: edits save themselves, and
// every way out of a track flushes first. This is only what the indicator
// shows.
type SaveState = 'idle' | 'saving' | 'saved' | 'error'

// ─── Main component ───────────────────────────────────────

export function BulkEditModal({
  trackIds,
  open,
  onClose
}: BulkEditModalProps): React.JSX.Element | null {
  const { tracks, updateTrack } = useLibraryStore()

  const [currentIndex, setCurrentIndex] = useState(0)
  const [checkedFields, setCheckedFields] = useState<Set<string>>(new Set())
  const [textValues, setTextValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  // Tracks whose text fields this session has written, for the progress bar.
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set())
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [analyzing, setAnalyzing] = useState(false)
  // Tracks whose file could not be written this save, collected during it
  // and reported once at the end rather than one popup per track.
  const skippedFileWrites = useRef<Set<number>>(new Set())

  // Reset volatile state when the modal transitions to open, and clear typed
  // values whenever the displayed track changes — both adjusted during
  // render (https://react.dev/learn/you-might-not-need-an-effect) rather
  // than via an effect, which would setState after paint.
  const [lastOpen, setLastOpen] = useState(open)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) {
      setCurrentIndex(0)
      setCheckedFields(new Set())
      setTextValues({})
      setSavedIds(new Set())
      setSaveState('idle')
      setSaving(false)
    }
  }

  const currentTrackId = trackIds[currentIndex]
  const currentTrack = tracks.find((t) => t.id === currentTrackId)
  const artworkUrl = useArtworkUrl(currentTrack?.artwork_hash, 'full')

  const [lastTrackId, setLastTrackId] = useState(currentTrackId)
  if (currentTrackId !== lastTrackId) {
    setLastTrackId(currentTrackId)
    setTextValues({})
  }

  const isFirst = currentIndex === 0
  const isLast = currentIndex === trackIds.length - 1

  // ── Dirty tracking ───────────────────────────────────────
  // Only counts a field whose typed value actually differs from what the
  // track already holds — retyping the same BPM should not put the modal
  // into an unsaved state, or every Next would stop to ask about nothing.
  const dirtyFields = useMemo(() => {
    if (!currentTrack) return []
    return Object.entries(textValues)
      .filter(([field, value]) => {
        const existing = currentTrack[field as keyof Track]
        return String(existing ?? '') !== String(value ?? '')
      })
      .map(([field]) => field)
  }, [textValues, currentTrack])

  const isDirty = dirtyFields.length > 0

  function toggleField(field: string): void {
    setCheckedFields((prev) => {
      const next = new Set(prev)
      if (next.has(field)) next.delete(field)
      else next.add(field)
      return next
    })
  }

  // ── Navigation ───────────────────────────────────────────
  // Every way out of the current track flushes any pending edit first, so
  // there is nothing left to warn about. The old "you have unsaved changes"
  // bar is gone with it — a prompt is only worth showing when the answer is
  // not already obvious, and here it always is.
  async function flushThen(action: () => void): Promise<void> {
    if (isDirty) await save({ bulk: false })
    action()
  }

  const goPrev = (): void => {
    if (!isFirst) void flushThen(() => setCurrentIndex(currentIndex - 1))
  }
  const goNext = (): void => {
    if (!isLast) void flushThen(() => setCurrentIndex(currentIndex + 1))
  }
  const requestClose = (): void => void flushThen(onClose)

  // ── Saving ───────────────────────────────────────────────
  // A bulk edit has to reach the file, not just the database. Everything is
  // accumulated first and sent as one batch job: one sidecar process for the
  // whole selection instead of one per track, with progress surfacing
  // through the background jobs panel.
  //
  // A track whose file is gone is written to the DATABASE but not to disk.
  // Sending it to edit_tags.py produces `File not found: <path>` — a sidecar
  // error surfaced as a popup, for a track the DJ may not even have realised
  // was in the selection. The edit is still worth keeping: it is recorded in
  // CrateCloud and will reach the file if it is ever relinked.
  function collectFileWrite(
    writes: Map<number, FileWrite>,
    track: Track,
    meta: EditTagsMeta
  ): void {
    if (track.missing || !track.filepath) {
      skippedFileWrites.current.add(track.id)
      return
    }
    const existing = writes.get(track.id)
    writes.set(track.id, {
      filepath: track.filepath,
      meta: withTrackIdentity(track, { ...(existing?.meta ?? {}), ...meta })
    })
  }

  // textValues holds raw input strings. Only 'year' reaches here now that
  // BPM and key are measured rather than typed — the numeric coercion that
  // used to live here went with the BPM input.
  function columnValue(_field: string, raw: string): string | null {
    return raw || null
  }

  // Autosave calls this with bulk: false — a DJ pausing mid-type must not
  // trigger a write across fifty files. The explicit "Apply to all" button
  // is the only thing that passes bulk: true.
  async function save(options: { bulk: boolean } = { bulk: false }): Promise<void> {
    if (!currentTrack || saving) return
    setSaving(true)
    setSaveState('saving')
    skippedFileWrites.current = new Set()

    const fileWrites = new Map<number, FileWrite>()
    const pendingDbWrites: (Partial<Track> & { id: number })[] = []
    const savedNow = new Set<number>()

    function applyToTrack(track: Track, fields: string[]): void {
      const columns: Record<string, unknown> = {}
      const meta: EditTagsMeta = {}
      for (const field of fields) {
        const value = columnValue(field, textValues[field])
        columns[field] = value
        meta[fieldToMetaKey(field)] = (value ?? '') as never
      }
      updateTrack(track.id, columns as Partial<Track>)
      collectFileWrite(fileWrites, track, meta)
      pendingDbWrites.push({ id: track.id, ...columns } as Partial<Track> & { id: number })
      savedNow.add(track.id)
    }

    try {
      // This track: every text field that was actually typed into.
      const editedFields = EDITABLE_TEXT_FIELDS.filter(
        (field) => textValues[field] !== undefined
      )
      if (editedFields.length > 0) applyToTrack(currentTrack, editedFields)

      // Every other selected track: only the fields whose checkbox is on.
      const bulkFields = options.bulk
        ? editedFields.filter((field) => checkedFields.has(field))
        : []
      if (bulkFields.length > 0) {
        for (const trackId of trackIds) {
          if (trackId === currentTrack.id) continue
          const track = tracks.find((t) => t.id === trackId)
          if (track) applyToTrack(track, bulkFields)
        }
      }

      // Bulk apply checked tag fields: copy this track's badges for that
      // field onto every other selected track. TagInput already saved this
      // track's own badges — to its row and to its file — when they were
      // added, so this only has to replicate them onto the rest.
      const checkedTagFields = options.bulk
        ? TAG_FIELDS.filter(({ field }) => checkedFields.has(field))
        : []
      if (checkedTagFields.length > 0) {
        const currentTags = await window.api.tags.forTrack(currentTrack.id)

        for (const { field } of checkedTagFields) {
          const tagsForField = currentTags.filter((t) => t.field === field)
          if (tagsForField.length === 0) continue

          // Same separator TagInput uses, so a field written here and one
          // written there read back identically.
          const joined = tagsForField.map((t) => t.value).join(' / ')

          for (const trackId of trackIds) {
            if (trackId === currentTrack.id) continue
            const track = tracks.find((t) => t.id === trackId)
            if (!track) continue

            for (const tag of tagsForField) {
              await window.api.tags.apply(trackId, tag.id)
            }

            const existingTags = await window.api.tags.forTrack(trackId)
            useLibraryStore.getState().setTrackTags(trackId, existingTags)

            updateTrack(trackId, { [field]: joined } as Partial<Track>)
            pendingDbWrites.push({ id: trackId, [field]: joined })
            collectFileWrite(fileWrites, track, { [fieldToMetaKey(field)]: joined })
            savedNow.add(trackId)
          }
        }
      }

      // Stage, onto the rest of the selection. Its own path: updateBoardId
      // rather than updateTrackMeta, and no file write at all.
      if (options.bulk && isBulk && checkedFields.has('stage')) {
        // Land this track's own debounced write first, so the value being
        // copied is the one actually in the database.
        await flushStageWrites()
        const stageId = currentTrack.board_id
        for (const trackId of trackIds) {
          if (trackId === currentTrack.id) continue
          updateTrack(trackId, { board_id: stageId })
          const result = await window.api.db.updateBoardId(trackId, stageId)
          if (!result.ok) {
            setSaveState('error')
            toast.error('Could not save stage', { description: result.error ?? 'Unknown error' })
            return
          }
          savedNow.add(trackId)
        }
      }

      for (const write of pendingDbWrites) {
        const result = await window.api.db.updateTrackMeta(write)
        if (!result.ok) {
          setSaveState('error')
          toast.error('Could not save changes', { description: result.error ?? 'Unknown error' })
          return
        }
      }

      if (fileWrites.size > 0) {
        try {
          await window.api.editTagsBatch(Array.from(fileWrites.values()))
        } catch (err) {
          console.error('[BulkEditModal] editTagsBatch failed:', err)
          setSaveState('error')
          toast.error('Could not save to files', { description: (err as Error).message })
          return
        }
      }

      // Nothing to write is still a successful save — it just means the user
      // only touched tag badges, which saved themselves on the way in.
      if (savedNow.size > 0) {
        setSavedIds((prev) => new Set([...prev, ...savedNow]))
        const skipped = skippedFileWrites.current.size
        // No toast for an ordinary autosave — the footer indicator is the
        // feedback, and a toast per typing pause would be unusable. Bulk
        // applies and file-write problems still speak up, because both are
        // things the DJ would otherwise have no way of noticing.
        if (options.bulk) {
          toast.success(`Applied to ${savedNow.size} tracks`)
        } else if (skipped > 0) {
          toast.warning(
            `${skipped} file${skipped === 1 ? '' : 's'} could not be written`,
            { description: 'Not on disk. The change is saved in CrateCloud.' }
          )
        }
      }
      setTextValues({})
      setSaveState('saved')
    } finally {
      setSaving(false)
    }
  }

  // A file that is not on disk cannot be measured, so the button says that
  // instead of offering an analysis that can only fail.
  const fileMissing = currentTrack?.missing === 1

  // Reuses the shared per-track routine, so this writes the same columns the
  // ⋮ menu's Re-analyze and the BulkBar's do — and shows its progress on the
  // track's card through the same store entry.
  async function runAnalysis(): Promise<void> {
    if (!currentTrack || analyzing) return
    setAnalyzing(true)
    try {
      const outcome = await reanalyzeTrack(currentTrack.id)
      if (outcome === 'failed') {
        toast.error('Could not analyze this track')
      } else if (outcome === 'skipped') {
        toast.error('Nothing to analyze', { description: 'The file is missing.' })
      }
      // On success the store row gains bpm/key, so the stand-in rows are
      // replaced by inputs carrying the measured values.
    } finally {
      setAnalyzing(false)
    }
  }

  // ── Autosave ─────────────────────────────────────────────
  // Fires once typing has been still for AUTOSAVE_MS. The timer is restarted
  // by every keystroke, so a burst of typing costs one save rather than one
  // per character — which matters because each save reaches the audio file
  // through edit_tags.py, not just the database.
  //
  // The save is kicked off from the timer callback, not from the effect body:
  // calling it inline is a cascading render (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!open || !isDirty || saving) return
    const timer = setTimeout(() => {
      void save({ bulk: false })
    }, AUTOSAVE_MS)
    return () => clearTimeout(timer)
    // `save` is redeclared every render; depending on it would restart the
    // timer constantly and nothing would ever autosave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isDirty, saving, textValues])

  // Lets the "Saved" tick fade back to idle instead of sitting there forever
  // implying something just happened.
  useEffect(() => {
    if (saveState !== 'saved') return
    const timer = setTimeout(() => setSaveState('idle'), SAVED_FLASH_MS)
    return () => clearTimeout(timer)
  }, [saveState])

  // ── Keyboard ─────────────────────────────────────────────
  // Arrow keys are ignored while focus is in a text field so they can move
  // the caret. The modified keys are not: they cannot collide with typing,
  // and being able to leave the field without reaching for the mouse is the
  // whole point of them.
  useEffect(() => {
    function handleKey(e: KeyboardEvent): void {
      if (!open) return
      const modified = e.metaKey || e.ctrlKey

      // Both used to mean "save". Edits save themselves now, so these are
      // navigation — each flushing first, like every other way out.
      if (modified && e.key === 'Enter') {
        e.preventDefault()
        if (isLast) requestClose()
        else goNext()
        return
      }
      if (modified && e.key.toLowerCase() === 's') {
        e.preventDefault()
        requestClose()
        return
      }

      const target = e.target as HTMLElement | null
      const typing =
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')

      if (e.key === 'Escape') {
        e.preventDefault()
        requestClose()
        return
      }
      if (typing) return
      if (e.key === 'ArrowLeft') goPrev()
      if (e.key === 'ArrowRight') goNext()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  })

  if (!currentTrack) return null

  const bulkCount = trackIds.length
  const isBulk = bulkCount > 1
  const savedCount = trackIds.filter((id) => savedIds.has(id)).length

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose()
      }}
    >
      <DialogContent
        showCloseButton={false}
        // Radix focuses the first focusable child on open, which is the
        // Genre tag input — and TagInput opens its dropdown on focus, so the
        // modal appeared with a suggestion list covering its own fields.
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Escape is handled by the keydown listener above so it goes through
        // requestClose, which flushes first.
        onEscapeKeyDown={(e) => e.preventDefault()}
        // Clicking away used to be blocked while there were unsaved edits.
        // There are none now — the click closes, flushing whatever was typed
        // on the way out.
        onInteractOutside={(e) => {
          e.preventDefault()
          requestClose()
        }}
        style={{
          background: '#13131b',
          border: '0.5px solid #1e1e2a',
          borderRadius: '12px',
          maxWidth: '620px',
          width: '100%',
          maxHeight: '85vh',
          color: '#e8e8f0',
          fontFamily: 'inherit',
          padding: 0,
          gap: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}
      >
        {/* ── Header ────────────────────────────────── */}
        <div style={{ flexShrink: 0, borderBottom: '0.5px solid #1e1e2a' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px'
            }}
          >
            <NavButton onClick={goPrev} disabled={isFirst} label="Previous track">
              <ChevronLeft size={16} />
            </NavButton>

            <div style={{ textAlign: 'center', minWidth: 0 }}>
              <div style={{ fontSize: '12px', color: '#8a8aa0' }}>
                {isBulk ? `Track ${currentIndex + 1} of ${bulkCount}` : 'Edit labels'}
              </div>
              {isBulk && (
                <div style={{ fontSize: '10px', color: '#4a4a5c', marginTop: '2px' }}>
                  {savedCount === 0
                    ? 'None saved yet'
                    : `${savedCount} of ${bulkCount} saved`}
                </div>
              )}
            </div>

            <NavButton onClick={goNext} disabled={isLast} label="Next track">
              <ChevronRight size={16} />
            </NavButton>
          </div>

          {/* Progress through the selection — how much of this pass is done */}
          {isBulk && (
            <div style={{ height: '2px', background: '#1a1a26' }}>
              <div
                style={{
                  height: '100%',
                  width: `${(savedCount / bulkCount) * 100}%`,
                  background: ACCENT,
                  transition: 'width 0.2s ease'
                }}
              />
            </div>
          )}
        </div>

        {/* ── Track header ──────────────────────────── */}
        <div
          style={{
            display: 'flex',
            gap: '12px',
            padding: '12px 16px',
            borderBottom: '0.5px solid #1e1e2a',
            flexShrink: 0
          }}
        >
          <div
            style={{
              width: '84px',
              height: '84px',
              borderRadius: '6px',
              overflow: 'hidden',
              background: '#1e1e2a',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            {artworkUrl ? (
              <img
                src={artworkUrl}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <span style={{ fontSize: '24px', color: '#333' }}>♪</span>
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                fontSize: '14px',
                fontWeight: 500,
                marginBottom: '3px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {currentTrack.title ?? currentTrack.filename ?? 'Untitled'}
            </div>
            <div
              style={{
                fontSize: '12px',
                color: '#555',
                marginBottom: '8px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {currentTrack.artist ?? 'Unknown artist'}
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
              {/* The only way to set BPM and key. Offered whenever either is
                  missing, because one pass fills both; hidden once they are
                  known, where the ⋮ menu's Re-analyze is the deliberate way
                  to redo it. */}
              {(!currentTrack.bpm || !currentTrack.key_camelot) && (
                <button
                  type="button"
                  onClick={() => void runAnalysis()}
                  disabled={analyzing || fileMissing}
                  title={
                    fileMissing
                      ? 'The file is not on disk, so it cannot be analyzed'
                      : 'Measure BPM and key from the audio'
                  }
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px',
                    background: 'none',
                    border: `0.5px solid ${fileMissing ? '#3a2422' : '#3a3060'}`,
                    borderRadius: '999px',
                    color: fileMissing ? '#6a4a46' : analyzing ? '#5a5a70' : '#a09be8',
                    fontSize: '10px',
                    padding: '2px 9px',
                    height: '20px',
                    cursor: analyzing || fileMissing ? 'default' : 'pointer',
                    fontFamily: 'inherit'
                  }}
                >
                  <Activity size={11} />
                  {fileMissing
                    ? 'File missing'
                    : analyzing
                      ? 'Analyzing…'
                      : currentTrack.bpm || currentTrack.key_camelot
                        ? `Analyze for ${currentTrack.bpm ? 'key' : 'BPM'}`
                        : 'Analyze BPM + key'}
                </button>
              )}
              {currentTrack.bpm && (
                <Badge
                  variant="outline"
                  style={{
                    fontSize: '10px',
                    background: '#1a2535',
                    color: '#5d9fd8',
                    borderColor: '#1a2535'
                  }}
                >
                  {currentTrack.bpm} BPM
                </Badge>
              )}
              {currentTrack.key_camelot && (
                <Badge
                  variant="outline"
                  style={{
                    fontSize: '10px',
                    background: '#1a2830',
                    color: '#3db88a',
                    borderColor: '#1a2830'
                  }}
                >
                  {currentTrack.key_camelot}
                </Badge>
              )}
              {savedIds.has(currentTrack.id) && (
                <Badge
                  variant="outline"
                  style={{
                    fontSize: '10px',
                    background: '#1b2a22',
                    color: '#3db88a',
                    borderColor: '#1b2a22',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '3px'
                  }}
                >
                  <Check size={9} /> Saved
                </Badge>
              )}
            </div>
          </div>
        </div>

        {/* ── Fields ───────────────────────────────── */}
        <div style={{ padding: '14px 16px 18px', overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {/* Both rules live here, above the scroll fold, rather than as a
              footnote at the bottom of a list long enough to hide it. */}
          <div
            style={{
              fontSize: '11px',
              color: '#6a6a80',
              marginBottom: '14px',
              padding: '8px 10px',
              background: '#1a1a26',
              borderRadius: '6px',
              borderLeft: `2px solid ${ACCENT}`,
              lineHeight: 1.6
            }}
          >
            {isBulk && (
              <div style={{ marginBottom: '4px' }}>
                Tick a field to apply it to all {bulkCount} selected tracks. Unticked fields
                only change this one.
              </div>
            )}
            <div style={{ color: '#55556a' }}>
              Tag badges save as you add them. BPM, key and year save when you press one of
              the save buttons.
            </div>
          </div>

          {/* Stage. Cycling the pill saves THIS track straight away, the
              way it does on a row or a card — the checkbox is only about
              copying that stage onto the rest of the selection when you
              save. Deliberately not routed through applyToTrack: a stage is
              CrateCloud's own workflow column, not a tag, and nothing about
              it belongs in the audio file. */}
          <FieldRow
            showCheckbox={isBulk}
            checked={checkedFields.has('stage')}
            onToggle={() => toggleField('stage')}
            color={ACCENT}
          >
            <InlineLabel text={STAGE_NOUN} dirty={false} />
            <StagePill track={currentTrack} variant="pill" size="md" />
          </FieldRow>

          {TAG_FIELDS.map(({ field, label, color }) => (
            <FieldRow
              key={field}
              showCheckbox={isBulk}
              checked={checkedFields.has(field)}
              onToggle={() => toggleField(field)}
              color={color}
              align="flex-start"
              checkboxOffset="20px"
            >
              <TagInput trackId={currentTrack.id} field={field} label={label} color={color} />
            </FieldRow>
          ))}

          {/* BPM and key are measured, not typed. An unanalysed track shows
              the way to fill them rather than two empty boxes asking the DJ
              to guess — nobody types a Camelot key from memory, and a hand-
              entered BPM is exactly the kind of wrong value that survives
              forever because nothing ever re-checks it. */}
          {/* BPM and key are NOT edited here. They are measured, not typed —
              nobody enters a Camelot key from memory, and a hand-typed BPM
              is the kind of wrong value that survives forever because
              nothing re-checks it. They live as badges in the header, with
              the Analyze button that fills them. */}

          {/* Year — a select rather than free text, but the same row shape */}
          <FieldRow
            showCheckbox={isBulk}
            checked={checkedFields.has('year')}
            onToggle={() => toggleField('year')}
            color={ACCENT}
          >
            <InlineLabel text="Year" dirty={dirtyFields.includes('year')} />
            <select
              key={`${currentTrack.id}-year`}
              // No fallback to the current year: defaulting an untagged
              // track to "now" and saving would stamp a wrong release year
              // across the whole selection.
              defaultValue={currentTrack.year ?? ''}
              onChange={(e) => setTextValues((prev) => ({ ...prev, year: e.target.value }))}
              style={{ ...fieldControlStyle(dirtyFields.includes('year')), cursor: 'pointer' }}
              onFocus={(e) => (e.target.style.borderColor = ACCENT)}
              onBlur={(e) =>
                (e.target.style.borderColor = dirtyFields.includes('year') ? ACCENT : '#252535')
              }
            >
              <option value="">—</option>
              {YEARS.map((year) => (
                <option key={year} value={String(year)}>
                  {year}
                </option>
              ))}
            </select>
          </FieldRow>
        </div>

        {/* ── Footer ───────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderTop: '0.5px solid #1e1e2a',
            flexShrink: 0,
            gap: '10px'
          }}
        >
          {/* Left: what a bulk apply would do, if anything is ticked. */}
          <div style={{ fontSize: '11px', color: '#5a5a70', minWidth: 0 }}>
            {checkedFields.size > 0 ? (
              <span style={{ color: '#a09be8' }}>
                {checkedFields.size} field{checkedFields.size > 1 ? 's' : ''} ready to apply to all{' '}
                {bulkCount}
              </span>
            ) : (
              'Changes save as you type'
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
            <SaveIndicator state={saveState} />

            {/* The one thing that is NOT autosaved. Ticking a checkbox and
                having fifty files rewritten under you a second later is not
                a save, it is an accident — so this stays a deliberate act. */}
            {checkedFields.size > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                disabled={saving}
                onClick={() => void save({ bulk: true })}
                style={{ borderColor: ACCENT, color: '#a09be8' }}
                title={`Apply the ticked fields to all ${bulkCount} selected tracks`}
              >
                Apply to all {bulkCount}
              </Button>
            )}

            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={requestClose}
              style={{ color: '#8a8aa0' }}
              title="Close (⌘S or Esc) — anything typed is saved first"
            >
              Done
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Every free-text field the modal writes. BPM and key are deliberately
// absent: they are measured by the sidecar and shown as header badges, not
// typed, so nothing here can put a hand-entered value into those columns.
const EDITABLE_TEXT_FIELDS = ['year']

// ─── Small pieces ─────────────────────────────────────────

function fieldControlStyle(dirty: boolean): React.CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    background: '#1a1a26',
    border: `0.5px solid ${dirty ? ACCENT : '#252535'}`,
    borderRadius: '5px',
    padding: '5px 8px',
    color: '#c0c0d8',
    fontSize: '12px',
    fontFamily: 'monospace',
    outline: 'none'
  }
}

function InlineLabel({ text, dirty }: { text: string; dirty: boolean }): React.JSX.Element {
  return (
    <div
      style={{
        fontSize: '10px',
        fontWeight: 500,
        letterSpacing: '0.8px',
        textTransform: 'uppercase',
        color: dirty ? '#a09be8' : '#444',
        minWidth: '52px',
        flexShrink: 0
      }}
    >
      {text}
    </div>
  )
}

function NavButton({
  onClick,
  disabled,
  label,
  children
}: {
  onClick: () => void
  disabled: boolean
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{
        background: 'none',
        border: 'none',
        color: disabled ? '#2e2e3a' : ACCENT,
        cursor: disabled ? 'default' : 'pointer',
        padding: '4px 8px',
        display: 'flex',
        alignItems: 'center'
      }}
    >
      {children}
    </button>
  )
}

// One row shape for every field, so the bulk-apply checkbox, the label and
// the control line up whether the control is a tag input, a text box or a
// select.
function FieldRow({
  showCheckbox,
  checked,
  onToggle,
  color,
  align = 'center',
  checkboxOffset,
  children
}: {
  showCheckbox: boolean
  checked: boolean
  onToggle: () => void
  color: string
  align?: 'center' | 'flex-start'
  checkboxOffset?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: align,
        gap: '10px',
        marginBottom: '12px'
      }}
    >
      {showCheckbox && (
        <button
          onClick={onToggle}
          role="checkbox"
          aria-checked={checked}
          aria-label="Apply this field to every selected track"
          title="Apply this field to every selected track"
          style={{
            width: '16px',
            height: '16px',
            padding: 0,
            borderRadius: '3px',
            border: `0.5px solid ${checked ? color : '#333'}`,
            background: checked ? color : 'none',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            marginTop: checkboxOffset,
            transition: 'all 0.1s'
          }}
        >
          {checked && <Check size={10} color="#fff" />}
        </button>
      )}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: align === 'center' ? 'center' : 'stretch',
          gap: '10px',
          flexDirection: align === 'center' ? 'row' : 'column'
        }}
      >
        {children}
      </div>
    </div>
  )
}

// ─── SaveIndicator ────────────────────────────────────────
// Replaces the Save buttons. It has to answer one question — "did that land?"
// — without stealing attention while a DJ is typing, so idle is near-silent
// and only the moments worth noticing get colour.
function SaveIndicator({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }): React.JSX.Element | null {
  if (state === 'idle') return null

  const { text, color } =
    state === 'saving'
      ? { text: 'Saving…', color: '#6a6a80' }
      : state === 'saved'
        ? { text: '✓ Saved', color: '#1d9e75' }
        : { text: '⚠ Not saved', color: '#d8695d' }

  return (
    <span
      role="status"
      aria-live="polite"
      style={{
        fontSize: '11px',
        color,
        whiteSpace: 'nowrap',
        // Held at a fixed width so the footer's buttons do not shuffle
        // sideways every time the text changes.
        minWidth: '64px',
        textAlign: 'right',
        transition: 'color 0.2s ease'
      }}
    >
      {text}
    </span>
  )
}


