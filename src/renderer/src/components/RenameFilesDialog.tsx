// ── Rename files from the template ────────────────────────────────────────
// Renaming is the one action in this app a DJ cannot undo from inside it —
// the old name is gone. So this ALWAYS previews first: it asks main for a dry
// run, shows every before/after, and only renames when the DJ presses the
// second button having seen the list.
//
// The template itself is edited in Settings > Library. Changing it here would
// mean two places to look for the same setting.

import React, { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FilePen } from 'lucide-react'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import {
  DEFAULT_TEMPLATE,
  FILENAME_TEMPLATE_SETTING_KEY
} from '../../../main/filenameTemplate'

const ACCENT = '#7f77dd'

type Outcome = {
  trackId: number
  from: string
  to?: string
  status: 'renamed' | 'unchanged' | 'skipped' | 'failed'
  reason?: string
}

interface RenameFilesDialogProps {
  open: boolean
  trackIds: number[]
  scopeLabel: string
  onClose: () => void
  onRenamed: () => void
}

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

export function RenameFilesDialog({
  open,
  trackIds,
  scopeLabel,
  onClose,
  onRenamed
}: RenameFilesDialogProps): React.JSX.Element {
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE)
  const [preview, setPreview] = useState<Outcome[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [applied, setApplied] = useState(false)

  const loadPreview = useCallback(async () => {
    setBusy(true)
    try {
      const stored = await window.api.settings.get(FILENAME_TEMPLATE_SETTING_KEY)
      const value = stored || DEFAULT_TEMPLATE
      setTemplate(value)
      // apply: false — nothing is touched, this is what WOULD happen.
      const result = await window.api.fs.renameFromTemplate({
        trackIds,
        template: value,
        apply: false
      })
      setPreview(result.ok ? (result.results ?? []) : [])
      if (!result.ok) toast.error('Could not build a preview', { description: result.error })
    } finally {
      setBusy(false)
    }
  }, [trackIds])

  const [lastOpen, setLastOpen] = useState(open)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) {
      setPreview(null)
      setApplied(false)
    }
  }

  useEffect(() => {
    if (!open) return
    // Kicked off from a timer rather than called inline: loadPreview sets
    // `busy` synchronously, and a setState in an effect BODY is a cascading
    // render (react-hooks/set-state-in-effect). From a timer callback it is
    // an external-system update, which is what effects are for. Cleared on
    // unmount so closing the dialog mid-load does not fire a stale request.
    const timer = setTimeout(() => void loadPreview(), 0)
    return () => clearTimeout(timer)
  }, [open, loadPreview])

  const willRename = preview?.filter((r) => r.status === 'renamed') ?? []
  const unchanged = preview?.filter((r) => r.status === 'unchanged').length ?? 0
  const skipped = preview?.filter((r) => r.status === 'skipped') ?? []
  const failed = preview?.filter((r) => r.status === 'failed') ?? []

  async function apply(): Promise<void> {
    setBusy(true)
    try {
      const result = await window.api.fs.renameFromTemplate({
        trackIds: willRename.map((r) => r.trackId),
        template,
        apply: true
      })
      if (!result.ok) {
        toast.error('Rename failed', { description: result.error })
        return
      }
      const done = (result.results ?? []).filter((r) => r.status === 'renamed').length
      const bad = (result.results ?? []).filter((r) => r.status === 'failed')
      toast.success(`Renamed ${done} file${done === 1 ? '' : 's'}`, {
        description: bad.length ? `${bad.length} could not be renamed.` : undefined
      })
      setApplied(true)
      onRenamed()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        showCloseButton={false}
        style={{
          background: '#17171f',
          border: '0.5px solid #2e2e3e',
          borderRadius: '12px',
          maxWidth: '620px',
          width: '100%',
          maxHeight: '78vh',
          color: '#e8e8f0',
          fontFamily: 'inherit',
          padding: 0,
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <div style={{ padding: '18px 18px 12px', borderBottom: '0.5px solid #23232e' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '4px' }}>
            <FilePen size={15} style={{ color: ACCENT }} />
            <span style={{ fontSize: '14px', fontWeight: 500 }}>Rename files</span>
          </div>
          <div style={{ fontSize: '11px', color: '#555', lineHeight: 1.5 }}>
            {scopeLabel} · using{' '}
            <code style={{ color: '#a09be8', fontFamily: 'ui-monospace, monospace' }}>
              {template}
            </code>
            <br />
            Edit the template in Settings &rsaquo; Library.
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 18px' }}>
          {busy && !preview && (
            <div style={{ fontSize: '12px', color: '#555', padding: '20px 0' }}>
              Building preview…
            </div>
          )}

          {preview && willRename.length === 0 && (
            <div style={{ fontSize: '12px', color: '#1d9e75', padding: '14px 0' }}>
              ✓ Nothing to rename — every file already matches the template.
            </div>
          )}

          {willRename.map((r) => (
            <div key={r.trackId} style={{ fontSize: '11px', lineHeight: 1.6, marginBottom: '7px' }}>
              <div
                style={{
                  color: '#555',
                  fontFamily: 'ui-monospace, monospace',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
              >
                {baseName(r.from)}
              </div>
              <div
                style={{
                  color: '#1d9e75',
                  fontFamily: 'ui-monospace, monospace',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
              >
                → {r.to ? baseName(r.to) : ''}
              </div>
            </div>
          ))}

          {/* Skips are shown, not hidden: a track the template cannot name is
              something the DJ may want to fix rather than silently leave. */}
          {skipped.length > 0 && (
            <div style={{ marginTop: '12px', borderTop: '0.5px solid #1e1e2a', paddingTop: '10px' }}>
              <div style={{ fontSize: '10px', textTransform: 'uppercase', color: '#444', marginBottom: '6px' }}>
                Skipped — {skipped.length}
              </div>
              {skipped.slice(0, 8).map((r) => (
                <div key={r.trackId} style={{ fontSize: '11px', color: '#ba7517', lineHeight: 1.5 }}>
                  {baseName(r.from)} — {r.reason}
                </div>
              ))}
            </div>
          )}

          {failed.length > 0 && (
            <div style={{ marginTop: '10px', fontSize: '11px', color: '#d8695d' }}>
              {failed.length} could not be processed.
            </div>
          )}
        </div>

        <div
          style={{
            padding: '12px 18px',
            borderTop: '0.5px solid #23232e',
            display: 'flex',
            alignItems: 'center',
            gap: '10px'
          }}
        >
          <div style={{ flex: 1, fontSize: '11px', color: '#5a5a70' }}>
            {preview
              ? `${willRename.length} to rename` +
                (unchanged ? `, ${unchanged} already correct` : '') +
                (skipped.length ? `, ${skipped.length} skipped` : '')
              : ''}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void apply()}
            disabled={busy || applied || willRename.length === 0}
            title="Renames the files on your drive"
          >
            {busy ? 'Working…' : `Rename ${willRename.length}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
