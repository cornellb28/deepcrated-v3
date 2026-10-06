import React, { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import {
  validateForm,
  hasErrors,
  friendlyAuthError,
  type FieldErrors
} from '@renderer/lib/authValidation'

// The sign-in / sign-up form, embeddable rather than full-screen.
//
// Signing in is NOT a gate: the desktop app is free and entirely local, so
// it opens straight into the library and this panel is reached from Settings
// instead. An account only matters for the paid cloud surface, which is why
// it lives next to the upgrade section.

interface AuthPanelProps {
  configured: boolean
  persistent: boolean
  onSignedIn: (state: AuthState) => void
}

type Mode = 'sign-in' | 'sign-up'

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

const linkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#7f77dd',
  cursor: 'pointer',
  padding: 0,
  fontFamily: 'inherit',
  fontSize: '11px'
}

function FieldError({ message }: { message?: string }): React.JSX.Element | null {
  if (!message) return null
  return <div style={{ fontSize: '10px', color: '#d85a30', marginTop: '-2px' }}>{message}</div>
}

export function AuthPanel({
  configured,
  persistent,
  onSignedIn
}: AuthPanelProps): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  // Separate from `busy`: the Google flow leaves the app entirely, so no
  // invoke() is going to resolve and clear it. It clears when the deep link
  // comes back and App re-renders with a user.
  const [waitingForBrowser, setWaitingForBrowser] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<FieldErrors>({})
  const [awaitingConfirmation, setAwaitingConfirmation] = useState<string | null>(null)
  const [resending, setResending] = useState(false)

  // Field errors clear as soon as the DJ edits the offending field — leaving
  // "that doesn't look like an email address" under a field they are midway
  // through fixing reads as the app arguing with them.
  function updateEmail(value: string): void {
    setEmail(value)
    if (fields.email) setFields({ ...fields, email: undefined })
  }

  function updatePasswordField(value: string): void {
    setPassword(value)
    if (fields.password) setFields({ ...fields, password: undefined })
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()

    const found = validateForm(email, password, mode)
    setFields(found)
    if (hasErrors(found)) return

    setBusy(true)
    setError(null)
    try {
      if (mode === 'sign-up') {
        const result = await window.api.auth.signUp(email.trim(), password)
        if (!result.ok) setError(friendlyAuthError(result.error))
        else if (result.needsConfirmation) setAwaitingConfirmation(result.email)
        else onSignedIn(result.state)
        return
      }

      const result = await window.api.auth.signIn(email.trim(), password)
      if (result.ok) onSignedIn(result.state)
      else setError(friendlyAuthError(result.error))
    } finally {
      setBusy(false)
    }
  }

  async function handleGoogle(): Promise<void> {
    setError(null)
    setWaitingForBrowser(true)
    const result = await window.api.auth.google()
    if (!result.ok) {
      setWaitingForBrowser(false)
      setError(friendlyAuthError(result.error ?? 'Could not start Google sign-in.'))
    }
  }

  async function handleResend(): Promise<void> {
    if (!awaitingConfirmation) return
    setResending(true)
    try {
      const result = await window.api.auth.resendConfirmation(awaitingConfirmation)
      if (result.ok) toast.success('Confirmation email sent')
      else toast.error('Could not resend', { description: friendlyAuthError(result.error ?? '') })
    } finally {
      setResending(false)
    }
  }

  // The email now comes back into the app as a cratecloud:// recovery link,
  // which opens the set-a-new-password dialog — so this only has to send it.
  async function handleForgotPassword(): Promise<void> {
    const emailError = validateForm(email, 'placeholder', 'sign-in').email
    if (emailError) {
      setFields({ ...fields, email: emailError })
      return
    }
    const result = await window.api.auth.resetPassword(email.trim())
    if (result.ok) {
      toast.success('Reset email sent', {
        description: `Open the link in ${email.trim()} and you'll be brought back here.`
      })
    } else {
      setError(friendlyAuthError(result.error ?? 'Could not send the reset email.'))
    }
  }

  if (!configured) {
    return (
      <div style={{ fontSize: '11px', color: '#d85a30', lineHeight: 1.5 }}>
        Supabase isn&apos;t configured. Copy <code>.env.example</code> to <code>.env</code>, fill in
        the two <code>MAIN_VITE_SUPABASE_*</code> values, then restart.
      </div>
    )
  }

  if (awaitingConfirmation !== null) {
    return (
      <div style={{ fontSize: '12px', color: '#c0c0d8', lineHeight: 1.6 }}>
        Account created. Check <strong>{awaitingConfirmation}</strong> for a confirmation link, then
        sign in.
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
          <Button
            onClick={() => void handleResend()}
            disabled={resending}
            variant="outline"
            size="sm"
          >
            {resending ? 'Sending…' : 'Resend email'}
          </Button>
          <Button
            onClick={() => {
              setAwaitingConfirmation(null)
              setMode('sign-in')
              setPassword('')
              setError(null)
            }}
            variant="outline"
            size="sm"
          >
            Back to sign in
          </Button>
        </div>
        <div style={{ fontSize: '10px', color: '#444', marginTop: '12px' }}>
          Nothing arrived? Check spam — resends are rate-limited to about once a minute.
        </div>
      </div>
    )
  }

  return (
    <div>
      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => updateEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          style={{
            ...inputStyle,
            borderColor: fields.email ? '#d85a30' : '#333'
          }}
        />
        <FieldError message={fields.email} />

        <input
          type="password"
          value={password}
          onChange={(e) => updatePasswordField(e.target.value)}
          placeholder="Password"
          autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
          style={{
            ...inputStyle,
            borderColor: fields.password ? '#d85a30' : '#333'
          }}
        />
        <FieldError message={fields.password} />

        <Button type="submit" disabled={busy} variant="outline" size="sm">
          {busy ? 'Working…' : mode === 'sign-up' ? 'Create account' : 'Sign in'}
        </Button>
      </form>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          margin: '12px 0',
          color: '#333',
          fontSize: '10px'
        }}
      >
        <div style={{ flex: 1, height: '0.5px', background: '#1e1e2a' }} />
        OR
        <div style={{ flex: 1, height: '0.5px', background: '#1e1e2a' }} />
      </div>

      <Button
        onClick={() => void handleGoogle()}
        disabled={waitingForBrowser}
        variant="outline"
        size="sm"
        style={{ width: '100%' }}
      >
        {waitingForBrowser ? 'Waiting for your browser…' : 'Continue with Google'}
      </Button>

      {waitingForBrowser && (
        <div style={{ fontSize: '10px', color: '#555', marginTop: '6px', lineHeight: 1.5 }}>
          Finish in your browser — this window will pick it up automatically.
        </div>
      )}

      {error !== null && (
        <div style={{ fontSize: '11px', color: '#d85a30', marginTop: '10px', lineHeight: 1.5 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '12px' }}>
        <button
          onClick={() => {
            setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')
            setError(null)
            setFields({})
          }}
          style={linkStyle}
        >
          {mode === 'sign-in' ? 'Create an account' : 'Have an account? Sign in'}
        </button>

        {mode === 'sign-in' && (
          <button
            onClick={() => void handleForgotPassword()}
            style={{ ...linkStyle, color: '#555' }}
          >
            Forgot password?
          </button>
        )}
      </div>

      {!persistent && (
        <div style={{ fontSize: '10px', color: '#444', marginTop: '10px', lineHeight: 1.5 }}>
          Your system keychain is unavailable, so this session won&apos;t be remembered after you
          quit.
        </div>
      )}
    </div>
  )
}
