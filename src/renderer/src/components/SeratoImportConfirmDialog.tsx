import React, { useState } from 'react'
import { Disc3 } from 'lucide-react'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'

interface SeratoImportConfirmDialogProps {
  open: boolean
  seratoDir: string
  onConfirm: (importSeratoData: boolean) => void
  onCancel: () => void
}

// Shown when a folder being imported has a `_Serato_` folder on its volume
// (see detectSeratoLibrary in main/serato/seratoImport.ts) — offers to pull
// in Serato's crates, history, and any tag data CrateCloud's own file-tag
// read didn't already have. Checked by default: a DJ who has a Serato
// library on the volume they're importing almost always wants this.
export function SeratoImportConfirmDialog({
  open,
  seratoDir,
  onConfirm,
  onCancel
}: SeratoImportConfirmDialogProps): React.JSX.Element {
  const [checked, setChecked] = useState(true)

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent
        style={{
          background: '#13131b',
          border: '0.5px solid #1e1e2a',
          borderRadius: '12px',
          maxWidth: '420px',
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
            color: '#7f77dd',
            marginBottom: '12px'
          }}
        >
          <Disc3 size={26} />
        </div>

        <div
          style={{ fontSize: '14px', fontWeight: 500, textAlign: 'center', marginBottom: '8px' }}
        >
          Serato library found
        </div>

        <div
          style={{
            fontSize: '12px',
            color: '#888',
            textAlign: 'center',
            marginBottom: '16px',
            lineHeight: 1.5
          }}
        >
          {seratoDir}
        </div>

        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
            marginBottom: '20px',
            cursor: 'pointer'
          }}
        >
          <Checkbox
            checked={checked}
            onCheckedChange={(v) => setChecked(v === true)}
            style={{ marginTop: '2px' }}
          />
          <span style={{ fontSize: '12px', color: '#bbb', lineHeight: 1.5 }}>
            Import Serato data from this library — crates, play history, and any tag fields
            CrateCloud didn&apos;t already read from the files themselves.
          </span>
        </label>

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
            onClick={() => onConfirm(checked)}
            className="flex-1 text-xs"
            style={{ borderColor: '#7f77dd', color: '#a09be8' }}
          >
            Continue
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
