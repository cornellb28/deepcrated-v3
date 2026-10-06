import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { toast } from 'sonner'
import { MoreVertical, Library, Trash2, FolderPlus, FolderMinus, Tag, Image as ImageIcon } from 'lucide-react'
import { useLibraryStore } from '../store/useLibraryStore'
import { usePlayerStore } from '../store/usePlayerStore'
import { DeleteFileConfirmDialog } from './DeleteFileConfirmDialog'
import { CratePickerModal } from './CratePickerModal'
import { BulkEditModal } from './BulkEditModal'
import { reanalyzeTrack } from '../lib/reanalyze'

interface TrackRowMenuProps {
  track: Track
  crateId?: number
}

export function TrackRowMenu({ track, crateId }: TrackRowMenuProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [cratePickerOpen, setCratePickerOpen] = useState(false)
  const [editLabelsOpen, setEditLabelsOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const {
    removeTrack,
    removeTracksFromCrateLocally,
    setActiveTrack,
    updateTrack,
    boards,
  } = useLibraryStore()

  const { playTrack, currentTrack } = usePlayerStore()

  // Close on outside click
  useEffect(() => {
    if (!menuOpen) return
    function handle(e: MouseEvent): void {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        menuRef.current?.contains(e.target as Node)
      ) return
      setMenuOpen(false)
      setMenuPos(null)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [menuOpen])

  // Close on scroll so menu doesn't float away from trigger
  useEffect(() => {
    if (!menuOpen) return
    function handle(): void { setMenuOpen(false); setMenuPos(null) }
    window.addEventListener('scroll', handle, true)
    return () => window.removeEventListener('scroll', handle, true)
  }, [menuOpen])

  function openMenu(): void {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setMenuPos({
      top: rect.bottom + 4,
      left: rect.right - 210,
    })
    setMenuOpen(true)
  }

  function closeMenu(): void {
    setMenuOpen(false)
    setMenuPos(null)
  }

  const act = (fn: () => void) => () => { fn(); closeMenu() }

  const trackTitle = track.title ?? track.filename ?? 'this track'
  const isMissing = !!track.missing

  const handlePlay = act(() => playTrack(track))
  const handleOpenInspector = act(() => setActiveTrack(track.id))
  // Awaited and reported. It used to be fire-and-forget with an optional
  // call (`showInFolder?.()`), so a rejected invoke — which is exactly what
  // the channel mismatch produced — vanished into an unhandled rejection and
  // the menu item looked inert.
  async function handleShowInFinder(): Promise<void> {
    closeMenu()
    if (!track.filepath) {
      toast.error('No file path for this track')
      return
    }
    const result = await window.api.fs.showInFolder(track.filepath)
    if (!result?.ok) {
      toast.error('Could not show in Finder', { description: result?.error ?? 'Unknown error' })
    }
  }
  const handleCopyFilepath = act(() => { if (track.filepath) navigator.clipboard.writeText(track.filepath) })

  // The bar on this track's card, the store write and the DB write all live
  // in reanalyzeTrack — the bulk bar runs the identical routine.
  async function handleReanalyze(): Promise<void> {
    closeMenu()
    const outcome = await reanalyzeTrack(track.id)
    if (outcome === 'ok') toast.success('Re-analyzed successfully')
    else if (outcome === 'failed') toast.error('Re-analyze failed')
    else toast.error('Nothing to analyze', { description: 'The file is missing.' })
  }

  async function handleArtwork(): Promise<void> {
    const result = await window.api.artwork.pick(track.id)
    if (!result.ok) {
      if (result.error) toast.error('Could not set artwork', { description: result.error })
      return
    }
    updateTrack(track.id, { artwork_hash: result.hash ?? null })
    toast.success('Artwork set')
  }

  async function handleMoveToBoard(boardId: number): Promise<void> {
    closeMenu()
    updateTrack(track.id, { board_id: boardId })
    await window.api.db.updateBoardId(track.id, boardId)
  }

  async function handleMoveFile(): Promise<void> {
    closeMenu()
    if (!track.filepath) return
    const folder = await window.api.openFolder()
    if (!folder) return
    try {
      const result = await window.api.fs.moveFile(track.filepath, folder)
      if (result.ok) toast.success('File moved')
      else toast.error('Move failed', { description: result.error })
    } catch (err) {
      toast.error('Move failed', { description: (err as Error).message })
    }
  }

  async function handleRemoveFromCrate(): Promise<void> {
    if (crateId === undefined) return
    const result = await window.api.crates.removeTracks(crateId, [track.id])
    if (result.ok) {
      removeTracksFromCrateLocally(crateId, [track.id])
      toast.success(`Removed "${trackTitle}" from crate`)
    } else {
      toast.error('Could not remove from crate', { description: result.error })
    }
  }

  function stopIfCurrent(): void {
    if (currentTrack?.id === track.id) {
      usePlayerStore.setState({ currentTrack: null, isPlaying: false })
    }
  }

  async function runRemoval(deleteFile: boolean, successMessage: string): Promise<void> {
    setBusy(true)
    try {
      const result = await window.api.db.deleteTrack(track.id, deleteFile)
      if (result.ok) {
        stopIfCurrent()
        removeTrack(track.id)
        toast.success(successMessage)
      } else {
        toast.error(deleteFile ? 'Could not delete file' : 'Could not remove track', {
          description: result.error ?? 'Unknown error'
        })
      }
    } catch (err) {
      toast.error(deleteFile ? 'Could not delete file' : 'Could not remove track', {
        description: (err as Error).message
      })
    }
    setBusy(false)
  }

  const menuContent = menuPos && (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        top: menuPos.top,
        left: Math.max(8, menuPos.left), // prevent off-screen left
        minWidth: '210px',
        background: '#1a1a26',
        border: '0.5px solid #252535',
        borderRadius: '8px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        zIndex: 9999,
        overflow: 'hidden',
      }}
      onClick={e => e.stopPropagation()}
    >
      {track.filepath && !isMissing && (
        <MenuItem onClick={handlePlay} icon="▶">Play</MenuItem>
      )}
      <MenuItem onClick={handleOpenInspector} icon="✎">
        Open in Inspector
      </MenuItem>
      {/* The same modal the BulkBar opens, scoped to this one track — so
          "set the genre on this" is reachable without first selecting it. */}
      <MenuItem
        onClick={() => { closeMenu(); setEditLabelsOpen(true) }}
        icon={<Tag size={14} />}
      >
        Edit labels
      </MenuItem>
      {/* The per-track half of the BulkBar's Artwork action, so a DJ can fix
          one cover without first selecting it. */}
      <MenuItem
        onClick={() => { closeMenu(); void handleArtwork() }}
        icon={<ImageIcon size={14} />}
      >
        Change artwork
      </MenuItem>
      {track.filepath && !isMissing && (
        <MenuItem onClick={handleReanalyze} icon="⟳">Re-analyze</MenuItem>
      )}

      <Divider />

      {boards.length > 0 && (
        <>
          <Label>Move to stage</Label>
          {boards.map(board => (
            <MenuItem key={board.id} onClick={() => handleMoveToBoard(board.id)} indent>
              <span style={{
                width: '8px', height: '8px', borderRadius: '50%',
                background: board.color, flexShrink: 0, display: 'inline-block',
              }} />
              {board.name}
            </MenuItem>
          ))}
        </>
      )}

      <Divider />

      <MenuItem onClick={() => { closeMenu(); setCratePickerOpen(true) }} icon={<FolderPlus size={14} />}>
        Add to crate
      </MenuItem>
      {crateId !== undefined && (
        <MenuItem onClick={() => { closeMenu(); void handleRemoveFromCrate() }} icon={<FolderMinus size={14} />}>
          Remove from crate
        </MenuItem>
      )}

      <Divider />

      {track.filepath && !isMissing && (
        <>
          <MenuItem onClick={handleMoveFile} icon="↗">Move file to folder</MenuItem>
          <MenuItem onClick={() => void handleShowInFinder()} icon="⊟">Show in Finder</MenuItem>
          <MenuItem onClick={handleCopyFilepath} icon="⎘">Copy filepath</MenuItem>
          <Divider />
        </>
      )}

      <MenuItem
        onClick={() => { closeMenu(); void runRemoval(false, `Removed "${trackTitle}" from CrateCloud`) }}
        icon={<Library size={14} />}
      >
        Remove from CrateCloud
      </MenuItem>
      <MenuItem
        onClick={() => { closeMenu(); setConfirmOpen(true) }}
        icon={<Trash2 size={14} />}
        danger
      >
        Delete from Hard Drive
      </MenuItem>
    </div>
  )

  return (
    <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>

      <button
        ref={triggerRef}
        data-testid={`track-menu-${track.id}`}
        onClick={() => menuOpen ? closeMenu() : openMenu()}
        disabled={busy}
        title="More options"
        style={{
          border: 'none', background: 'none', color: '#555',
          cursor: busy ? 'default' : 'pointer', padding: '4px',
          borderRadius: '4px', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = '#252535'; e.currentTarget.style.color = '#e8e8f0' }}
        onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#555' }}
      >
        <MoreVertical size={16} />
      </button>

      {/* Portal — renders on document.body, escapes all overflow/z-index */}
      {menuOpen && menuContent && ReactDOM.createPortal(menuContent, document.body)}

      <CratePickerModal
        trackIds={[track.id]}
        open={cratePickerOpen}
        onClose={() => setCratePickerOpen(false)}
      />

      <BulkEditModal
        trackIds={[track.id]}
        open={editLabelsOpen}
        onClose={() => setEditLabelsOpen(false)}
      />

      <DeleteFileConfirmDialog
        open={confirmOpen}
        trackTitle={trackTitle}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); void runRemoval(true, `Deleted "${trackTitle}"`) }}
      />
    </div>
  )
}

function MenuItem({ onClick, icon, indent = false, danger = false, children }: {
  onClick: () => void
  icon?: React.ReactNode
  indent?: boolean
  danger?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
        padding: `9px 12px 9px ${indent ? '24px' : '12px'}`,
        border: 'none', background: 'transparent',
        color: danger ? '#e08a80' : '#c0c0d8',
        fontSize: '12px', fontFamily: 'inherit',
        textAlign: 'left', cursor: 'pointer', transition: 'background 0.1s',
      }}
      onMouseEnter={(e) => e.currentTarget.style.background = '#252535'}
      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
    >
      {icon && (
        <span style={{ flexShrink: 0, fontSize: '13px', color: danger ? '#e08a80' : '#555' }}>
          {icon}
        </span>
      )}
      {children}
    </button>
  )
}

function Divider(): React.JSX.Element {
  return <div style={{ height: '0.5px', background: '#252535', margin: '2px 0' }} />
}

function Label({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{
      fontSize: '10px', fontWeight: 500, letterSpacing: '0.8px',
      textTransform: 'uppercase', color: '#444', padding: '6px 12px 2px',
    }}>
      {children}
    </div>
  )
}
