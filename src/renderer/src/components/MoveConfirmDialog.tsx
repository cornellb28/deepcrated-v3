import React, { useState } from 'react'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'

interface MoveConfirmDialogProps {
  open: boolean
  title: string
  description: React.ReactNode
  confirmLabel?: string
  onConfirm: (dontAskAgain: boolean) => void
  onCancel: () => void
}

// "This is about to move a file on disk, confirm first" — now only for
// FolderView's Finder-drop-into-folder, where the drop itself is the whole
// interaction and there is nowhere else to show the destination. The
// "Move to..." button no longer uses this: MoveToModal shows the resolved
// destination path and a cross-drive warning before its own Move button,
// so it is already the confirmation step. skip_move_confirmation therefore
// governs the drop path alone.
export function MoveConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Move',
  onConfirm,
  onCancel
}: MoveConfirmDialogProps): React.JSX.Element {
  const [dontAskAgain, setDontAskAgain] = useState(false)

  return (
    <Dialog open={open} onOpenChange={v => !v && onCancel()}>
      <DialogContent style={{
        background: '#13131b',
        border: '0.5px solid #1e1e2a',
        borderRadius: '12px',
        maxWidth: '380px',
        width: '100%',
        color: '#e8e8f0',
        fontFamily: 'inherit',
        padding: '20px'
      }}>

        {/* Icon */}
        <div style={{
          fontSize: '28px',
          marginBottom: '12px',
          textAlign: 'center'
        }}>
          ↗
        </div>

        {/* Title */}
        <div style={{
          fontSize: '14px',
          fontWeight: 500,
          textAlign: 'center',
          marginBottom: '8px'
        }}>
          {title}
        </div>

        {/* Description */}
        <div style={{
          fontSize: '12px',
          color: '#555',
          textAlign: 'center',
          marginBottom: '20px',
          lineHeight: 1.5
        }}>
          {description}
        </div>

        {/* Don't ask again */}
        <div
          onClick={() => setDontAskAgain((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '20px',
            cursor: 'pointer',
            userSelect: 'none'
          }}
        >
          <div style={{
            width: '16px',
            height: '16px',
            borderRadius: '3px',
            border: dontAskAgain
              ? '0.5px solid #7f77dd'
              : '0.5px solid #333',
            background: dontAskAgain ? '#7f77dd' : 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            transition: 'all 0.1s'
          }}>
            {dontAskAgain && (
              <span style={{ color: '#fff', fontSize: '10px' }}>✓</span>
            )}
          </div>
          <span style={{ fontSize: '12px', color: '#555' }}>
            Don&apos;t ask me again
          </span>
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', gap: '8px'}}>
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
            onClick={() => onConfirm(dontAskAgain)}
            className="flex-1 text-xs"
            style={{
              borderColor: '#7f77dd',
              color: '#a09be8'
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
