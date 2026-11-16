import React, { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Smartphone } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { SwitchButton } from './SwitchButton'
import { formatCountdown, formatLastSeen, statusLine } from '../lib/phoneSync'

// Settings > Phone sync: turn the local wifi server on, pair a phone, see
// and revoke paired phones, name this desktop. Everything shown comes from
// main's PhoneSyncState, which carries no secrets. Applying phone edits and
// sending the library down are later work.

type SectionComponent = (props: {
  title: string
  description?: string
  children: React.ReactNode
  last?: boolean
}) => React.JSX.Element

const muted: React.CSSProperties = { fontSize: '11px', color: '#555', lineHeight: 1.6 }
const body: React.CSSProperties = { fontSize: '12px', color: '#c0c0d8' }
const panel: React.CSSProperties = {
  background: '#1a1a26',
  border: '0.5px solid #252535',
  borderRadius: '6px',
  padding: '14px'
}
const mono = 'ui-monospace, monospace'

export function PhoneSyncSettings({ Section }: { Section: SectionComponent }): React.JSX.Element {
  const [state, setState] = useState<PhoneSyncState | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  // Set when the countdown reaches zero, so the screen can say the code
  // expired rather than silently dropping it.
  const [expired, setExpired] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<PhoneSyncPhone | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const nameDirty = useRef(false)

  function apply(next: PhoneSyncState): void {
    setState(next)
    if (!nameDirty.current) setNameDraft(next.desktopName)
  }

  useEffect(() => {
    let cancelled = false
    void window.api.localSync.getState().then((s) => {
      if (!cancelled) apply(s)
    })
    window.api.localSync.onChanged((s) => apply(s))
    return () => {
      cancelled = true
      window.api.localSync.offChanged()
      // A code left live after the DJ walks away would stay redeemable for
      // its full five minutes; end it with the screen.
      void window.api.localSync.cancelPairing()
    }
  }, [])

  const pairing = state?.pairing ?? null

  // Tick once a second while a code is live; refetch when it runs out.
  useEffect(() => {
    if (!pairing) return
    const timer = setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= pairing.expiresAt) {
        clearInterval(timer)
        setExpired(true)
        void window.api.localSync.getState().then(apply)
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [pairing])

  async function run(call: () => Promise<PhoneSyncResult>, failure: string): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const result = await call()
      if (result.ok && result.state) apply(result.state)
      else toast.error(failure, { description: result.error })
    } finally {
      setBusy(false)
    }
  }

  async function startPairing(): Promise<void> {
    setExpired(false)
    setNow(Date.now())
    await run(() => window.api.localSync.startPairing(), 'Could not start pairing')
  }

  async function saveName(): Promise<void> {
    nameDirty.current = false
    await run(() => window.api.localSync.setDesktopName(nameDraft), 'Could not save the name')
  }

  if (!state) {
    return <div style={muted}>Loading…</div>
  }

  const running = state.status.state === 'running'
  const activePhones = state.phones.filter((p) => p.revokedAt === null)
  const revokedPhones = state.phones.filter((p) => p.revokedAt !== null)

  return (
    <>
      <Section
        title="Phone sync over wifi"
        description="Edit tags and crates on your phone and bring them home over your own wifi. Nothing leaves your network."
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
          <SwitchButton
            checked={state.enabled}
            disabled={busy || state.status.state === 'starting'}
            labelledBy="phone-sync-label"
            testId="phone-sync-switch"
            onClick={() =>
              void run(
                () => window.api.localSync.setEnabled(!state.enabled),
                'Could not change phone sync'
              )
            }
          />
          <div>
            <div id="phone-sync-label" style={body}>
              Let phones connect to this desktop
            </div>
            <div
              data-testid="phone-sync-status"
              style={{
                ...muted,
                marginTop: '2px',
                color: state.status.state === 'error' ? '#e08a80' : running ? '#7fbf8f' : '#555'
              }}
            >
              {statusLine(state.status)}
            </div>
            {state.status.state === 'error' && (
              <div style={{ ...muted, marginTop: '4px', maxWidth: '48ch' }}>
                Check that this computer is on wifi or ethernet, and that your firewall allows
                DeepCrated to accept incoming connections. Then turn this off and on again.
              </div>
            )}
          </div>
        </div>
      </Section>

      {running && (
        <Section
          title="Pair a phone"
          description="Open DeepCrated on your phone and scan the code, or type the details below."
        >
          {pairing ? (
            <PairingPanel
              pairing={pairing}
              now={now}
              busy={busy}
              onNewCode={() => void startPairing()}
              onCancel={() =>
                void run(() => window.api.localSync.cancelPairing(), 'Could not cancel')
              }
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {state.lastPairingEnd?.reason === 'paired' && (
                <div style={{ ...body, color: '#7fbf8f' }}>
                  Paired with {state.lastPairingEnd.displayName}. You&rsquo;re all set.
                </div>
              )}
              {state.lastPairingEnd?.reason === 'locked' && (
                <div style={{ ...body, color: '#e0b080' }}>
                  That code had too many wrong tries, so it stopped working. Start a new one.
                </div>
              )}
              {!state.lastPairingEnd && expired && (
                <div style={{ ...body, color: '#e0b080' }}>That code expired. Start a new one.</div>
              )}
              <div>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void startPairing()}
                  data-testid="phone-sync-pair"
                >
                  <Smartphone size={14} />
                  {state.lastPairingEnd || expired ? 'Pair another phone' : 'Pair a phone'}
                </Button>
              </div>
            </div>
          )}
        </Section>
      )}

      <Section
        title="Paired phones"
        description={
          activePhones.length || revokedPhones.length
            ? 'Phones that can sync with this desktop. Revoke one to stop it syncing; it can pair again later.'
            : undefined
        }
      >
        {activePhones.length === 0 && revokedPhones.length === 0 ? (
          <div style={muted}>No phones paired yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '620px' }}>
            {[...activePhones, ...revokedPhones].map((phone) => (
              <div
                key={phone.phoneId}
                style={{ ...panel, padding: '12px 14px', display: 'flex', alignItems: 'center' }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={body}>{phone.displayName}</div>
                  <div style={muted}>
                    {phone.revokedAt !== null ? 'Revoked' : formatLastSeen(phone.lastSeenAt, now)}
                  </div>
                </div>
                {phone.revokedAt === null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs"
                    style={{ color: '#e08a80' }}
                    onClick={() => setRevokeTarget(phone)}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Desktop name" description="What your phone calls this computer." last>
        <div style={{ display: 'flex', gap: '8px', maxWidth: '420px' }}>
          <input
            value={nameDraft}
            placeholder={state.defaultDesktopName}
            maxLength={63}
            onChange={(e) => {
              nameDirty.current = true
              setNameDraft(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveName()
            }}
            style={{
              flex: 1,
              background: '#0e0e12',
              border: '0.5px solid #333',
              borderRadius: '6px',
              color: '#e8e8f0',
              fontSize: '12px',
              padding: '8px 10px',
              outline: 'none'
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || nameDraft.trim() === state.desktopName}
            onClick={() => void saveName()}
          >
            Save
          </Button>
        </div>
        <div style={{ ...muted, marginTop: '6px' }}>
          Leave it empty to use {state.defaultDesktopName}.
        </div>
      </Section>

      <Dialog open={revokeTarget !== null} onOpenChange={(v) => !v && setRevokeTarget(null)}>
        <DialogContent
          style={{
            background: '#13131b',
            border: '0.5px solid #1e1e2a',
            borderRadius: '12px',
            maxWidth: '380px',
            width: '100%',
            color: '#e8e8f0',
            fontFamily: 'inherit',
            padding: '20px'
          }}
        >
          <div
            style={{ fontSize: '14px', fontWeight: 500, textAlign: 'center', marginBottom: '8px' }}
          >
            Revoke {revokeTarget?.displayName}?
          </div>
          <div style={{ ...muted, fontSize: '12px', textAlign: 'center', marginBottom: '20px' }}>
            This phone stops syncing with this desktop. Edits waiting on the phone stay there, and
            it can pair again whenever you like.
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Button
              variant="ghost"
              size="sm"
              className="flex-1 text-xs"
              style={{ color: '#555' }}
              onClick={() => setRevokeTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1 text-xs"
              style={{ borderColor: '#d8695d', color: '#e08a80' }}
              onClick={() => {
                const target = revokeTarget
                setRevokeTarget(null)
                if (target)
                  void run(() => window.api.localSync.revoke(target.phoneId), 'Could not revoke')
              }}
            >
              Revoke
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function PairingPanel({
  pairing,
  now,
  busy,
  onNewCode,
  onCancel
}: {
  pairing: PhoneSyncPairing
  now: number
  busy: boolean
  onNewCode: () => void
  onCancel: () => void
}): React.JSX.Element {
  const left = pairing.expiresAt - now
  return (
    <div
      data-testid="phone-sync-pairing"
      style={{ ...panel, display: 'flex', gap: '20px', flexWrap: 'wrap', maxWidth: '620px' }}
    >
      <img
        src={pairing.qrDataUrl}
        alt="Pairing QR code"
        width={200}
        height={200}
        style={{ borderRadius: '6px', background: '#fff', flexShrink: 0 }}
      />
      <div
        style={{
          flex: 1,
          minWidth: '220px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px'
        }}
      >
        <div>
          <div style={muted}>Security check: compare this with your phone</div>
          <div
            data-testid="phone-sync-fingerprint"
            style={{ fontFamily: mono, fontSize: '22px', letterSpacing: '1px', color: '#e8e8f0' }}
          >
            {pairing.shortFingerprint}
          </div>
          <div style={muted}>Only finish pairing if your phone shows exactly the same.</div>
        </div>
        <div>
          <div style={muted}>Pairing code</div>
          <div style={{ fontFamily: mono, fontSize: '16px', color: '#e8e8f0' }}>
            {pairing.pairingCode}
          </div>
        </div>
        <div>
          <div style={muted}>Address{pairing.hosts.length > 1 ? 'es' : ''} and port</div>
          {pairing.hosts.map((host) => (
            <div key={host} style={{ fontFamily: mono, fontSize: '12px', color: '#c0c0d8' }}>
              {host} &nbsp;port {pairing.port}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={muted} data-testid="phone-sync-countdown">
            Code works for {formatCountdown(left)}
          </span>
          <Button variant="ghost" size="sm" className="text-xs" disabled={busy} onClick={onNewCode}>
            New code
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            style={{ color: '#555' }}
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}
