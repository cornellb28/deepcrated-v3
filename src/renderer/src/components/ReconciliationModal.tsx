import React, { useState, useEffect } from 'react'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { useArtworkUrl } from '../hooks/useArtworkUrl'

interface ReconciliationModalProps {
  open: boolean
  onClose: () => void
}

// Group changes by type for cleaner display
function groupChanges(changes: PendingChange[]): {
    moved: PendingChange[]
    added: PendingChange[]
    deleted: PendingChange[]
} {
  return {
    moved: changes.filter((c) => c.change_type === 'moved'),
    added: changes.filter((c) => c.change_type === 'added'),
    deleted: changes.filter((c) => c.change_type === 'deleted'),
  }
}

function shortPath(path: string | null): string {
  if (!path) return '—'
  const parts = path.split('/')
  return parts.slice(-2).join('/')
}

export function ReconciliationModal({
  open,
  onClose,
}: ReconciliationModalProps): React.JSX.Element {
  const [changes, setChanges] = useState<PendingChange[]>([])
  const [loading, setLoading] = useState(false)
  const [accepting, setAccepting] = useState<number | null>(null)

  // Load pending changes when modal opens
  useEffect(() => {
    if (!open) return
    async function load(): Promise<void> {
      setLoading(true)
      const result = await window.api.watcher.pendingChanges()
      setChanges(result)
      setLoading(false)
    }
    load()
  }, [open])

  const grouped = groupChanges(changes)
  const pending = changes.filter(c => c.status === 'pending')

  async function accept(id: number): Promise<void> {
    setAccepting(id)
    await window.api.watcher.acceptChange(id)
    setChanges((prev) => prev.map((c) =>
      c.id === id ? { ...c, status: 'accepted' } : c
    ))
    setAccepting(null)
  }

  async function ignore(id: number): Promise<void> {
    await window.api.watcher.ignoreChange(id)
    setChanges((prev) => prev.map((c) =>
      c.id === id ? { ...c, status: 'ignored' } : c
    ))
  }

  async function acceptAll(): Promise<void> {
    setLoading(true)
    for (const change of pending) {
      await window.api.watcher.acceptChange(change.id)
    }
    setChanges((prev) => prev.map(c => ({ ...c, status: 'accepted' })))
    setLoading(false)
  }

  async function ignoreAll(): Promise<void> {
    for (const change of pending) {
      await window.api.watcher.ignoreChange(change.id)
    }
    setChanges((prev) => prev.map((c) => ({ ...c, status: 'ignored' })))
  }

  const allResolved = pending.length === 0 && changes.length > 0

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent style={{
        background: '#13131b',
        border: '0.5px solid #1e1e2a',
        borderRadius: '12px',
        maxWidth: '520px',
        width: '100%',
        maxHeight: '80vh',
        overflowY: 'auto',
        color: '#e8e8f0',
        fontFamily: 'inherit',
        padding: '0',
      }}>

        {/* ── Header ── */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '0.5px solid #1e1e2a',
        }}>
          <div style={{ fontSize: '15px', fontWeight: 500, marginBottom: '4px' }}>
            Library changes detected
          </div>
          <div style={{ fontSize: '12px', color: '#555' }}>
            {pending.length > 0
              ? `${pending.length} change${pending.length !== 1 ? 's' : ''} need your review`
              : 'All changes resolved'}
          </div>
        </div>

        {loading && (
          <div style={{ padding: '24px', textAlign: 'center', color: '#444', fontSize: '13px' }}>
            Loading changes...
          </div>
        )}

        {!loading && changes.length === 0 && (
          <div style={{ padding: '24px', textAlign: 'center', color: '#444', fontSize: '13px' }}>
            No pending changes
          </div>
        )}

        {!loading && changes.length > 0 && (
          <div style={{ padding: '12px 20px' }}>

            {/* ── Moved files ── */}
            {grouped.moved.length > 0 && (
              <Section title="Files moved" icon="↗" color="#378add" count={grouped.moved.length}>
                {grouped.moved.map((change) => (
                  <ChangeRow
                    key={change.id}
                    change={change}
                    onAccept={accept}
                    onIgnore={ignore}
                    accepting={accepting === change.id}
                    description={
                      <span>
                        <span style={{ color: '#555' }}>{shortPath(change.old_path)}</span>
                        <span style={{ color: '#333', margin: '0 6px' }}>→</span>
                        <span style={{ color: '#c0c0d8' }}>{shortPath(change.new_path)}</span>
                      </span>
                    }
                  />
                ))}
              </Section>
            )}

            {/* ── New files ── */}
            {grouped.added.length > 0 && (
              <Section title="New files found" icon="+" color="#1d9e75" count={grouped.added.length}>
                {grouped.added.map((change) => (
                  <ChangeRow
                    key={change.id}
                    change={change}
                    onAccept={accept}
                    onIgnore={ignore}
                    accepting={accepting === change.id}
                    description={
                      <span style={{ color: '#c0c0d8' }}>
                        {shortPath(change.new_path)}
                      </span>
                    }
                  />
                ))}
              </Section>
            )}

            {/* ── Deleted files ── */}
            {grouped.deleted.length > 0 && (
              <Section title="Files no longer found" icon="✕" color="#d85a30" count={grouped.deleted.length}>
                {grouped.deleted.map((change) => (
                  <ChangeRow
                    key={change.id}
                    change={change}
                    onAccept={accept}
                    onIgnore={ignore}
                    accepting={accepting === change.id}
                    description={
                      <span style={{ color: '#555' }}>
                        {shortPath(change.old_path)}
                      </span>
                    }
                  />
                ))}
              </Section>
            )}

          </div>
        )}

        {/* ── Footer ── */}
        {!loading && pending.length > 0 && (
          <div style={{
            padding: '12px 20px',
            borderTop: '0.5px solid #1e1e2a',
            display: 'flex',
            gap: '8px',
            justifyContent: 'flex-end',
          }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={ignoreAll}
              className="text-xs"
              style={{ color: '#555' }}
            >
              Ignore all
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={acceptAll}
              disabled={loading}
              className="text-xs"
              style={{ borderColor: '#7f77dd', color: '#a09be8' }}
            >
              Accept all {pending.length} changes
            </Button>
          </div>
        )}

        {allResolved && (
          <div style={{
            padding: '12px 20px',
            borderTop: '0.5px solid #1e1e2a',
            display: 'flex',
            justifyContent: 'flex-end',
          }}>
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              className="text-xs"
            >
              Done
            </Button>
          </div>
        )}

      </DialogContent>
    </Dialog>
  )
}

