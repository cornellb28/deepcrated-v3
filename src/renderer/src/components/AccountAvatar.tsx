import React, { useState } from 'react'
import { avatarInitial } from '@renderer/lib/accountChip'

// The Google profile photo when there is one (the CSP allows
// *.googleusercontent.com and nothing else remote), otherwise the first
// letter of the name or email on the accent tint.

const ACCENT = '#7f77dd'

export function AccountAvatar({ user, size }: { user: AuthUser | null; size: number }): React.JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const photo = user?.avatarUrl && user.avatarUrl !== failedUrl ? user.avatarUrl : null
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: '50%',
        background: `${ACCENT}33`,
        color: '#c5c0ff',
        fontSize: `${Math.round(size * 0.42)}px`,
        fontWeight: 600,
        flexShrink: 0,
        overflow: 'hidden'
      }}
    >
      {photo ? (
        <img
          src={photo}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(photo)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        avatarInitial(user)
      )}
    </span>
  )
}
