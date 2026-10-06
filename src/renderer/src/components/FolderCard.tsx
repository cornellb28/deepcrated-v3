import React, { useState } from 'react'
import { FolderPen } from 'lucide-react'
import { MosaicArtwork } from './MosaicArtwork'

interface FolderCardProps {
  name: string
  path: string
  trackCount: number
  audioCount?: number
  artworkHashes: (string | null)[]
  onClick: () => void
  // Renaming a subfolder without opening it first. Optional so the card
  // stays usable anywhere that has no rename to offer.
  onRename?: () => void
  // Brief one-shot flash — used for a folder that was just created,
  // imported, or moved into the grid currently being rendered. Plays once;
  // the caller is responsible for clearing it back to false after the
  // animation's duration (see folderHighlight in main.css).
  highlighted?: boolean
}

// TODO: dropping Finder files directly onto a folder card (as opposed to
// opening it and dropping into its content area, which FolderView already
// supports) is out of scope for this pass — see useFileDrop in FolderView.tsx
// for the pattern to reuse if this card grows its own drop target.
export function FolderCard({
  name,
  path,
  trackCount,
  audioCount,
  artworkHashes,
  onClick,
  onRename,
  highlighted
}: FolderCardProps): React.JSX.Element {
  // The rename button appears on hover rather than sitting there permanently
  // — a grid of folder cards is something a DJ scans, and a control on every
  // one of them is noise until it is wanted.
  const [hovered, setHovered] = useState(false)
  // A folder with nothing in its subtree yet — just created, or a rename
  // target waiting on the identity work to relink its tracks. Shown dimmed
  // rather than hidden (see FolderView's subfolders comment).
  const isEmpty = trackCount === 0

  // audioCount (disk) vs trackCount (imported into the DB) — show both only when they diverge
  const countLabel = isEmpty
    ? 'Empty'
    : audioCount !== undefined && audioCount !== trackCount
      ? `${audioCount} track${audioCount !== 1 ? 's' : ''} · ${trackCount} analyzed`
      : `${trackCount} track${trackCount !== 1 ? 's' : ''}`

  return (
    <div
      onClick={onClick}
      title={path}
      style={{
        position: 'relative',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '8px',
        margin: '-8px',
        borderRadius: '10px',
        opacity: isEmpty ? 0.5 : 1,
        transition: 'transform 0.15s, opacity 0.15s',
        animation: highlighted ? 'folderHighlight 1.8s ease-out' : undefined
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'scale(1.02)'
        setHovered(true)
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'scale(1)'
        setHovered(false)
      }}
    >
      {onRename && hovered && (
        <button
          type="button"
          onClick={(e) => {
            // Without this the click also reaches the card and navigates
            // into the folder the DJ was trying to rename.
            e.stopPropagation()
            onRename()
          }}
          title={`Rename "${name}"`}
          aria-label={`Rename ${name}`}
          style={{
            position: 'absolute',
            top: '12px',
            right: '12px',
            zIndex: 2,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '24px',
            height: '24px',
            borderRadius: '6px',
            background: '#13131bdd',
            border: '0.5px solid #2e2e3e',
            color: '#a09be8',
            cursor: 'pointer',
            fontFamily: 'inherit'
          }}
        >
          <FolderPen size={12} />
        </button>
      )}
      {/* Mosaic artwork */}
      <MosaicArtwork artworkHashes={artworkHashes} folderName={name} size={160} borderRadius={8} />

      {/* Folder info */}
      <div>
        <div
          style={{
            fontSize: '13px',
            fontWeight: 500,
            color: '#e0e0f0',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            marginBottom: '2px'
          }}
        >
          {name}
        </div>
        <div style={{ fontSize: '11px', color: '#555' }}>{countLabel}</div>
      </div>
    </div>
  )
}
