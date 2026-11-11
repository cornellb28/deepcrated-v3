import React from 'react'
import dclogo from '@renderer/assets/crateIcon.png'

// Shown in place of album art when a track has none. The mark is drawn
// edge-to-edge, so it is scaled down to leave breathing room in its slot.
// The parent is expected to be a flex container that centres it.
export function DefaultArtwork(): React.JSX.Element {
  return (
    <img
      src={dclogo}
      alt=""
      draggable={false}
      style={{ width: '55%', height: '55%', objectFit: 'contain', opacity: 0.85 }}
    />
  )
}
