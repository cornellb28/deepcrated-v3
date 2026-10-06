// ── Clickable tag badge ───────────────────────────────────────────────────
// Every tag a DJ sees on a track is a way into the Tags page. Clicking one
// opens it as a filter; from there more tags stack on top to narrow further.
//
// The navigation goes through the store's pendingTagNav signal rather than a
// prop, because TrackRow and TrackCard are rendered by six different views
// and none of them has any business knowing about the Tags page. Same shape
// as pendingFolderNav, which exists for exactly this reason.

import React from 'react'
import { useLibraryStore } from '../store/useLibraryStore'

type TagBadgeSize = 'xs' | 'sm'

export function TagBadge({
  tag,
  size = 'sm',
  title
}: {
  tag: Tag
  size?: TagBadgeSize
  title?: string
}): React.JSX.Element {
  const setPendingTagNav = useLibraryStore((s) => s.setPendingTagNav)

  const xs = size === 'xs'

  return (
    <button
      type="button"
      title={title ?? `Show every track tagged "${tag.value}"`}
      onClick={(e) => {
        // The row plays the track and opens the Inspector on click; the card
        // does the same. Neither should fire because someone followed a tag.
        e.stopPropagation()
        e.preventDefault()
        setPendingTagNav(tag)
      }}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        fontSize: xs ? '9px' : '10px',
        fontWeight: 500,
        lineHeight: xs ? '15px' : '18px',
        height: xs ? '15px' : '20px',
        padding: xs ? '0 6px' : '0 6px',
        borderRadius: '4px',
        background: `${tag.color}22`,
        color: tag.color,
        border: `0.5px solid ${tag.color}44`,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: xs ? '90px' : '140px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        flexShrink: 0,
        transition: 'background 0.12s ease, border-color 0.12s ease'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = `${tag.color}38`
        e.currentTarget.style.borderColor = `${tag.color}88`
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = `${tag.color}22`
        e.currentTarget.style.borderColor = `${tag.color}44`
      }}
    >
      {tag.value}
    </button>
  )
}
