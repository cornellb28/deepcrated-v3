import React, { useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { MIN_PASSWORD_LENGTH, friendlyAuthError } from '@renderer/lib/authValidation'

// Opened when a cratecloud:// recovery link comes back from the reset email.
// By the time this appears the recovery session is already adopted — that is
// what authorises the update — so this only needs the new password.
//
// It is deliberately a dialog rather than a Settings section: the DJ arrives
// here from their email client, not from inside the app, and the one thing
// they came to do should be in front of them.

interface PasswordResetDialogProps {
  open: boolean
  onClose: () => void
}

const inputStyle: React.CSSProperties = {
  background: '#0e0e12',
  border: '0.5px solid #333',
  borderRadius: '4px',
  color: '#e8e8f0',
  fontSize: '12px',
  padding: '8px 10px',
  fontFamily: 'inherit',
  width: '100%'
}

export function PasswordResetDialog({
  open,
  onClose
}: PasswordResetDialogProps): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()

    // Checked here rather than only server-side: a mismatch is the DJ's own
    // typo, and Supabase has no way to know about it — it only ever receives
    // one password.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (password !== confirm) {
      setError("Those two passwords don't match.")
      return
    }

    setBusy(true)
    setError(null)
    try {
      const result = await window.api.auth.updatePassword(password)
      if (!result.ok) {
        setError(friendlyAuthError(result.error))
        return
      }
      toast.success('Password updated', { description: "You're signed in." })
      setPassword('')
      setConfirm('')
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        style={{
          background: '#141419',
          border: '0.5px solid #1e1e2a',
          maxWidth: '360px',
          color: '#e8e8f0',
          fontFamily: 'inherit',
          padding: '16px'
        }}
      >
        <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: '4px' }}>
          Set a new password
        </div>
        <div style={{ fontSize: '11px', color: '#555', marginBottom: '14px' }}>
          You&apos;re signed in from the reset link. Choose a new password to finish.
        </div>

        <form
          onSubmit={handleSubmit}
          style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
        >
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="New password"
            autoComplete="new-password"
            style={inputStyle}
          />
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm new password"
            autoComplete="new-password"
            style={inputStyle}
          />

          {error !== null && (
            <div style={{ fontSize: '11px', color: '#d85a30', lineHeight: 1.5 }}>{error}</div>
          )}

          <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
            <Button type="submit" disabled={busy} variant="outline" size="sm">
              {busy ? 'Saving…' : 'Update password'}
            </Button>
            {/* Dismissing leaves the DJ signed in from the recovery link with
                their OLD password still valid — which is fine, and better
                than trapping them in a dialog they opened by accident. */}
            <Button onClick={onClose} disabled={busy} variant="outline" size="sm">
              Not now
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
