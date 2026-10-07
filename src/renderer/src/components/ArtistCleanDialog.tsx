// ── Artist names: review and re-clean ─────────────────────────────────────
// Two tabs over the same engine (main/artist/):
//   Review     the triage inbox — "Change X to Y?  Accept | Edit | Keep"
//   Re-clean   a dry run over the whole library, grouped by name and
//              confidence, with Review each / Approve all high confidence,
//              and one level of undo for the last batch.
// Nothing here matches or writes anything itself; it asks main to apply a
// decision and shows what happened, failures included.

import React, { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@renderer/components/ui/tabs'
import { useArtistCleanStore } from '../store/useArtistCleanStore'
import { refreshArtists } from '../lib/refreshArtists'

const TIER_COLOR: Record<ArtistConfidence, string> = {
  high: '#5dcaa5',
  medium: '#ba7517',
  low: '#888'
}

function TierBadge({ tier }: { tier: ArtistConfidence }): React.JSX.Element {
  return (
    <span
      style={{
        fontSize: '10px',
        textTransform: 'uppercase',
        letterSpacing: '0.6px',
        color: TIER_COLOR[tier],
        border: `0.5px solid ${TIER_COLOR[tier]}55`,
        borderRadius: '4px',
        padding: '1px 6px'
      }}
    >
      {tier}
    </span>
  )
}

function reportFailures(label: string, result: ArtistApplyResult): void {
  if (!result.ok || !result.result) {
    toast.error(label, { description: result.error })
    return
  }
  const { applied, failed, stale } = result.result
  if (failed.length > 0) {
    toast.error(`${applied} changed, ${failed.length} could not be written`, {
      description: `${failed
        .slice(0, 3)
        .map((f) => f.error)
        .join('; ')}${failed.length > 3 ? '…' : ''} Those files were left as they were.`
    })
  } else {
    toast.success(
      `${applied} track${applied === 1 ? '' : 's'} updated${stale ? ` · ${stale} skipped (changed since)` : ''}`
    )
  }
}

// ── Review tab ────────────────────────────────────────────────────────────

function ReviewTab(): React.JSX.Element {
  const [groups, setGroups] = useState<ArtistSuggestionGroup[] | null>(null)
  const [mode, setMode] = useState<'off' | 'auto' | 'suggest'>('auto')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await window.api.artist.suggestions()
    setGroups(r.groups)
    setMode(r.mode)
  }, [])
  useEffect(() => {
    let cancelled = false
    void window.api.artist.suggestions().then((r) => {
      if (cancelled) return
      setGroups(r.groups)
      setMode(r.mode)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function run(raw: string, work: () => Promise<ArtistApplyResult>): Promise<void> {
    setBusy(raw)
    const result = await work()
    setBusy(null)
    reportFailures('Could not change artist', result)
    setEditing(null)
    await Promise.all([load(), refreshArtists()])
  }

  async function keep(raw: string): Promise<void> {
    setBusy(raw)
    const r = await window.api.artist.keep(raw)
    setBusy(null)
    if (!r.ok) toast.error('Could not save', { description: r.error })
    await load()
  }

  if (groups === null) return <div style={{ color: '#555', fontSize: '12px' }}>Loading…</div>

  return (
    <div>
      {mode !== 'auto' && (
        <div style={{ fontSize: '11px', color: '#555', marginBottom: '10px' }}>
          {mode === 'suggest'
            ? 'Suggest-only mode: nothing is changed unless you accept it here.'
            : 'Auto-clean is off. Imports are not checked against your existing artists.'}
        </div>
      )}
      {groups.length === 0 ? (
        <div style={{ color: '#555', fontSize: '12px', padding: '16px 0' }}>
          Nothing to review. New imports that look like an artist you already have will appear here.
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            maxHeight: '380px',
            overflowY: 'auto'
          }}
        >
          {groups.map((g) => (
            <div
              key={`${g.raw}\u0000${g.suggested}`}
              style={{
                background: '#1a1a26',
                border: '0.5px solid #252535',
                borderRadius: '6px',
                padding: '10px 12px'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '12px', color: '#c0c0d8' }}>
                  Change <strong>{g.raw}</strong> to <strong>{g.suggested}</strong>?
                </span>
                <TierBadge tier={g.confidence} />
                <span style={{ fontSize: '11px', color: '#555' }}>
                  {g.trackCount} track{g.trackCount === 1 ? '' : 's'}
                  {g.reason === 'write-failed' ? ' · file could not be written last time' : ''}
                </span>
              </div>
              {editing === g.raw ? (
                <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && draft.trim())
                        void run(g.raw, () => window.api.artist.edit(g.raw, draft))
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    style={{
                      flex: 1,
                      background: '#0e0e16',
                      border: '0.5px solid #252535',
                      borderRadius: '5px',
                      color: '#c0c0d8',
                      fontSize: '12px',
                      padding: '4px 8px'
                    }}
                  />
                  <Button
                    size="sm"
                    disabled={!draft.trim() || busy === g.raw}
                    onClick={() => void run(g.raw, () => window.api.artist.edit(g.raw, draft))}
                  >
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                  <Button
                    size="sm"
                    disabled={busy === g.raw}
                    onClick={() => void run(g.raw, () => window.api.artist.accept(g.raw))}
                  >
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === g.raw}
                    onClick={() => {
                      setEditing(g.raw)
                      setDraft(g.suggested)
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === g.raw}
                    onClick={() => void keep(g.raw)}
                  >
                    Keep
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Re-clean tab ──────────────────────────────────────────────────────────

function RecleanTab({ onReview }: { onReview: () => void }): React.JSX.Element {
  const progress = useArtistCleanStore((s) => s.progress)
  const [preview, setPreview] = useState<ArtistRecleanPreview | null>(null)
  const [undo, setUndo] = useState<{ available: boolean; tracks: number }>({
    available: false,
    tracks: 0
  })
  const [working, setWorking] = useState(false)

  const loadUndo = useCallback(async () => setUndo(await window.api.artist.undoInfo()), [])
  useEffect(() => {
    let cancelled = false
    void window.api.artist.undoInfo().then((info) => {
      if (!cancelled) setUndo(info)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function runPreview(): Promise<void> {
    setWorking(true)
    const r = await window.api.artist.recleanPreview()
    setWorking(false)
    if (r.ok && r.result) setPreview(r.result)
    else toast.error('Could not check the library', { description: r.error })
  }

  async function approveHigh(): Promise<void> {
    setWorking(true)
    const result = await window.api.artist.recleanApproveHigh()
    setWorking(false)
    reportFailures('Could not apply', result)
    setPreview(null)
    await Promise.all([loadUndo(), refreshArtists()])
  }

  async function reviewEach(): Promise<void> {
    const r = await window.api.artist.recleanQueueReview()
    if (r.ok) {
      toast.success(`${r.result?.tracks ?? 0} tracks added to Review`)
      onReview()
    } else toast.error('Could not queue', { description: r.error })
  }

  async function undoBatch(): Promise<void> {
    setWorking(true)
    const result = await window.api.artist.undo()
    setWorking(false)
    reportFailures('Could not undo', result)
    await Promise.all([loadUndo(), refreshArtists()])
  }

  const running = working || (progress !== null && progress.phase !== 'idle')
  const high = preview?.byTier.high ?? 0

  return (
    <div>
      <div style={{ fontSize: '12px', color: '#555', marginBottom: '12px', lineHeight: 1.6 }}>
        Checks every artist in your library against the names you already use. This is a preview:
        nothing changes until you approve it.
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <Button size="sm" variant="outline" disabled={running} onClick={() => void runPreview()}>
          {preview ? 'Check again' : 'Check library'}
        </Button>
        {preview && (
          <>
            <Button
              size="sm"
              disabled={running || preview.groups.length === 0}
              onClick={() => void reviewEach()}
            >
              Review each
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={running || high === 0}
              onClick={() => void approveHigh()}
            >
              Approve all high confidence ({high})
            </Button>
          </>
        )}
        {undo.available && (
          <Button size="sm" variant="ghost" disabled={running} onClick={() => void undoBatch()}>
            Undo last batch ({undo.tracks} tracks)
          </Button>
        )}
      </div>

      {preview && (
        <>
          <div style={{ fontSize: '11px', color: '#555', marginBottom: '8px' }}>
            {preview.distinctNames.toLocaleString()} names checked · {preview.tracksAffected} tracks
            would change
            {' · '}
            {preview.byTier.high} high · {preview.byTier.medium} medium · {preview.byTier.low} low
          </div>
          {preview.groups.length === 0 ? (
            <div style={{ color: '#555', fontSize: '12px' }}>
              Your artist names are already consistent.
            </div>
          ) : (
            <div
              style={{
                maxHeight: '300px',
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px'
              }}
            >
              {preview.groups.map((g) => (
                <div
                  key={`${g.tier}\u0000${g.canonical}`}
                  style={{
                    background: '#1a1a26',
                    border: '0.5px solid #252535',
                    borderRadius: '6px',
                    padding: '8px 10px'
                  }}
                >
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <TierBadge tier={g.tier} />
                    <span style={{ fontSize: '12px', color: '#c0c0d8' }}>{g.canonical}</span>
                    <span style={{ fontSize: '11px', color: '#555' }}>{g.trackCount} tracks</span>
                  </div>
                  <div style={{ fontSize: '11px', color: '#555', marginTop: '4px' }}>
                    {g.items.map((i) => `${i.raw} ×${i.trackIds.length}`).join('  ·  ')}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── The dialog ────────────────────────────────────────────────────────────

// The body mounts only while the dialog is open, so each opening starts on the
// tab it was asked for and with fresh data.
function DialogBody({ initialTab }: { initialTab: 'review' | 'reclean' }): React.JSX.Element {
  const [tab, setTab] = useState<'review' | 'reclean'>(initialTab)
  return (
    <>
      <DialogTitle>Artist names</DialogTitle>
      <DialogDescription>
        Keep one spelling per artist. Your original is always kept, so any change can be reversed.
      </DialogDescription>
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'review' | 'reclean')}>
        <TabsList>
          <TabsTrigger value="review">Review</TabsTrigger>
          <TabsTrigger value="reclean">Re-clean library</TabsTrigger>
        </TabsList>
        <TabsContent value="review">
          <ReviewTab />
        </TabsContent>
        <TabsContent value="reclean">
          <RecleanTab onReview={() => setTab('review')} />
        </TabsContent>
      </Tabs>
    </>
  )
}

export function ArtistCleanDialog({
  open,
  onClose,
  initialTab = 'review'
}: {
  open: boolean
  onClose: () => void
  initialTab?: 'review' | 'reclean'
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent style={{ maxWidth: '620px' }}>
        <DialogBody initialTab={initialTab} />
      </DialogContent>
    </Dialog>
  )
}
