import React, { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { MoveToModal } from './MoveToModal'

interface MoveFileButtonProps {
  track: Track
  size?: 'sm' | 'default'
  label?: string
}

// Opens the shared destination picker. Everything that used to live here —
// the anchored folder dropdown, the confirm dialog, the move job dispatch —
// is now inside MoveToModal, which shows the resolved destination path and
// a cross-drive warning before committing. That modal is the confirmation,
// so there is no second "are you sure" step to skip.
export function MoveFileButton({
  track,
  size = 'sm',
  label = 'Move to...'
}: MoveFileButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        variant="outline"
        size={size}
        onClick={() => setOpen(true)}
        className="w-full justify-start gap-2 text-xs"
      >
        <span>↗</span>
        {label}
      </Button>

      <MoveToModal trackIds={[track.id]} open={open} onClose={() => setOpen(false)} />
    </>
  )
}
