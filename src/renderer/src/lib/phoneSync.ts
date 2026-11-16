// Small display helpers for Settings > Phone sync.

export function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatLastSeen(lastSeenAt: number | null, now: number): string {
  if (lastSeenAt === null) return 'Not synced yet'
  const minutes = Math.floor((now - lastSeenAt) / 60000)
  if (minutes < 1) return 'Last seen just now'
  if (minutes < 60) return `Last seen ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Last seen ${hours} h ago`
  return `Last seen ${new Date(lastSeenAt).toLocaleDateString()}`
}

// Written for the DJ; the server's own message comes first when it has one.
export function statusLine(status: LocalSyncStatus): string {
  switch (status.state) {
    case 'off':
      return 'Off'
    case 'starting':
      return 'Starting…'
    case 'running':
      return `On, ready on port ${status.port}`
    case 'error':
      return status.message
  }
}
