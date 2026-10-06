import React from 'react'
import type { View } from './Sidebar'

interface BreadcrumbProps {
  activeView: View
  onNavigate: (view: View) => void
}

const VIEW_LABELS: Record<View, string> = {
  dashboard: 'Home',
  library: 'All Tracks',
  tags: 'Tags',
  folders: 'Folders',
  crates: 'Crates',
  settings: 'Settings'
}

export function Breadcrumb({ activeView, onNavigate }: BreadcrumbProps): React.JSX.Element | null {
  // No breadcrumb on dashboard — that IS home
  if (activeView === 'dashboard') return null

  const segments = [
    { label: 'Home', view: 'dashboard' as View },
    { label: VIEW_LABELS[activeView], view: activeView }
  ]

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '6px 16px',
      background: '#0e0e12',
      borderBottom: '0.5px solid #1e1e2a',
      flexShrink: 0,
    }}>
      {segments.map((segment, i) => {
        const isLast = i === segments.length - 1
        const isHome = segment.view === 'dashboard'

        return (
          <React.Fragment key={segment.view}>
            <button
              onClick={() => !isLast && onNavigate(segment.view)}
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
                transition: 'color 0.1s',
              }}
              onMouseEnter={(e) => {
                if (!isLast) e.currentTarget.style.color = '#a09be8'
              }}
              onMouseLeave={(e) => {
                if (!isLast) e.currentTarget.style.color = '#555'
              }}
            >
              {isHome && (
                <span style={{ fontSize: '11px' }}>⌂</span>
              )}
              {segment.label}
            </button>

            {/* Separator */}
            {!isLast && (
              <span style={{
                color: '#333',
                fontSize: '11px',
                userSelect: 'none',
              }}>
                ›
              </span>
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}