// ── Section ──────────────────────────────────────────────

function Section({
  title,
  icon,
  color,
  count,
  children,
}: {
  title: string
  icon: string
  color: string
  count: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div style={{ marginBottom: '16px' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        marginBottom: '8px',
      }}>
        <span style={{
          width: '18px',
          height: '18px',
          borderRadius: '50%',
          background: color + '33',
          color: color,
          fontSize: '10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
          flexShrink: 0,
        }}>
          {icon}
        </span>
        <span style={{ fontSize: '11px', fontWeight: 500, color: '#888', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
          {title}
        </span>
        <Badge variant="outline" style={{
          fontSize: '10px', padding: '0 5px',
          background: color + '22', color, borderColor: color + '44',
        }}>
          {count}
        </Badge>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {children}
      </div>
    </div>
  )
}

// ── ChangeRow ─────────────────────────────────────────────

function ChangeRow({
  change,
  description,
  onAccept,
  onIgnore,
  accepting,
}: {
  change: PendingChange
  description: React.ReactNode
  onAccept: (id: number) => void
  onIgnore: (id: number) => void
  accepting: boolean
}): React.JSX.Element {
  const resolved = change.status !== 'pending'
  const artworkUrl = useArtworkUrl(change.artwork_hash, 'thumb')

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '8px 10px',
      background: '#1a1a26',
      borderRadius: '6px',
      opacity: resolved ? 0.4 : 1,
      transition: 'opacity 0.2s',
    }}>
      {/* Artwork */}
      <div style={{
        width: '32px',
        height: '32px',
        borderRadius: '4px',
        background: '#252535',
        flexShrink: 0,
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        {artworkUrl ? (
          <img
            src={artworkUrl}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <span style={{ fontSize: '14px', color: '#333' }}>♪</span>
        )}
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: '12px',
          fontWeight: 500,
          marginBottom: '2px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {change.title ?? change.artist ?? 'Unknown track'}
        </div>
        <div style={{ fontSize: '11px', lineHeight: 1.4 }}>
          {description}
        </div>
      </div>

      {/* Actions */}
      {!resolved ? (
        <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
          <button
            onClick={() => onIgnore(change.id)}
            style={{
              background: 'none',
              border: '0.5px solid #333',
              borderRadius: '4px',
              color: '#555',
              fontSize: '11px',
              padding: '3px 8px',
              cursor: 'pointer',
            }}
          >
            Ignore
          </button>
          <button
            onClick={() => onAccept(change.id)}
            disabled={accepting}
            style={{
              background: '#252535',
              border: '0.5px solid #7f77dd',
              borderRadius: '4px',
              color: '#a09be8',
              fontSize: '11px',
              padding: '3px 8px',
              cursor: accepting ? 'wait' : 'pointer',
              opacity: accepting ? 0.6 : 1,
            }}
          >
            {accepting ? '...' : 'Accept'}
          </button>
        </div>
      ) : (
        <span style={{ fontSize: '11px', color: '#444' }}>
          {change.status}
        </span>
      )}
    </div>
  )
}
