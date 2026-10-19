// ── Metadata Cleanup: files and history ───────────────────────────────────
// CleanupFiles   the file write for one batch, always its own confirmation:
//                three files first, checked in Serato, then the rest
// CleanupHistory every batch, with "Undo this cleanup" (files included,
//                again behind their own confirmation)
// The writes themselves are the usual edit-tags job, so progress shows in
// the background-jobs panel.

import React, { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import type { BatchInfo, UndoSummary } from '../../../shared/tagCleanup'
import { useTagCleanupStore } from '../store/useTagCleanupStore'
import { refreshArtists as refreshLibrary } from '../lib/refreshArtists'

const CANARY_FILES = 3 // matches CLEANUP_CANARY_FILES in main

const muted: React.CSSProperties = { fontSize: '11px', color: '#555', lineHeight: 1.6 }
const text: React.CSSProperties = { fontSize: '12px', color: '#c0c0d8', lineHeight: 1.6 }

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function CleanupFiles({ batchId }: { batchId: string }): React.JSX.Element {
  const version = useTagCleanupStore((s) => s.version)
  const canaryPaths = useTagCleanupStore((s) => s.canaryPaths[batchId])
  const setCanaryPaths = useTagCleanupStore((s) => s.setCanaryPaths)
  const [counts, setCounts] = useState<{ toWrite: number; toRestore: number } | null>(null)
  const [status, setStatus] = useState<string>('none')
  const [confirming, setConfirming] = useState<'canary' | 'rest' | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.api.tagCleanup.fileCounts(batchId),
      window.api.tagCleanup.batches()
    ]).then(([c, b]) => {
      if (cancelled) return
      if (c.ok) setCounts(c.result)
      if (b.ok) setStatus(b.result.find((x) => x.id === batchId)?.filesStatus ?? 'none')
    })
    return () => {
      cancelled = true
    }
  }, [batchId, version])

  async function write(mode: 'canary' | 'rest'): Promise<void> {
    setConfirming(null)
    setStatus('writing')
    const r = await window.api.tagCleanup.writeFiles(batchId, mode)
    if (!r.ok) {
      toast.error('Could not start writing files', { description: r.error })
      setStatus('partial')
      return
    }
    if (mode === 'canary') setCanaryPaths(batchId, r.result.filepaths)
  }

  if (counts === null) return <div style={muted}>Checking files…</div>
  const left = counts.toWrite

  if (status === 'writing') {
    return <div style={text}>Writing tags to files… progress is in Background jobs.</div>
  }
  if (left === 0 && (status === 'written' || status === 'canary' || status === 'partial')) {
    return <div style={text}>All files written.</div>
  }
  if (left === 0) return <div style={muted}>No files to write.</div>

  if (confirming) {
    const n = confirming === 'canary' ? Math.min(CANARY_FILES, left) : left
    return (
      <div
        data-testid="cleanup-files-confirm"
        style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
      >
        <div style={text}>
          Write the cleaned tags into {plural(n, 'audio file')}? This changes the files themselves
          (genre and comment), the same way an edit in the Inspector does.
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <Button size="sm" data-testid="cleanup-files-go" onClick={() => void write(confirming)}>
            Write {plural(n, 'file')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  if (status === 'canary') {
    return (
      <div
        data-testid="cleanup-canary"
        style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
      >
        <div style={text}>
          {canaryPaths
            ? `Written to ${plural(canaryPaths.length, 'file')}. Open ${canaryPaths.length === 1 ? 'it' : 'them'} in Serato and check the genre and comment before writing the rest:`
            : `The first files are written. Check them in Serato before writing the rest.`}
        </div>
        {canaryPaths && (
          <ul style={{ ...muted, margin: 0, paddingLeft: '18px' }}>
            {canaryPaths.map((p) => (
              <li key={p} title={p}>
                {fileName(p)}
              </li>
            ))}
          </ul>
        )}
        <div style={{ display: 'flex', gap: '6px' }}>
          <Button size="sm" data-testid="cleanup-files-rest" onClick={() => setConfirming('rest')}>
            They look right: write the other {plural(left, 'file')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={text}>
        {status === 'partial'
          ? `${plural(left, 'file')} still to write (some could not be written; see Background jobs).`
          : `${plural(left, 'file')} can be updated to match. The first ${Math.min(CANARY_FILES, left)} are written on their own so you can check them in Serato.`}
      </div>
      <div>
        <Button
          size="sm"
          variant="outline"
          data-testid="cleanup-files-start"
          onClick={() => setConfirming(status === 'partial' ? 'rest' : 'canary')}
        >
          {status === 'partial' ? 'Try again' : `Write ${Math.min(CANARY_FILES, left)} files first`}
        </Button>
      </div>
    </div>
  )
}

// ── History and undo ──────────────────────────────────────────────────────

function UndoControl({ batch }: { batch: BatchInfo }): React.JSX.Element {
  const changed = useTagCleanupStore((s) => s.changed)
  const [preview, setPreview] = useState<UndoSummary | null>(null)
  const [restoreFiles, setRestoreFiles] = useState<number>(0)
  const [busy, setBusy] = useState(false)

  async function check(): Promise<void> {
    setBusy(true)
    const r = await window.api.tagCleanup.undo(batch.id, true)
    setBusy(false)
    if (!r.ok) toast.error('Could not check this cleanup', { description: r.error })
    else setPreview(r.result)
  }

  async function undo(): Promise<void> {
    setBusy(true)
    const r = await window.api.tagCleanup.undo(batch.id, false)
    setBusy(false)
    setPreview(null)
    if (!r.ok) {
      toast.error('Could not undo this cleanup', { description: r.error })
      return
    }
    toast.success(
      `${plural(r.result.restored, 'track')} put back${r.result.skipped.length ? ` · ${r.result.skipped.length} edited since, kept` : ''}`
    )
    setRestoreFiles(r.result.filesToRestore)
    changed()
    await refreshLibrary()
  }

  async function restore(): Promise<void> {
    setRestoreFiles(0)
    const r = await window.api.tagCleanup.restoreFiles(batch.id)
    if (!r.ok) toast.error('Could not start restoring files', { description: r.error })
  }

  if (restoreFiles > 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={text}>
          {plural(restoreFiles, 'file')} had the cleaned tags written. Put their original tags back
          too?
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <Button size="sm" data-testid="cleanup-restore-files" onClick={() => void restore()}>
            Restore {plural(restoreFiles, 'file')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setRestoreFiles(0)}>
            Leave files as they are
          </Button>
        </div>
      </div>
    )
  }
  if (preview) {
    return (
      <div
        data-testid="cleanup-undo-confirm"
        style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}
      >
        <div style={text}>
          Put back {plural(preview.restored, 'track')}?
          {preview.skipped.length > 0 &&
            ` ${plural(preview.skipped.length, 'track')} edited since will keep the edit.`}
          {preview.filesToRestore > 0 &&
            ` ${plural(preview.filesToRestore, 'file')} can be restored after, on its own confirmation.`}
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <Button
            size="sm"
            data-testid="cleanup-undo-go"
            disabled={busy}
            onClick={() => void undo()}
          >
            Undo this cleanup
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setPreview(null)}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid="cleanup-undo"
      disabled={busy}
      onClick={() => void check()}
    >
      Undo this cleanup…
    </Button>
  )
}

export function CleanupHistory(): React.JSX.Element {
  const version = useTagCleanupStore((s) => s.version)
  const [batches, setBatches] = useState<BatchInfo[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.tagCleanup.batches().then((r) => {
      if (!cancelled && r.ok) setBatches(r.result)
    })
    return () => {
      cancelled = true
    }
  }, [version])

  if (batches === null || batches.length === 0) return <></>
  return (
    <div
      data-testid="cleanup-history"
      style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
    >
      {batches.map((b) => (
        <div
          key={b.id}
          style={{
            background: '#1a1a26',
            border: '0.5px solid #252535',
            borderRadius: '6px',
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
            <div style={{ minWidth: 0 }}>
              <div style={text}>
                {new Date(b.createdAt * 1000).toLocaleString()} · {plural(b.changes, 'change')}
                {b.source === 'import' ? ' · new imports' : ''}
                {b.status === 'undone' ? ' · undone' : ''}
              </div>
              <div
                style={{
                  ...muted,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
              >
                {b.examples.map((e) => `${e.before ?? '—'} → ${e.after.join(' | ')}`).join(' · ')}
              </div>
            </div>
          </div>
          {b.status === 'applied' && (
            <>
              <CleanupFiles batchId={b.id} />
              <UndoControl batch={b} />
            </>
          )}
          {b.status === 'undone' && b.filesWritten > 0 && b.filesStatus !== 'restored' && (
            <UndoneFiles batchId={b.id} />
          )}
        </div>
      ))}
    </div>
  )
}

// An undone batch whose files were written but not yet restored.
function UndoneFiles({ batchId }: { batchId: string }): React.JSX.Element {
  const version = useTagCleanupStore((s) => s.version)
  const [left, setLeft] = useState(0)
  useEffect(() => {
    let cancelled = false
    void window.api.tagCleanup.fileCounts(batchId).then((r) => {
      if (!cancelled && r.ok) setLeft(r.result.toRestore)
    })
    return () => {
      cancelled = true
    }
  }, [batchId, version])
  if (left === 0) return <></>
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
      <span style={text}>{plural(left, 'file')} still hold the cleaned tags.</span>
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          void window.api.tagCleanup.restoreFiles(batchId).then((r) => {
            if (!r.ok) toast.error('Could not start restoring files', { description: r.error })
          })
        }
      >
        Restore {plural(left, 'file')}
      </Button>
    </div>
  )
}
