import React from 'react'
import { AlertTriangle } from 'lucide-react'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'

interface SeratoRunningConfirmDialogProps {
  open: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function SeratoRunningConfirmDialog({
  open,
  onConfirm,
  onCancel
}: SeratoRunningConfirmDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent
        style={{
          background: '#13131b',
          border: '0.5px solid #1e1e2a',
          borderRadius: '12px',
          maxWidth: '400px',
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
            color: '#e0b95d',
            marginBottom: '12px'
          }}
        >
          <AlertTriangle size={26} />
        </div>

        <div
          style={{ fontSize: '14px', fontWeight: 500, textAlign: 'center', marginBottom: '8px' }}
        >
          Serato is open
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
          Crates written now may not appear until you restart it. Export anyway?
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
            style={{ borderColor: '#7f77dd', color: '#a09be8' }}
          >
            Export anyway
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
