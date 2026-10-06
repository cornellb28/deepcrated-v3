import React from 'react'
import { Button } from '@renderer/components/ui/button'
import { AccountButton } from '@renderer/components/AccountButton'
import { useLibraryStore } from '../store/useLibraryStore'
import { useFileDrop } from '../hooks/useFileDrop'

interface EmptyStateProps {
  onImport: () => void
  onImportPaths: (paths: string[]) => void
  // Null while a stored session is still being restored.
  auth: AuthState | null
  onOpenAccount: () => void
}

export function EmptyState({
  onImport,
  onImportPaths,
  auth,
  onOpenAccount
}: EmptyStateProps): React.JSX.Element {
  const { isAnalyzing } = useLibraryStore()
  const { isDragging, dropHandlers } = useFileDrop({ onDrop: onImportPaths })

  return (
    <div
      {...dropHandlers}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0e0e12',
        padding: '48px',
        textAlign: 'center',
        border: isDragging ? '2px dashed #7f77dd' : '2px dashed transparent',
        borderRadius: '12px',
        margin: isDragging ? '8px' : '10px',
        transition: 'border-color 0.15s, margin 0.15s'
      }}
    >
      {isDragging ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '12px'
          }}
        >
          <span style={{ fontSize: '40px' }}>⬇</span>
          <div style={{ fontSize: '18px', fontWeight: 500, color: '#e8e8f0' }}>
            Drop a folder or files to get started
          </div>
        </div>
      ) : (
        <>
          {/* Logo mark */}
          <div
            style={{
              width: '80px',
              height: '80px',
              borderRadius: '20px',
              background: 'linear-gradient(135deg, #7f77dd 0%, #534ab7 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '36px',
              marginBottom: '24px',
              boxShadow: '0 8px 32px #7f77dd44'
            }}
          >
            ♫
          </div>

          {/* Wordmark */}
          <h1
            style={{
              fontSize: '28px',
              fontWeight: 500,
              color: '#e8e8f0',
              marginBottom: '8px',
              letterSpacing: '-0.5px'
            }}
          >
            CrateCloud
          </h1>

          {/* Tagline */}
          <p
            style={{
              fontSize: '14px',
              color: '#555',
              marginBottom: '40px',
              maxWidth: '340px',
              lineHeight: 1.6
            }}
          >
            Your DJ library — organized, analyzed, and ready for the gig. Import your music folder
            to get started.
          </p>

          {/* Feature hints */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '12px',
              marginBottom: '40px',
              maxWidth: '480px',
              width: '100%'
            }}
          >
            {[
              { icon: '⚡', label: 'Instant import', desc: 'Tracks appear immediately' },
              { icon: '♩', label: 'BPM + Key', desc: 'Auto-analyzed in background' },
              { icon: '⊞', label: 'Smart organization', desc: 'Stages, crates, and tags' }
            ].map((f) => (
              <div
                key={f.label}
                style={{
                  background: '#13131b',
                  border: '0.5px solid #1e1e2a',
                  borderRadius: '10px',
                  padding: '14px 12px'
                }}
              >
                <div style={{ fontSize: '20px', marginBottom: '6px' }}>{f.icon}</div>
                <div
                  style={{
                    fontSize: '12px',
                    fontWeight: 500,
                    color: '#e8e8f0',
                    marginBottom: '3px'
                  }}
                >
                  {f.label}
                </div>
                <div style={{ fontSize: '11px', color: '#444' }}>{f.desc}</div>
              </div>
            ))}
          </div>

          {/* Import CTA */}
          <Button
            onClick={onImport}
            disabled={isAnalyzing}
            style={{
              background: '#7f77dd',
              border: 'none',
              color: '#fff',
              fontSize: '14px',
              padding: '10px 28px',
              height: 'auto',
              borderRadius: '8px',
              cursor: isAnalyzing ? 'wait' : 'pointer',
              boxShadow: '0 4px 16px #7f77dd44'
            }}
          >
            {isAnalyzing ? 'Importing...' : '+ Import your music folder'}
          </Button>

          <p
            style={{
              fontSize: '11px',
              color: '#333',
              marginTop: '12px'
            }}
          >
            You can also drag and drop a folder anywhere in the app
          </p>

          {/* Deliberately below the import CTA and quieter than it: an
              account is optional here, and nothing on this screen waits on
              one. */}
          <AccountButton auth={auth} onOpenAccount={onOpenAccount} tone="hint" />
        </>
      )}
    </div>
  )
}
