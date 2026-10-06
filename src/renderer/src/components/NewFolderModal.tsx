// ── New folder ────────────────────────────────────────────────────────────
// Names a new subfolder and, optionally, picks tracks to move into it in the
// same step — the two halves of "make a folder for this" that otherwise mean
// create it, navigate into it, go find the tracks, and move them.
//
// Both halves reuse what already exists: fs.createFolder does the mkdir plus
// ensureFolderForDirectory plus the folders:changed broadcast, and
// fs.moveFiles is the same job MoveToModal and the drag-and-drop path run.
// Nothing here talks to the database.

import React, { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Search } from 'lucide-react'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { useLibraryStore } from '../store/useLibraryStore'

// Enough to pick from without mounting the whole library into a dialog. The
// search box is the way to reach anything past this, and the footer says so.
const MAX_RESULTS = 60

interface NewFolderModalProps {
  parentPath: string
  parentName: string
  open: boolean
  onClose: () => void
  // Fired once the folder row exists, so FolderView can flash it in the grid.
  onCreated: (folderId: number | null) => void
}

export function NewFolderModal({
  parentPath,
  parentName,
  open,
  onClose,
  onCreated
}: NewFolderModalProps): React.JSX.Element {
  const { tracks, upsertJob } = useLibraryStore()

  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [crossDevice, setCrossDevice] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  // Reset when the dialog opens rather than in an effect — adjusting state
  // during render is the pattern BulkEditModal already uses here, and it
  // avoids a setState after paint.
  const [lastOpen, setLastOpen] = useState(open)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) {
      setName('')
      setQuery('')
      setChosen(new Set())
      setBusy(false)
      setCrossDevice(false)
    }
  }

  // A missing file has nothing on disk to move, so offering it would produce
  // a job that can only fail.
  const candidates = useMemo(() => tracks.filter((t) => !t.missing && t.filepath), [tracks])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = q
      ? candidates.filter(
          (t) =>
            t.title?.toLowerCase().includes(q) ||
            t.artist?.toLowerCase().includes(q) ||
            t.filename?.toLowerCase().includes(q)
        )
      : candidates
    return base.slice(0, MAX_RESULTS)
  }, [candidates, query])

  const totalMatches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return candidates.length
    return candidates.filter(
      (t) =>
        t.title?.toLowerCase().includes(q) ||
        t.artist?.toLowerCase().includes(q) ||
        t.filename?.toLowerCase().includes(q)
    ).length
  }, [candidates, query])

  const trimmed = name.trim()
  const nameError =
    trimmed.includes('/') || trimmed.includes('\\') ? 'Name cannot contain slashes' : null
  const canCreate = trimmed.length > 0 && !nameError && !busy

  async function toggle(trackId: number): Promise<void> {
    const next = new Set(chosen)
    if (next.has(trackId)) next.delete(trackId)
    else next.add(trackId)
    setChosen(next)

    // Checked against the PARENT, which exists now — the new folder will sit
    // inside it and is therefore on the same volume. Warning before the DJ
    // commits beats discovering it from a progress bar that will not end.
    if (next.size === 0) {
      setCrossDevice(false)
      return
    }
    const filepaths = tracks.filter((t) => next.has(t.id)).map((t) => t.filepath)
    const precheck = await window.api.fs.isCrossDevice(filepaths, parentPath)
    // A failed precheck is not worth blocking on: the move job reports any
    // real per-file error itself. It only means no warning is shown.
    setCrossDevice(precheck.ok && Boolean(precheck.crossDevice))
  }

  async function submit(): Promise<void> {
    if (!canCreate) return
    setBusy(true)

    try {
      const result = await window.api.fs.createFolder(parentPath, trimmed)
      if (!result.ok || !result.path) {
        toast.error('Could not create folder', { description: result.error ?? 'Unknown error' })
        return
      }

      const trackIds = Array.from(chosen)

      // The folder is made either way. A failed move leaves an empty folder
      // rather than rolling back something the DJ asked for and can see.
      if (trackIds.length > 0) {
        try {
          const { jobId } = await window.api.fs.moveFiles({
            trackIds,
            destAbsolutePath: result.path
          })
          upsertJob({
            type: 'move',
            jobId,
            trackIds,
            phase: 'running',
            done: 0,
            total: trackIds.length,
            currentFile: '',
            bytesCopied: 0,
            totalBytes: 0,
            crossDevice,
            failed: []
          })
          toast.success(`Created “${trimmed}”`, {
            description: `Moving ${trackIds.length} track${trackIds.length !== 1 ? 's' : ''} in…`
          })
        } catch (err) {
          toast.error('Folder created, but the move failed', {
            description: (err as Error).message
          })
        }
      } else if (result.folderId == null) {
        toast.warning(`Created “${trimmed}”`, { description: result.reason })
      } else {
        toast.success(`Created “${trimmed}”`)
      }

      onCreated(result.folderId ?? null)
      onClose()
    } catch (err) {
      toast.error('Could not create folder', { description: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          nameRef.current?.focus()
        }}
        style={{
          background: '#17171f',
          border: '0.5px solid #2e2e3e',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          borderRadius: '12px',
          maxWidth: '480px',
          width: '100%',
          maxHeight: '78vh',
          color: '#e8e8f0',
          fontFamily: 'inherit',
          padding: 0,
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        {/* ── Name ─────────────────────────────────────── */}
        <div style={{ padding: '18px 18px 14px', borderBottom: '0.5px solid #23232e' }}>
          <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '2px' }}>New folder</div>
          <div style={{ fontSize: '11px', color: '#555', marginBottom: '12px' }}>
            Inside {parentName}
          </div>

          <input
            ref={nameRef}
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            placeholder="Folder name"
            style={{
              width: '100%',
              background: '#0e0e12',
              border: `0.5px solid ${nameError ? '#ba7517' : '#333'}`,
              borderRadius: '6px',
              color: '#e8e8f0',
              fontSize: '13px',
              padding: '8px 10px',
              fontFamily: 'inherit',
              outline: 'none'
            }}
          />
          {nameError && (
            <div style={{ fontSize: '11px', color: '#ba7517', marginTop: '6px' }}>{nameError}</div>
          )}
        </div>

        {/* ── Find tracks ──────────────────────────────── */}
        <div style={{ padding: '14px 18px 10px' }}>
          <div
            style={{
              fontSize: '10px',
              fontWeight: 500,
              letterSpacing: '0.8px',
              textTransform: 'uppercase',
              color: '#444',
              marginBottom: '8px'
            }}
          >
            Add tracks — optional
          </div>

          <div style={{ position: 'relative' }}>
            <Search
              size={13}
              style={{
                position: 'absolute',
                left: '9px',
                top: '50%',
                transform: 'translateY(-50%)',
                color: '#444',
                pointerEvents: 'none'
              }}
            />
            <input
              value={query}
              disabled={busy}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title, artist or filename"
              style={{
                width: '100%',
                background: '#0e0e12',
                border: '0.5px solid #333',
                borderRadius: '6px',
                color: '#e8e8f0',
                fontSize: '12px',
                padding: '7px 10px 7px 28px',
                fontFamily: 'inherit',
                outline: 'none'
              }}
            />
          </div>
        </div>

        {/* ── Results ──────────────────────────────────── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 10px', minHeight: '120px' }}>
          {results.length === 0 ? (
            <div style={{ padding: '22px 8px', fontSize: '12px', color: '#444', textAlign: 'center' }}>
              {candidates.length === 0 ? 'No tracks in your library yet' : 'Nothing matches that'}
            </div>
          ) : (
            results.map((track) => {
              const picked = chosen.has(track.id)
              return (
                <button
                  key={track.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void toggle(track.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    width: '100%',
                    textAlign: 'left',
                    background: picked ? '#1e1b3a' : 'none',
                    border: 'none',
                    borderRadius: '6px',
                    padding: '7px 8px',
                    cursor: busy ? 'default' : 'pointer',
                    fontFamily: 'inherit'
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: '14px',
                      height: '14px',
                      borderRadius: '3px',
                      border: `1px solid ${picked ? '#7f77dd' : '#333'}`,
                      background: picked ? '#7f77dd' : 'transparent',
                      color: '#fff',
                      fontSize: '10px',
                      lineHeight: '13px',
                      textAlign: 'center',
                      flexShrink: 0
                    }}
                  >
                    {picked ? '✓' : ''}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: 'block',
                        fontSize: '12px',
                        color: '#e0e0f0',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}
                    >
                      {track.title ?? track.filename ?? 'Untitled'}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        fontSize: '10px',
                        color: '#555',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}
                    >
                      {track.artist ?? 'Unknown'}
                    </span>
                  </span>
                </button>
              )
            })
          )}

          {totalMatches > results.length && (
            <div style={{ padding: '8px', fontSize: '10px', color: '#3a3a48', textAlign: 'center' }}>
              Showing {results.length} of {totalMatches} — search to narrow it down
            </div>
          )}
        </div>

        {/* ── Footer ───────────────────────────────────── */}
        <div
          style={{
            padding: '12px 18px',
            borderTop: '0.5px solid #23232e',
            display: 'flex',
            alignItems: 'center',
            gap: '10px'
          }}
        >
          <div style={{ flex: 1, minWidth: 0, fontSize: '11px', color: '#555' }}>
            {chosen.size > 0 ? (
              <>
                {chosen.size} track{chosen.size !== 1 ? 's' : ''} will be{' '}
                <span style={{ color: '#ba7517' }}>moved</span> here
                {crossDevice && (
                  <div style={{ color: '#ba7517', marginTop: '3px' }}>
                    Different drive — this copies then deletes, and will take longer.
                  </div>
                )}
              </>
            ) : (
              'Creates an empty folder'
            )}
          </div>

          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={!canCreate}>
            {busy ? 'Creating…' : 'Create folder'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
