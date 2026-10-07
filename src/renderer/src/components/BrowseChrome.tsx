import React from 'react'
import type { BrowseDimension } from '../lib/browse/types'

// Page chrome shared by the Browse pages: header with a back button, and a
// centred message for empty states.

export function Shell({
  dimension,
  onBack,
  summary,
  children
}: {
  dimension: BrowseDimension
  onBack: () => void
  summary?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minHeight: 0
      }}
    >
      <div
        style={{
          padding: '14px 20px',
          borderBottom: '0.5px solid #1e1e2a',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          flexShrink: 0
        }}
      >
        <BackButton onClick={onBack}>← Browse all</BackButton>
        <h1 style={{ fontSize: '13px', fontWeight: 500, color: '#e8e8f0', margin: 0 }}>
          Browse by {dimension.label}
        </h1>
        {summary && (
          <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#555' }}>{summary}</span>
        )}
      </div>
      {children}
    </div>
  )
}

export function Message({
  title,
  detail,
  action
}: {
  title: string
  detail: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      role="status"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        padding: '24px',
        textAlign: 'center'
      }}
    >
      <span style={{ fontSize: '14px', color: '#8a8a9a' }}>{title}</span>
      <span style={{ fontSize: '12px', color: '#555', maxWidth: '420px' }}>{detail}</span>
      {action}
    </div>
  )
}

const backButtonStyle: React.CSSProperties = {
  background: 'none',
  border: '0.5px solid #252535',
  borderRadius: '6px',
  color: '#555',
  fontSize: '12px',
  cursor: 'pointer',
  padding: '4px 10px',
  fontFamily: 'inherit'
}

export function BackButton({
  onClick,
  children
}: {
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button type="button" onClick={onClick} style={backButtonStyle}>
      {children}
    </button>
  )
}
