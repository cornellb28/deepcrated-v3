// ── Delete a folder ───────────────────────────────────────────────────────
// Three outcomes, spelled out rather than implied. The whole reason this is
// a dialog and not a menu item is that "remove this folder" is ambiguous in
// a app whose folders mirror real directories: it can mean "stop showing me
// this" or "delete my music", and those are not close together.
//
// Each option says what happens to all three things a DJ cares about — the
// folder, the tracks in the library, and the files on disk — because the
// difference between the options IS those three lines.

import React, { useState } from 'react'
import { FolderMinus, FolderInput, Trash2 } from 'lucide-react'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'

export type DeleteFolderChoice = 'library' | 'move' | 'trash'

interface DeleteFolderDialogProps {
  open: boolean
  folderName: string
  trackCount: number
  subfolderCount: number
  busy?: boolean
  // Shown in the dialog, not only as a toast. shell.trashItem fails for
  // environmental reasons — a volume with no Trash, a permission the app was
  // never granted — and a dialog that stays open saying nothing reads as a
  // button that does nothing.
  error?: string | null
  onChoose: (choice: DeleteFolderChoice) => void
  onCancel: () => void
}

export function DeleteFolderDialog({
  open,
  folderName,
  trackCount,
  subfolderCount,
  busy = false,
  error = null,
  onChoose,
  onCancel
}: DeleteFolderDialogProps): React.JSX.Element {
  // Nothing is armed by default. The destructive option in particular has to
  // be chosen deliberately — no Enter-key path lands on it.
  const [choice, setChoice] = useState<DeleteFolderChoice | null>(null)

  const [lastOpen, setLastOpen] = useState(open)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) setChoice(null)
  }

  const tracks = `${trackCount} track${trackCount !== 1 ? 's' : ''}`
  const subfolders = `${subfolderCount} subfolder${subfolderCount !== 1 ? 's' : ''}`

  // With nothing in it there is nothing to relocate, so the move option is
  // not offered at all — an option that can only no-op is worse than one
  // fewer choice on a dialog about deleting things.
  const hasTracks = trackCount > 0

  // "Holds 0 tracks" is a sentence no one should have to read.
  const summary = hasTracks
    ? `Holds ${tracks}${subfolderCount > 0 ? ` and ${subfolders}` : ''}. Choose what happens to them.`
    : subfolderCount > 0
      ? `No tracks in here, but it holds ${subfolders}.`
      : 'This folder is empty.'

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent
        showCloseButton={false}
        style={{
          background: '#17171f',
          border: '0.5px solid #2e2e3e',
          borderRadius: '12px',
          maxWidth: '440px',
          width: '100%',
          color: '#e8e8f0',
          fontFamily: 'inherit',
          padding: '20px'
        }}
      >
        <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: '4px' }}>
          Remove “{folderName}”
        </div>
        <div style={{ fontSize: '12px', color: '#555', marginBottom: '16px', lineHeight: 1.5 }}>
          {summary}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <Option
            selected={choice === 'library'}
            onSelect={() => setChoice('library')}
            icon={<FolderMinus size={16} />}
            accent="#378add"
            title="Remove from CrateCloud only"
            lines={
              hasTracks
                ? [
                    ['Folder', 'disappears from the Folders view'],
                    ['Tracks', 'stay in your library, with tags and crates — just unfiled'],
                    ['Files', 'untouched on your drive']
                  ]
                : [
                    ['Folder', 'disappears from the Folders view'],
                    ['Files', 'the directory stays on your drive']
                  ]
            }
          />

          {hasTracks && (
            <Option
              selected={choice === 'move'}
              onSelect={() => setChoice('move')}
              icon={<FolderInput size={16} />}
              accent="#1d9e75"
              title="Move the tracks somewhere else first"
              lines={[
                ['Folder', 'stays until the move finishes, then you can remove it'],
                ['Tracks', 'keep everything, and re-file under the new folder'],
                ['Files', 'relocated on your drive, not deleted']
              ]}
            />
          )}

          <Option
            selected={choice === 'trash'}
            onSelect={() => setChoice('trash')}
            icon={<Trash2 size={16} />}
            accent="#d8695d"
            title="Move to Trash"
            danger
            lines={
              hasTracks
                ? [
                    ['Folder', 'deleted from your drive'],
                    ['Tracks', `removed from CrateCloud — ${tracks}, with their tags`],
                    ['Files', 'go to the Trash, recoverable from Finder until you empty it']
                  ]
                : [
                    ['Folder', 'deleted from your drive'],
                    ['Files', 'goes to the Trash, recoverable from Finder until you empty it']
                  ]
            }
          />
        </div>

        {error && (
          <div
            role="alert"
            style={{
              marginTop: '14px',
              padding: '9px 11px',
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

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px',
            marginTop: '18px'
          }}
        >
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={choice === null || busy}
            onClick={() => choice && onChoose(choice)}
            style={
              choice === 'trash'
                ? { background: '#d8695d', color: '#fff' }
                : undefined
            }
          >
            {busy
              ? 'Working…'
              : choice === 'trash'
                ? 'Move to Trash'
                : choice === 'move'
                  ? 'Choose destination…'
                  : 'Remove'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Option({
  selected,
  onSelect,
  icon,
  accent,
  title,
  lines,
  danger = false
}: {
  selected: boolean
  onSelect: () => void
  icon: React.ReactNode
  accent: string
  title: string
  lines: [string, string][]
  danger?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        display: 'flex',
        gap: '11px',
        textAlign: 'left',
        width: '100%',
        background: selected ? `${accent}14` : '#13131b',
        border: `0.5px solid ${selected ? `${accent}88` : '#23232e'}`,
        borderRadius: '8px',
        padding: '11px 12px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'background 0.12s ease, border-color 0.12s ease'
      }}
    >
      <span style={{ color: accent, flexShrink: 0, marginTop: '1px' }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: '12.5px',
            fontWeight: 500,
            color: danger && selected ? accent : '#e8e8f0',
            marginBottom: '5px'
          }}
        >
          {title}
        </span>
        {lines.map(([label, text]) => (
          <span key={label} style={{ display: 'flex', gap: '6px', marginTop: '2px' }}>
            <span
              style={{
                fontSize: '9px',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                color: '#444',
                width: '42px',
                flexShrink: 0,
                lineHeight: '15px'
              }}
            >
              {label}
            </span>
            <span style={{ fontSize: '11px', color: '#8a8a9e', lineHeight: '15px' }}>{text}</span>
          </span>
        ))}
      </span>
    </button>
  )
}
