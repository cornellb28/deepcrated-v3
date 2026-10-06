import React from 'react'
import { FolderX } from 'lucide-react'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'

interface DeleteCrateConfirmDialogProps {
  open: boolean
  crateName: string
  hasChildren: boolean
  onConfirm: () => void
  onCancel: () => void
}

// Same confirm-before-acting convention as DeleteFileConfirmDialog, but for
// a crate: deleting a crate never touches the tracks in it (only the
// crate_tracks rows), it just stops grouping them — the copy here says so
// explicitly since "delete" reads as more destructive than it is.
export function DeleteCrateConfirmDialog({
  open,
  crateName,
  hasChildren,
  onConfirm,
  onCancel
}: DeleteCrateConfirmDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent
        style={{
          background: '#13131b',
          border: '0.5px solid #1e1e2a',
          borderRadius: '12px',
          maxWidth: '380px',
          width: '100%',
          color: '#e8e8f0',
          fontFamily: 'inherit',
          padding: '20px'
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            color: '#d8695d',
            marginBottom: '12px'
          }}
        >
          <FolderX size={26} />
        </div>

        <div
          style={{ fontSize: '14px', fontWeight: 500, textAlign: 'center', marginBottom: '8px' }}
        >
          Delete crate
        </div>

        <div
          style={{
            fontSize: '12px',
            color: '#555',
            textAlign: 'center',
            marginBottom: '20px',
            lineHeight: 1.5
          }}
        >
          &ldquo;{crateName}&rdquo;{hasChildren ? ' and its subcrates' : ''} will be deleted. Tracks
          stay in your library — only the crate grouping goes away.
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            className="flex-1 text-xs"
            style={{ color: '#555' }}
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onConfirm}
            className="flex-1 text-xs"
            style={{ borderColor: '#d8695d', color: '#e08a80' }}
          >
            Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
