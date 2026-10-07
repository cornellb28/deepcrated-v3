import React, { useMemo } from 'react'
import { Music, Tag as TagIcon, User, type LucideIcon } from 'lucide-react'
import { useLibraryStore } from '../store/useLibraryStore'
import { useBrowseStore } from '../store/useBrowseStore'
import { BROWSE_DIMENSIONS, distinctValueCount } from '../lib/browse/registry'
import type { BrowseIcon } from '../lib/browse/types'

// ── Browse all ───────────────────────────────────────────────────────────
// One card per registered dimension. Adding a dimension to lib/browse/
// registry.ts adds its card here with no change to this file (an icon, if it
// needs a new one, is one line in ICONS).

const ICONS: Record<BrowseIcon, LucideIcon> = {
  music: Music,
  tag: TagIcon,
  user: User
}

export function BrowseHubView(): React.JSX.Element {
  const tracks = useLibraryStore((s) => s.tracks)
  const trackTags = useLibraryStore((s) => s.trackTags)
  const dispatch = useBrowseStore((s) => s.dispatch)

  // Recomputed from the store, so a tag edit or an import changes the counts
  // on these cards without a refetch.
  const counts = useMemo(
    () =>
      BROWSE_DIMENSIONS.map((d) => ({
        dimension: d,
        distinct: distinctValueCount(d.values({ tracks, trackTags }))
      })),
    [tracks, trackTags]
  )

  if (tracks.length === 0) {
    return (
      <div style={centered}>
        <span style={{ fontSize: '14px', color: '#8a8a9a' }}>Your library is empty</span>
        <span style={{ fontSize: '12px', color: '#555' }}>
          Import some music, then browse it by genre, tag or artist.
        </span>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 500, color: '#e8e8f0', margin: '0 0 6px' }}>
        Browse all
      </h1>
      <p style={{ fontSize: '12px', color: '#555', margin: '0 0 20px' }}>
        Pick a way to explore your library.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: '12px'
        }}
      >
        {counts.map(({ dimension, distinct }) => {
          const Icon = ICONS[dimension.icon]
          return (
            <button
              key={dimension.id}
              type="button"
              onClick={() =>
                dispatch({
                  type: 'open',
                  location: { kind: 'dimension', dimensionId: dimension.id }
                })
              }
              aria-label={`Browse by ${dimension.label.toLowerCase()}, ${distinct} ${dimension.noun}`}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                alignItems: 'flex-start',
                textAlign: 'left',
                padding: '16px',
                background: '#13131b',
                border: '0.5px solid #1e1e2a',
                borderRadius: '10px',
                color: '#e8e8f0',
                fontFamily: 'inherit',
                cursor: 'pointer',
                transition: 'border-color 0.15s ease, background 0.15s ease'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = '#7f77dd66'
                e.currentTarget.style.background = '#171722'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = '#1e1e2a'
                e.currentTarget.style.background = '#13131b'
              }}
            >
              <Icon size={20} color="#a09be8" aria-hidden />
              <span style={{ fontSize: '15px', fontWeight: 500 }}>Browse by {dimension.label}</span>
              <span style={{ fontSize: '12px', color: '#666', lineHeight: 1.4 }}>
                {dimension.description}
              </span>
              <span style={{ fontSize: '11px', color: '#7f77dd', marginTop: 'auto' }}>
                {distinct.toLocaleString()}{' '}
                {distinct === 1 ? singular(dimension.noun) : dimension.noun}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// "genres" -> "genre". The nouns are all regular plurals; a dimension that
// needs an irregular one can add a field instead of making this cleverer.
function singular(noun: string): string {
  return noun.endsWith('s') ? noun.slice(0, -1) : noun
}

const centered: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px'
}
