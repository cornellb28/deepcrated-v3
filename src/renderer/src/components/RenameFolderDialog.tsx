// ── Rename a folder ───────────────────────────────────────────────────────
// Folders mirror real directories in v3, so this renames the directory on
// disk and repoints everything underneath — subfolders and every track's
// filepath — in one transaction. The dialog says so plainly, because
// "rename" in most apps means a label and here it means the disk.

import React, { useState } from 'react'
import { toast } from 'sonner'
import { FolderPen } from 'lucide-react'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'

const ACCENT = '#7f77dd'

interface RenameFolderDialogProps {
  open: boolean
  folderId: number
  currentName: string
  trackCount: number
  subfolderCount: number
  // A library root. Worth saying out loud in the dialog: the watcher moves
  // with it, which is not obvious and is the thing a DJ would worry about.
  isWatchedFolder?: boolean
  onClose: () => void
  onRenamed: () => void
}

export function RenameFolderDialog({
  open,
  folderId,
  currentName,
  trackCount,
  subfolderCount,
  isWatchedFolder = false,
  onClose,
  onRenamed
}: RenameFolderDialogProps): React.JSX.Element {
  const [name, setName] = useState(currentName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [lastOpen, setLastOpen] = useState(open)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) {
      setName(currentName)
      setError(null)
      setBusy(false)
    }
  }

  const trimmed = name.trim()
  const invalid = trimmed.includes('/') || trimmed.includes('\\')
  const unchanged = trimmed === currentName
  const canRename = trimmed.length > 0 && !invalid && !unchanged && !busy

  async function submit(): Promise<void> {
    if (!canRename) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.fs.renameFolder(folderId, trimmed)
      if (!result.ok) {
        setError(result.error ?? 'Unknown error')
        return
      }
      toast.success(`Renamed to “${trimmed}”`, {
        description:
          result.tracksUpdated
            ? `${result.tracksUpdated} track${result.tracksUpdated === 1 ? '' : 's'} repointed.`
            : undefined
      })
      onRenamed()
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        showCloseButton={false}
        style={{
          background: '#17171f',
          border: '0.5px solid #2e2e3e',
          borderRadius: '12px',
          maxWidth: '420px',
          width: '100%',
          color: '#e8e8f0',
          fontFamily: 'inherit',
          padding: '20px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '4px' }}>
          <FolderPen size={15} style={{ color: ACCENT }} />
          <span style={{ fontSize: '14px', fontWeight: 500 }}>Rename folder</span>
        </div>
        <div style={{ fontSize: '11px', color: '#555', marginBottom: '14px', lineHeight: 1.5 }}>
          {isWatchedFolder
            ? 'This renames the watched folder on your drive and follows it there — CrateCloud keeps watching it under the new name.'
            : 'This renames the folder on your drive, not just here.'}
          {trackCount > 0 && ` ${trackCount} track${trackCount === 1 ? '' : 's'}`}
          {subfolderCount > 0 &&
            `${trackCount > 0 ? ' and' : ' '} ${subfolderCount} subfolder${
              subfolderCount === 1 ? '' : 's'
            }`}
          {(trackCount > 0 || subfolderCount > 0) && ' will follow it.'}
        </div>

        <input
          autoFocus
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          onFocus={(e) => e.target.select()}
          style={{
            width: '100%',
            background: '#0e0e12',
            border: `0.5px solid ${invalid ? '#ba7517' : '#333'}`,
            borderRadius: '6px',
            color: '#e8e8f0',
            fontSize: '13px',
            padding: '8px 10px',
            fontFamily: 'inherit',
            outline: 'none'
          }}
        />

        {invalid && (
          <div style={{ fontSize: '11px', color: '#ba7517', marginTop: '6px' }}>
            A folder name cannot contain slashes.
          </div>
        )}

        {error && (
          <div
            role="alert"
            style={{
              marginTop: '12px',
              padding: '8px 10px',
              borderRadius: '6px',
              background: '#2a1a18',
              border: '0.5px solid #d8695d55',
              color: '#e0a49c',
              fontSize: '11px',
              lineHeight: 1.5
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={!canRename}>
            {busy ? 'Renaming…' : 'Rename'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
