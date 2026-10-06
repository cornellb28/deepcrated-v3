import React from 'react'
import { Trash2 } from 'lucide-react'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'

interface DeleteFileConfirmDialogProps {
  open: boolean
  trackTitle: string
  onConfirm: () => void
  onCancel: () => void
}

// Confirms before touching the file on disk — the same "about to affect a
// file on disk, confirm first" convention as MoveConfirmDialog, kept as its
// own component (rather than a shared shell) since the codebase already
// treats each of these dialogs as standalone.
export function DeleteFileConfirmDialog({
  open,
  trackTitle,
  onConfirm,
  onCancel
}: DeleteFileConfirmDialogProps): React.JSX.Element {
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
        {/* Icon */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            color: '#d8695d',
            marginBottom: '12px'
          }}
        >
          <Trash2 size={26} />
        </div>

        {/* Title */}
        <div
          style={{
            fontSize: '14px',
            fontWeight: 500,
            textAlign: 'center',
            marginBottom: '8px'
          }}
        >
          Delete from Hard Drive
        </div>

        {/* Description */}
        <div
          style={{
            fontSize: '12px',
            color: '#555',
            textAlign: 'center',
            marginBottom: '20px',
            lineHeight: 1.5
          }}
        >
          &ldquo;{trackTitle}&rdquo; will be moved to the Trash and removed from CrateCloud. This
          can&apos;t be undone from within CrateCloud.
        </div>

        {/* Buttons */}
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
            style={{
              borderColor: '#d8695d',
              color: '#e08a80'
            }}
          >
            Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
