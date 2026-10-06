import React, { useState, useRef, useEffect, CSSProperties } from 'react'

interface ImportDropzoneProps {
  onImportFolder: (path: string) => void
  onImportFiles: (paths: string[]) => void
  disabled?: boolean
}

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.aiff', '.aif', '.m4a', '.ogg'])

function isAudioFile(name: string): boolean {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  return AUDIO_EXTENSIONS.has(ext)
}

export function ImportDropzone({ onImportFolder, onImportFiles, disabled = false }: ImportDropzoneProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const [open, setOpen] = useState(false)
  const dropRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // ── Drag handlers ─────────────────────────────────────

  function onDragOver(e: React.DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    if (!disabled) setDragging(true)
  }

  function onDragLeave(e: React.DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    setDragging(false)
  }

  function onDrop(e: React.DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    setDragging(false)
    if (disabled) return

    const items = Array.from(e.dataTransfer.items)
    const folders: string[] = []
    const files: string[] = []

    for (const item of items) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (!file) continue

      // Electron exposes the real path via path
      const path = (file as File & { path: string }).path
      if (!path) continue

      const entry = item.webkitGetAsEntry?.()
      if (entry?.isDirectory) {
        folders.push(path)
      } else if (isAudioFile(file.name)) {
        files.push(path)
      }
    }

    // Import folders first, then loose files
    for (const folder of folders) {
      onImportFolder(folder)
    }
    if (files.length > 0) {
      onImportFiles(files)
    }
  }

  // ── Click handlers ─────────────────────────────────────

  async function handleImportFolder(): Promise<void> {
    setOpen(false)
    const folder = await window.api.openFolder()
    if (folder) onImportFolder(folder)
  }

  async function handleImportFiles(): Promise<void> {
    setOpen(false)
    const files = await window.api.openFiles()
    if (files.length > 0) onImportFiles(files)
  }

  // ── Close menu on outside click ────────────────────────

  useEffect(() => {
    function handle(e: MouseEvent): void {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        !dropRef.current?.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  const borderColor = dragging ? '#7f77dd' : '#252535'
  const bgColor = dragging ? '#1a1830' : '#13131b'

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      {/* Dropzone trigger */}
      <div
        ref={dropRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => !disabled && setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '5px 12px',
          background: bgColor,
          border: `0.5px solid ${borderColor}`,
          borderRadius: '6px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          transition: 'all 0.15s',
          userSelect: 'none',
          minWidth: '130px',
        }}
      >
        {/* Icon */}
        <span style={{
          fontSize: '14px',
          color: dragging ? '#a09be8' : '#555',
          transition: 'color 0.15s',
        }}>
          {dragging ? '↓' : '⊕'}
        </span>

        {/* Label */}
        <div style={{ flex: 1 }}>
          <div style={{
            fontSize: '11px',
            fontWeight: 500,
            color: dragging ? '#a09be8' : disabled ? '#444' : '#c0c0d8',
            transition: 'color 0.15s',
          }}>
            {disabled
              ? 'Importing...'
              : dragging
                ? 'Drop to import'
                : 'Import music'}
          </div>
          {!disabled && !dragging && (
            <div style={{ fontSize: '9px', color: '#444', marginTop: '1px' }}>
              Drop folder or files · click to browse
            </div>
          )}
        </div>

        {/* Chevron */}
        {!disabled && !dragging && (
          <span style={{
            fontSize: '10px',
            color: '#444',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.15s',
          }}>
            ▾
          </span>
        )}
      </div>

      {/* Dropdown menu */}
      {open && (
        <div
          ref={menuRef}
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            minWidth: '160px',
            background: '#1a1a26',
            border: '0.5px solid #252535',
            borderRadius: '8px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            zIndex: 1000,
            overflow: 'hidden'
          }}
        >
          <button
            onClick={handleImportFolder}
            style={menuItemStyle}
            onMouseEnter={(e) => e.currentTarget.style.background = '#252535'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            <span style={{ fontSize: '14px' }}>⊟</span>
            <div>
              <div style={{ fontSize: '12px', color: '#c0c0d8', fontWeight: 500 }}>
                Import folder
              </div>
              <div style={{ fontSize: '10px', color: '#444', marginTop: '1px' }}>
                Scans all audio files recursively
              </div>
            </div>
          </button>

          <div style={{ height: '0.5px', background: '#252535', margin: '0 10px' }} />

          <button
            onClick={handleImportFiles}
            style={menuItemStyle}
            onMouseEnter={e => e.currentTarget.style.background = '#252535'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <span style={{ fontSize: '14px' }}>♪</span>
            <div>
              <div style={{ fontSize: '12px', color: '#c0c0d8', fontWeight: 500 }}>
                Add files
              </div>
              <div style={{ fontSize: '10px', color: '#444', marginTop: '1px' }}>
                Pick individual tracks
              </div>
            </div>
          </button>
        </div>
      )}
    </div>
  )
}

const menuItemStyle: CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '10px 14px',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
  transition: 'background 0.1s'
}
