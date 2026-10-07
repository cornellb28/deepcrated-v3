import React from 'react'
import type { View } from './Sidebar'

export interface BreadcrumbItem {
  label: string
  onSelect: () => void
}

interface BreadcrumbProps {
  activeView: View
  onNavigate: (view: View) => void
  // Replaces the single "current view" segment with a deeper trail (Browse
  // uses it for Browse all > Artist > Aaliyah). The last item is the current
  // page and is not clickable.
  trail?: BreadcrumbItem[]
}

const VIEW_LABELS: Record<View, string> = {
  dashboard: 'Home',
  library: 'All Tracks',
  browse: 'Browse all',
  tags: 'Tags',
  folders: 'Folders',
  crates: 'Crates',
  settings: 'Settings'
}

export function Breadcrumb({
  activeView,
  onNavigate,
  trail
}: BreadcrumbProps): React.JSX.Element | null {
  // No breadcrumb on dashboard — that IS home
  if (activeView === 'dashboard') return null

  const segments: { label: string; isHome: boolean; onSelect: () => void }[] = [
    { label: 'Home', isHome: true, onSelect: () => onNavigate('dashboard') },
    ...(trail && trail.length > 0
      ? trail.map((item) => ({ ...item, isHome: false }))
      : [
          {
            label: VIEW_LABELS[activeView],
            isHome: false,
            onSelect: () => onNavigate(activeView)
          }
        ])
  ]

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 16px',
        flexShrink: 0
      }}
    >
      {segments.map((segment, i) => {
        const isLast = i === segments.length - 1
        const isHome = segment.isHome

        return (
          <React.Fragment key={`${i}-${segment.label}`}>
            <button
              onClick={() => !isLast && segment.onSelect()}
              style={{
                background: 'none',
                border: 'none',
                padding: '0',
                fontSize: '12px',
                color: isLast ? '#e8e8f0' : '#555',
                cursor: isLast ? 'default' : 'pointer',
                fontFamily: 'inherit',
                fontWeight: isLast ? 500 : 400,
                textDecoration: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                transition: 'color 0.1s'
              }}
              onMouseEnter={(e) => {
                if (!isLast) e.currentTarget.style.color = '#a09be8'
              }}
              onMouseLeave={(e) => {
                if (!isLast) e.currentTarget.style.color = '#555'
              }}
            >
              {isHome && <span style={{ fontSize: '11px' }}>⌂</span>}
              {segment.label}
            </button>

            {/* Separator */}
            {!isLast && (
              <span
                style={{
                  color: '#333',
                  fontSize: '11px',
                  userSelect: 'none'
                }}
              >
                ›
              </span>
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}
