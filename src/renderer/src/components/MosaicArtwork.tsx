import React from 'react'
import { useArtworkUrl } from '../hooks/useArtworkUrl'

interface MosaicArtworkProps {
  artworkHashes: (string | null)[]
  folderName: string
  size?: number
  borderRadius?: number
}

// Generates a consistent color from a string — same as genre colors
function folderColor(name: string): string {
  const colors = [
    '#7f77dd', '#1d9e75', '#d85a30',
    '#378add', '#ba7517', '#d4537e',
    '#534ab7', '#0f6e56', '#993c1d',
  ]
  let hash = 0
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) % colors.length
  }
  return colors[Math.abs(hash)]
}

function MosaicTile({ url }: { url: string | null }): React.JSX.Element {
  return url ? (
    <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
  ) : (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#1e1e2a',
    }}>
      <span style={{ fontSize: '20px', color: '#333' }}>♪</span>
    </div>
  )
}

export function MosaicArtwork({
  artworkHashes,
  folderName,
  size = 200,
  borderRadius = 8,
}: MosaicArtworkProps): React.JSX.Element {

  // Filter to real hashes only
  const realHashes = artworkHashes.filter(Boolean).slice(0, 4) as string[]

  // Resolved as a fixed-arity set of hook calls (Rules of Hooks) — up to 4
  // tiles regardless of how many hashes this folder actually has.
  const url0 = useArtworkUrl(realHashes[0] ?? null, 'thumb')
  const url1 = useArtworkUrl(realHashes[1] ?? null, 'thumb')
  const url2 = useArtworkUrl(realHashes[2] ?? null, 'thumb')
  const url3 = useArtworkUrl(realHashes[3] ?? null, 'thumb')
  const urls = [url0, url1, url2, url3]

  const baseColor = folderColor(folderName)

  // ── No artwork — Option C: generated color ────────────

  if (realHashes.length === 0) {
    return (
      <div style={{
        width: size,
        height: size,
        borderRadius,
        flexShrink: 0,
        position: 'relative',
        overflow: 'hidden',
        // Option C — gradient using folder's generated color
        background: `linear-gradient(135deg, ${baseColor}cc 0%, ${baseColor}44 100%)`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
      }}>
        {/* Large folder icon */}
        <span style={{ fontSize: size * 0.25, lineHeight: 1 }}>⊟</span>
        {/* Folder name */}
        <span style={{
          fontSize: Math.max(10, size * 0.08),
          fontWeight: 500,
          color: '#fff',
          textAlign: 'center',
          padding: '0 12px',
          lineHeight: 1.3,
          wordBreak: 'break-word',
          maxWidth: '90%',
        }}>
          {folderName}
        </span>
      </div>
    )
  }

  // ── 1 artwork — full size ─────────────────────────────

  if (realHashes.length === 1) {
    return (
      <div style={{
        width: size,
        height: size,
        borderRadius,
        flexShrink: 0,
        overflow: 'hidden',
        position: 'relative',
      }}>
        <MosaicTile url={urls[0]} />
        {/* Option A — folder name overlay on single image */}
        <div style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: '24px 12px 10px',
          background: 'linear-gradient(transparent, rgba(0,0,0,0.7))',
          color: '#fff',
          fontSize: Math.max(10, size * 0.08),
          fontWeight: 500,
        }}>
          {folderName}
        </div>
      </div>
    )
  }

  // ── 2 artworks — side by side ─────────────────────────

  if (realHashes.length === 2) {
    return (
      <div style={{
        width: size,
        height: size,
        borderRadius,
        flexShrink: 0,
        overflow: 'hidden',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '2px',
        background: '#1e1e2a',
      }}>
        {urls.slice(0, 2).map((url, i) => (
          <MosaicTile key={i} url={url} />
        ))}
      </div>
    )
  }

  // ── 3 artworks — left full + right split ──────────────

  if (realHashes.length === 3) {
    return (
      <div style={{
        width: size,
        height: size,
        borderRadius,
        flexShrink: 0,
        overflow: 'hidden',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gridTemplateRows: '1fr 1fr',
        gap: '2px',
        background: '#1e1e2a',
      }}>
        <div style={{ gridRow: '1 / 3' }}>
          <MosaicTile url={urls[0]} />
        </div>
        <MosaicTile url={urls[1]} />
        <MosaicTile url={urls[2]} />
      </div>
    )
  }

  // ── 4 artworks — 2x2 mosaic ───────────────────────────

  return (
    <div style={{
      width: size,
      height: size,
      borderRadius,
      flexShrink: 0,
      overflow: 'hidden',
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gridTemplateRows: '1fr 1fr',
      gap: '2px',
      background: '#1e1e2a',
    }}>
      {urls.slice(0, 4).map((url, i) => (
        <MosaicTile key={i} url={url} />
      ))}
    </div>
  )
}
