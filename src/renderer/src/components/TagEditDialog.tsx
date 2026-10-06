// ── Rename or delete a tag ────────────────────────────────────────────────
// Both operations reach every track carrying the tag, so both say how many
// before they happen. A tag on 200 tracks and a tag on one look identical in
// the cloud, and only one of them is a small decision.

import React, { useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'

const ACCENT = '#7f77dd'
const DANGER = '#d8695d'

interface TagEditDialogProps {
  open: boolean
  mode: 'rename' | 'delete'
  tag: Tag
  trackCount: number
  onRename: (newValue: string) => void
  onDelete: () => void
  onClose: () => void
}

export function TagEditDialog({
  open,
  mode,
  tag,
  trackCount,
  onRename,
  onDelete,
  onClose
}: TagEditDialogProps): React.JSX.Element {
  const [value, setValue] = useState(tag.value)
  const [busy, setBusy] = useState(false)

  const [lastTagId, setLastTagId] = useState(tag.id)
  if (tag.id !== lastTagId) {
    setLastTagId(tag.id)
    setValue(tag.value)
    setBusy(false)
  }

  const trimmed = value.trim()
  const unchanged = trimmed === tag.value
  const canRename = trimmed.length > 0 && !unchanged && !busy

  const tracks = `${trackCount} track${trackCount === 1 ? '' : 's'}`
  const isDelete = mode === 'delete'

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
          {isDelete ? (
            <Trash2 size={15} style={{ color: DANGER }} />
          ) : (
            <Pencil size={15} style={{ color: ACCENT }} />
          )}
          <span style={{ fontSize: '14px', fontWeight: 500 }}>
            {isDelete ? 'Delete tag' : 'Rename tag'}
          </span>
        </div>

        <div style={{ fontSize: '11px', color: '#555', marginBottom: '14px', lineHeight: 1.6 }}>
          <span
            style={{
              display: 'inline-block',
              background: `${tag.color}22`,
              border: `0.5px solid ${tag.color}44`,
              color: tag.color,
              borderRadius: '4px',
              padding: '1px 7px',
              marginRight: '6px',
              fontWeight: 500
            }}
          >
            {tag.value}
          </span>
          <span style={{ fontSize: '10px', textTransform: 'uppercase', color: '#444' }}>
            {tag.field}
          </span>
          <br />
          {isDelete
            ? trackCount > 0
              ? `Removes it from ${tracks}. The tracks themselves are untouched — only this tag goes, and their ${tag.field} is rewritten without it.`
              : 'Nothing is using this tag, so nothing else changes.'
            : trackCount > 0
              ? `Renaming updates ${tracks}. If the new name already exists, the two are merged.`
              : 'Nothing is using this tag yet.'}
        </div>

        {!isDelete && (
          <input
            autoFocus
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canRename) {
                setBusy(true)
                onRename(trimmed)
              }
            }}
            onFocus={(e) => e.target.select()}
            style={{
              width: '100%',
              background: '#0e0e12',
              border: '0.5px solid #333',
              borderRadius: '6px',
              color: '#e8e8f0',
              fontSize: '13px',
              padding: '8px 10px',
              fontFamily: 'inherit',
              outline: 'none'
            }}
          />
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {isDelete ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                onDelete()
              }}
              style={{ background: DANGER, color: '#fff' }}
            >
              {busy ? 'Deleting…' : 'Delete tag'}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!canRename}
              onClick={() => {
                setBusy(true)
                onRename(trimmed)
              }}
            >
              {busy ? 'Renaming…' : 'Rename'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
