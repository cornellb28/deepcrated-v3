import React, { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { useLibraryStore } from '../store/useLibraryStore'

// Settings > Serato > Tags in your files. Serato only ever sees what is in
// the audio file, so this lists the files whose tags are out of step with
// DeepCrated — read the way Serato reads them — and writes the ones the DJ
// approves. Nothing is written by "Check". A column only the file has is
// never cleared. See main/fileTagSync.ts.

const FIELD_LABELS: Record<string, string> = {
  artist: 'Artist',
  album: 'Album',
  genre: 'Genre',
  comment: 'Comment',
  label: 'Label',
  remixer: 'Remixer',
  composer: 'Composer',
  grouping: 'Grouping'
}

// Enough to review; the write still covers every track in the plan.
const LIST_LIMIT = 50

type Phase = 'idle' | 'checking' | 'ready' | 'writing' | 'written'

export function FileTagSync(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const [plan, setPlan] = useState<FileTagSyncPlan | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [result, setResult] = useState<{ written: number; failed: number } | null>(null)
  const job = useLibraryStore((s) => (jobId ? s.jobs[jobId] : undefined)) as
    EditTagsProgressPayload | undefined

  // The App-level listener keeps the job in the store and drops it shortly
  // after it ends; subscribe so the outcome is caught before it goes.
  useEffect(() => {
    if (!jobId) return
    return useLibraryStore.subscribe((state) => {
      const j = state.jobs[jobId] as EditTagsProgressPayload | undefined
      if (j && (j.phase === 'done' || j.phase === 'error')) {
        setResult({ written: j.done - j.failed.length, failed: j.failed.length })
        setPhase('written')
        setJobId(null)
      }
    })
  }, [jobId])

  async function check(): Promise<void> {
    setPhase('checking')
    setResult(null)
    const res = await window.api.tags.fileSyncPlan()
    if (!res.ok || !res.plan) {
      toast.error('Could not check your files', { description: res.error })
      setPhase('idle')
      return
    }
    setPlan(res.plan)
    setPhase('ready')
  }

  async function write(): Promise<void> {
    if (!plan || plan.tracks.length === 0) return
    setPhase('writing')
    const res = await window.api.tags.fileSyncWrite(plan.tracks.map((t) => t.trackId))
    if (!res.ok) {
      toast.error('Could not write tags', { description: res.error })
      setPhase('ready')
      return
    }
    if (!res.jobId) {
      setResult({ written: 0, failed: 0 })
      setPhase('written')
      return
    }
    setJobId(res.jobId)
  }

  const muted = { fontSize: '11px', color: '#666', lineHeight: 1.6 } as const

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void check()}
          disabled={phase === 'checking' || phase === 'writing'}
          data-testid="file-tag-check"
        >
          {phase === 'checking' ? 'Checking files…' : 'Check files'}
        </Button>
        {phase === 'ready' && plan && plan.tracks.length > 0 && (
          <Button
            size="sm"
            onClick={() => void write()}
            data-testid="file-tag-write"
            style={{ background: '#7f77dd', color: '#fff' }}
          >
            Write {plan.tracks.length.toLocaleString()} file{plan.tracks.length === 1 ? '' : 's'}
          </Button>
        )}
      </div>

      {phase === 'writing' && (
        <div style={muted}>Writing tags…{job ? ` ${job.done} of ${job.total}` : ''}</div>
      )}

      {phase === 'written' && result && (
        <div style={{ ...muted, color: '#c0c0d8' }}>
          {result.written.toLocaleString()} file{result.written === 1 ? '' : 's'} updated
          {result.failed > 0 ? `, ${result.failed} failed` : ''}. In Serato, select those tracks and
          choose <b>Rescan ID3 Tags</b> (Files panel) so it shows the new tags — Serato keeps its
          own copy until it re-reads the file.
        </div>
      )}

      {(phase === 'ready' || phase === 'writing') && plan && (
        <div style={muted} data-testid="file-tag-summary">
          {plan.tracks.length === 0 ? (
            <>
              All {plan.checked.toLocaleString()} files match DeepCrated. If Serato still shows old
              tags, use Rescan ID3 Tags in Serato.
            </>
          ) : (
            <>
              {plan.tracks.length.toLocaleString()} of {plan.checked.toLocaleString()} files are out
              of step:{' '}
              {Object.entries(plan.byField)
                .map(([f, n]) => `${FIELD_LABELS[f] ?? f} ${n}`)
                .join(' · ')}
              .
            </>
          )}
          {plan.fileOnly > 0 && (
            <>
              {' '}
              {plan.fileOnly.toLocaleString()} value{plan.fileOnly === 1 ? '' : 's'} only in the
              file (DeepCrated empty) are left alone.
            </>
          )}
          {plan.unreadable > 0 && (
            <> {plan.unreadable} file(s) could not be read and are skipped.</>
          )}
        </div>
      )}

      {phase === 'ready' && plan && plan.tracks.length > 0 && (
        <div
          style={{
            maxHeight: '260px',
            overflowY: 'auto',
            border: '0.5px solid #1e1e2a',
            borderRadius: '6px',
            padding: '6px 8px'
          }}
        >
          {plan.tracks.slice(0, LIST_LIMIT).map((t) => (
            <div key={t.trackId} style={{ padding: '4px 0', borderBottom: '0.5px solid #1a1a24' }}>
              <div style={{ fontSize: '11px', color: '#c0c0d8' }}>{t.title}</div>
              {t.differences.map((d) => (
                <div key={d.field} style={{ fontSize: '10px', color: '#666', paddingLeft: '8px' }}>
                  {FIELD_LABELS[d.field] ?? d.field}: <s>{d.inFile || '(empty)'}</s> →{' '}
                  <span style={{ color: '#a09be8' }}>{d.deepcrated}</span>
                </div>
              ))}
            </div>
          ))}
          {plan.tracks.length > LIST_LIMIT && (
            <div style={{ ...muted, paddingTop: '6px' }}>
              …and {(plan.tracks.length - LIST_LIMIT).toLocaleString()} more.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
