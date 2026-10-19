// ── "Already in your library" ─────────────────────────────────────────────
// Shown instead of importing when a folder picked or dropped for import is
// already watched (a library folder, or a folder inside one), or holds
// folders that are. A watched folder is kept current by the watcher, so a
// fresh import would only re-read what is already there. Re-scanning stays
// one click away for when the DJ really wants it.

import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'

export interface WatchedAlertItem {
  path: string
  coverage: Exclude<FolderCoverage, { status: 'new' }>
}

function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path
  )
}

function explain(item: WatchedAlertItem): string {
  const name = folderName(item.path)
  const c = item.coverage
  if (c.status === 'watched') {
    return c.isRoot
      ? `“${name}” is already a watched folder.`
      : `“${name}” is inside “${c.root.name}”, a folder DeepCrated already watches.`
  }
  const names = c.roots.map((r) => `“${r.name}”`).join(', ')
  return `“${name}” holds ${c.roots.length === 1 ? 'a folder' : 'folders'} you already watch (${names}). Import a folder that isn't watched yet instead.`
}

export function AlreadyWatchedDialog({
  items,
  onClose,
  onShow,
  onRescan
}: {
  items: WatchedAlertItem[] | null
  onClose: () => void
  onShow: (folderPath: string) => void
  onRescan: (folderPath: string) => void
}): React.JSX.Element {
  const open = items !== null && items.length > 0
  // The actions only make sense for one watched folder at a time.
  const single =
    open && items.length === 1 && items[0].coverage.status === 'watched' ? items[0] : null

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        data-testid="already-watched"
        style={{
          background: '#13131b',
          border: '0.5px solid #1e1e2a',
          borderRadius: '12px',
          maxWidth: '440px',
          width: '100%',
          color: '#e8e8f0',
          padding: '20px'
        }}
      >
        <DialogTitle style={{ fontSize: '15px', fontWeight: 500 }}>
          {items && items.every((i) => i.coverage.status === 'watched')
            ? 'Already in your library'
            : 'Not imported'}
        </DialogTitle>
        <DialogDescription asChild>
          <div style={{ fontSize: '12px', color: '#a0a0b8', lineHeight: 1.6 }}>
            {items?.map((item) => (
              <p key={item.path} style={{ margin: '0 0 8px' }}>
                {explain(item)}
              </p>
            ))}
            {items?.some((i) => i.coverage.status === 'watched') && (
              <p style={{ margin: 0, color: '#6a6a80' }}>
                DeepCrated keeps watched folders up to date as files are added, moved or removed, so
                there is nothing new to import.
              </p>
            )}
          </div>
        </DialogDescription>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', marginTop: '16px' }}>
          {single && (
            <>
              <Button
                variant="ghost"
                size="sm"
                data-testid="already-watched-rescan"
                onClick={() => {
                  onClose()
                  onRescan(single.path)
                }}
              >
                Re-scan now
              </Button>
              <Button
                variant="outline"
                size="sm"
                data-testid="already-watched-show"
                onClick={() => {
                  onClose()
                  onShow(single.path)
                }}
              >
                Show in Folders
              </Button>
            </>
          )}
          <Button size="sm" autoFocus data-testid="already-watched-close" onClick={onClose}>
            OK
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
