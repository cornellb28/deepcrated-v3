// ── Filename template editor ──────────────────────────────────────────────
// Where the DJ decides what a renamed file is called. Lives in
// Settings > Library; the rename actions read the saved template.
//
// The preview is the point. A template is a small language, and the only way
// to know what "%artist% - %title% (%year%)" does to a track with no year is
// to see it — which is exactly the case the tidying rules exist for, and
// exactly the one a DJ would otherwise discover on 400 renamed files.

import React, { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { useLibraryStore } from '../store/useLibraryStore'
import {
  DEFAULT_TEMPLATE,
  FILENAME_TEMPLATE_SETTING_KEY,
  TEMPLATE_PRESETS,
  TEMPLATE_TOKENS,
  buildFilename
} from '../../../main/filenameTemplate'

const ACCENT = '#7f77dd'

export function FilenameTemplateEditor(): React.JSX.Element {
  const tracks = useLibraryStore((s) => s.tracks)

  const [template, setTemplate] = useState(DEFAULT_TEMPLATE)
  const [saved, setSaved] = useState(DEFAULT_TEMPLATE)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    window.api.settings.get(FILENAME_TEMPLATE_SETTING_KEY).then((stored) => {
      if (cancelled) return
      const value = stored || DEFAULT_TEMPLATE
      setTemplate(value)
      setSaved(value)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Previewed against REAL tracks, not a made-up one. A template that looks
  // fine against "Artist - Title" can still fall apart on the DJ's own
  // library, which is the only library that matters here.
  const samples = useMemo(() => {
    const withArtist = tracks.filter((t) => t.artist && t.title).slice(0, 2)
    // Deliberately include a sparse track if there is one — that is where
    // the tidying rules show their work.
    const sparse = tracks.find((t) => t.title && (!t.artist || !t.year))
    const picked = [...withArtist]
    if (sparse && !picked.some((t) => t.id === sparse.id)) picked.push(sparse)
    return picked.slice(0, 3)
  }, [tracks])

  const dirty = template !== saved

  async function save(): Promise<void> {
    const probe = buildFilename(template, { artist: 'A', title: 'B' })
    if (!probe.ok) {
      toast.error('That template produces no filename', { description: probe.reason })
      return
    }
    await window.api.settings.set(FILENAME_TEMPLATE_SETTING_KEY, template)
    setSaved(template)
    toast.success('Filename template saved')
  }

  if (loading) return <div style={{ fontSize: '12px', color: '#555' }}>Loading…</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <input
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          spellCheck={false}
          style={{
            flex: 1,
            background: '#0e0e12',
            border: `0.5px solid ${dirty ? ACCENT : '#333'}`,
            borderRadius: '6px',
            color: '#e8e8f0',
            fontSize: '12px',
            fontFamily: 'ui-monospace, monospace',
            padding: '8px 10px',
            outline: 'none'
          }}
        />
        <Button size="sm" variant="outline" onClick={() => void save()} disabled={!dirty}>
          {dirty ? 'Save' : 'Saved'}
        </Button>
      </div>

      {/* ── Tokens ─────────────────────────────────────── */}
      <div>
        <Label>Click to insert</Label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {TEMPLATE_TOKENS.map((token) => (
            <button
              key={token}
              type="button"
              onClick={() => setTemplate((t) => `${t}%${token}%`)}
              style={{
                background: '#16161f',
                border: '0.5px solid #252535',
                borderRadius: '4px',
                color: '#a09be8',
                fontSize: '10px',
                fontFamily: 'ui-monospace, monospace',
                padding: '3px 7px',
                cursor: 'pointer'
              }}
            >
              %{token}%
            </button>
          ))}
        </div>
      </div>

      {/* ── Presets ────────────────────────────────────── */}
      <div>
        <Label>Or start from one of these</Label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {TEMPLATE_PRESETS.map((preset) => (
            <button
              key={preset.template}
              type="button"
              onClick={() => setTemplate(preset.template)}
              title={preset.template}
              style={{
                background: template === preset.template ? `${ACCENT}22` : 'none',
                border: `0.5px solid ${template === preset.template ? `${ACCENT}66` : '#252535'}`,
                borderRadius: '4px',
                color: template === preset.template ? '#a09be8' : '#6a6a80',
                fontSize: '10px',
                padding: '3px 8px',
                cursor: 'pointer',
                fontFamily: 'inherit'
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Preview ────────────────────────────────────── */}
      <div>
        <Label>Preview, against your own tracks</Label>
        {samples.length === 0 ? (
          <div style={{ fontSize: '11px', color: '#444' }}>
            Import some tracks to see a preview.
          </div>
        ) : (
          <div
            style={{
              background: '#0e0e12',
              border: '0.5px solid #1e1e2a',
              borderRadius: '6px',
              padding: '8px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px'
            }}
          >
            {samples.map((track) => {
              const result = buildFilename(template, track)
              const ext = track.filename?.slice(track.filename.lastIndexOf('.')) ?? ''
              return (
                <div key={track.id} style={{ fontSize: '11px', lineHeight: 1.5 }}>
                  <div
                    style={{
                      color: '#444',
                      fontFamily: 'ui-monospace, monospace',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}
                  >
                    {track.filename}
                  </div>
                  <div
                    style={{
                      color: result.ok ? '#1d9e75' : '#ba7517',
                      fontFamily: 'ui-monospace, monospace',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}
                  >
                    {result.ok ? `→ ${result.name}${ext}` : `→ skipped: ${result.reason}`}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div style={{ fontSize: '10px', color: '#4a4a58', lineHeight: 1.6 }}>
        A field with no value drops out, and takes any punctuation left beside it — a track with
        no year gets a shorter name, not <code style={{ color: '#5a5a70' }}>Title ()</code>.
        Characters a filename cannot hold ( / \ : * ? &quot; &lt; &gt; | ) become
        <code style={{ color: '#5a5a70' }}> -</code>.
      </div>
    </div>
  )
}

function Label({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        fontSize: '10px',
        fontWeight: 500,
        letterSpacing: '0.6px',
        textTransform: 'uppercase',
        color: '#444',
        marginBottom: '6px'
      }}
    >
      {children}
    </div>
  )
}
