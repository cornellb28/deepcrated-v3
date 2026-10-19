// ── Metadata Cleanup: split combined tag values ───────────────────────────
// Three steps over main/tagCleanup/:
//   Rules    confirm delimiters per field, pick one spelling per tag, tick
//            typo fixes and comment-badge splits
//   Review   every change grouped by pattern, results editable, approve all
//            or some; a dry run shows the counts first
//   Done     what changed, then (separately, explicitly) the file write:
//            three files first, checked in Serato, then the rest
// Nothing reaches the database before Apply, or a file before its own
// confirmation. Each applied batch can be undone from Settings › Library.

import React, { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import type {
  ApplySummary,
  CleanupChoices,
  CleanupInventory,
  ReviewGroup
} from '../../../shared/tagCleanup'
import { useTagCleanupStore } from '../store/useTagCleanupStore'
import { refreshArtists as refreshLibrary } from '../lib/refreshArtists'
import { CleanupFiles } from './CleanupFiles'

const muted: React.CSSProperties = { fontSize: '11px', color: '#555', lineHeight: 1.6 }
const heading: React.CSSProperties = {
  fontSize: '10px',
  fontWeight: 500,
  letterSpacing: '0.8px',
  textTransform: 'uppercase',
  color: '#666',
  margin: '18px 0 8px'
}
const row: React.CSSProperties = {
  background: '#1a1a26',
  border: '0.5px solid #252535',
  borderRadius: '6px',
  padding: '8px 10px'
}

const FIELD_LABEL: Record<string, string> = {
  genre: 'Genre',
  grouping: 'Grouping',
  comment: 'Comment',
  remixer: 'Remixer',
  label: 'Label'
}

function showDelimiter(d: string): string {
  return d === ';' ? '";"' : `"${d.trim()}"`
}

// ── Editable list of tags ─────────────────────────────────────────────────

function ChipEditor({
  values,
  onChange,
  testId
}: {
  values: string[]
  onChange: (next: string[]) => void
  testId?: string
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  function add(): void {
    const v = draft.replace(/\s+/g, ' ').trim()
    if (v && !values.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...values, v])
    setDraft('')
  }
  return (
    <div
      data-testid={testId}
      style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}
    >
      {values.map((v, i) => (
        <span
          key={`${v}-${i}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '11px',
            color: '#c0c0d8',
            background: '#7f77dd22',
            border: '0.5px solid #7f77dd55',
            borderRadius: '4px',
            padding: '1px 4px 1px 6px'
          }}
        >
          {v}
          <button
            type="button"
            aria-label={`Remove ${v}`}
            onClick={() => onChange(values.filter((_, j) => j !== i))}
            style={{
              background: 'none',
              border: 'none',
              color: '#777',
              cursor: 'pointer',
              padding: 0,
              fontSize: '11px',
              lineHeight: 1
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        placeholder="add"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          }
        }}
        onBlur={add}
        style={{
          width: '70px',
          fontSize: '11px',
          background: 'transparent',
          border: 'none',
          borderBottom: '0.5px solid #333',
          color: '#c0c0d8',
          outline: 'none'
        }}
      />
    </div>
  )
}

// ── Step 1: rules ─────────────────────────────────────────────────────────

interface Draft {
  delimiters: Set<string> // "field\u0001delimiter"
  spellings: Map<string, string | null> // spelling group key → chosen (null: leave as is)
  typos: Set<string> // "field\u0001from"
  exact: Map<string, { on: boolean; result: string[] }> // value → choice
}

function draftFrom(inv: CleanupInventory): Draft {
  return {
    delimiters: new Set(
      inv.delimiters.filter((d) => d.confirmed).map((d) => `${d.field}\u0001${d.delimiter}`)
    ),
    spellings: new Map(inv.spellings.map((g) => [g.key, g.chosen])),
    typos: new Set(),
    exact: new Map(
      inv.exact.map((p) => [
        p.value,
        { on: p.saved !== null || p.preselected, result: p.saved ?? p.result }
      ])
    )
  }
}

function choicesFrom(inv: CleanupInventory, d: Draft): CleanupChoices {
  return {
    delimiters: [...d.delimiters].map((k) => {
      const [field, delimiter] = k.split('\u0001')
      return { field, delimiter }
    }),
    spellings: inv.spellings
      .filter((g) => d.spellings.get(g.key))
      .map((g) => ({
        field: g.field,
        canonical: d.spellings.get(g.key)!,
        variants: g.spellings.map((s) => s.value)
      })),
    typos: inv.typos
      .filter((t) => d.typos.has(`${t.field}\u0001${t.from}`))
      .map((t) => ({ field: t.field, from: t.from, to: t.to })),
    exact: inv.exact
      .filter((p) => d.exact.get(p.value)?.on && (d.exact.get(p.value)?.result.length ?? 0) > 0)
      .map((p) => ({ field: p.field, value: p.value, result: d.exact.get(p.value)!.result }))
  }
}

function RulesStep({
  inv,
  draft,
  setDraft
}: {
  inv: CleanupInventory
  draft: Draft
  setDraft: (d: Draft) => void
}): React.JSX.Element {
  const update = (fn: (d: Draft) => void): void => {
    const next: Draft = {
      delimiters: new Set(draft.delimiters),
      spellings: new Map(draft.spellings),
      typos: new Set(draft.typos),
      exact: new Map(draft.exact)
    }
    fn(next)
    setDraft(next)
  }
  const splittable = inv.delimiters.filter((d) => d.allowed)
  const existing = inv.delimiters.filter((d) => d.existing)

  return (
    <div>
      <div style={heading}>Delimiters</div>
      <div style={muted}>
        Tick a delimiter to split values on it in that field. Commas and &quot;&amp;&quot; are never
        split, and &quot;x&quot; never on artist or label.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
        {splittable.length === 0 && <div style={muted}>No combined values found.</div>}
        {splittable.map((d) => {
          const key = `${d.field}\u0001${d.delimiter}`
          return (
            <label key={key} style={{ ...row, display: 'flex', gap: '10px', cursor: 'pointer' }}>
              <Checkbox
                data-testid={`cleanup-delimiter-${d.field}`}
                checked={draft.delimiters.has(key)}
                onCheckedChange={(v) =>
                  update((n) => (v === true ? n.delimiters.add(key) : n.delimiters.delete(key)))
                }
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '12px', color: '#c0c0d8' }}>
                  {FIELD_LABEL[d.field] ?? d.field}: split on {showDelimiter(d.delimiter)} ·{' '}
                  {d.tracks} tracks, {d.distinct} values
                </div>
                <div style={{ ...muted, marginTop: '2px' }}>
                  {d.examples.map((e) => `${e.value} ×${e.count}`).join(' · ')}
                </div>
              </div>
            </label>
          )
        })}
        {existing.length > 0 && (
          <div style={{ ...muted, marginTop: '2px' }}>
            Already separate (&quot;|&quot; is how DeepCrated joins values):{' '}
            {existing.map((d) => `${FIELD_LABEL[d.field] ?? d.field} ${d.tracks}`).join(', ')}.
          </div>
        )}
      </div>

      {inv.spellings.length > 0 && (
        <>
          <div style={heading}>Spelling</div>
          <div style={muted}>
            One spelling per tag, saved as a rule for future imports. Applies to every genre value,
            combined or not.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
            {inv.spellings.map((g) => {
              const chosen = draft.spellings.get(g.key) ?? null
              return (
                <div
                  key={g.key}
                  data-testid="cleanup-spelling"
                  style={{ ...row, display: 'flex', flexWrap: 'wrap', gap: '4px' }}
                >
                  {g.spellings.map((s) => (
                    <SpellingChip
                      key={s.value}
                      active={chosen === s.value}
                      onClick={() => update((n) => n.spellings.set(g.key, s.value))}
                    >
                      {s.value} <span style={{ color: '#555' }}>×{s.count}</span>
                    </SpellingChip>
                  ))}
                  <SpellingChip
                    active={chosen === null}
                    onClick={() => update((n) => n.spellings.set(g.key, null))}
                  >
                    Leave as is
                  </SpellingChip>
                </div>
              )
            })}
          </div>
        </>
      )}

      {inv.typos.length > 0 && (
        <>
          <div style={heading}>Possible typos</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {inv.typos.map((t) => {
              const key = `${t.field}\u0001${t.from}`
              return (
                <label
                  key={key}
                  style={{ ...row, display: 'flex', gap: '10px', cursor: 'pointer' }}
                >
                  <Checkbox
                    checked={draft.typos.has(key)}
                    onCheckedChange={(v) =>
                      update((n) => (v === true ? n.typos.add(key) : n.typos.delete(key)))
                    }
                  />
                  <span style={{ fontSize: '12px', color: '#c0c0d8' }}>
                    {t.from} <span style={{ color: '#555' }}>×{t.fromCount}</span> → {t.to}{' '}
                    <span style={{ color: '#555' }}>×{t.toCount}</span>
                  </span>
                </label>
              )
            })}
          </div>
        </>
      )}

      {inv.exact.length > 0 && (
        <>
          <div style={heading}>Comment badges joined by spaces</div>
          <div style={muted}>
            Split into separate badges. Ticked when every word is a badge you already use on its
            own; edit any of them.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
            {inv.exact.map((p) => {
              const c = draft.exact.get(p.value) ?? { on: false, result: p.result }
              return (
                <div
                  key={p.value}
                  data-testid="cleanup-exact"
                  style={{ ...row, display: 'flex', gap: '10px', alignItems: 'flex-start' }}
                >
                  <Checkbox
                    checked={c.on}
                    onCheckedChange={(v) =>
                      update((n) => n.exact.set(p.value, { ...c, on: v === true }))
                    }
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: '12px', color: '#c0c0d8', marginBottom: '4px' }}>
                      {p.value} <span style={{ color: '#555' }}>×{p.count}</span> →
                    </div>
                    <ChipEditor
                      values={c.result}
                      onChange={(result) => update((n) => n.exact.set(p.value, { ...c, result }))}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function SpellingChip({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        fontSize: '11px',
        padding: '2px 8px',
        borderRadius: '4px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        border: `0.5px solid ${active ? '#7f77dd' : '#252535'}`,
        background: active ? '#7f77dd33' : 'transparent',
        color: active ? '#e0e0f0' : '#888'
      }}
    >
      {children}
    </button>
  )
}

// ── Step 2: review ────────────────────────────────────────────────────────

const KIND_TITLE: Record<ReviewGroup['kind'], string> = {
  split: 'Combined values',
  exact: 'Comment badges',
  spelling: 'Spelling only (values that were never combined)'
}

function ReviewStep({
  groups,
  selected,
  setSelected,
  results,
  setResults
}: {
  groups: ReviewGroup[]
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  results: Map<string, string[]>
  setResults: (r: Map<string, string[]>) => void
}): React.JSX.Element {
  const kinds = (['split', 'exact', 'spelling'] as const).filter((k) =>
    groups.some((g) => g.kind === k)
  )
  if (groups.length === 0) {
    return <div style={{ ...muted, padding: '16px 0' }}>Nothing to change with these rules.</div>
  }
  return (
    <div>
      {kinds.map((kind) => {
        const list = groups.filter((g) => g.kind === kind)
        const allOn = list.every((g) => selected.has(g.id))
        return (
          <div key={kind}>
            <div style={{ ...heading, display: 'flex', justifyContent: 'space-between' }}>
              <span>
                {KIND_TITLE[kind]} · {list.reduce((a, g) => a + g.trackIds.length, 0)} tracks
              </span>
              <button
                type="button"
                onClick={() => {
                  const next = new Set(selected)
                  for (const g of list) {
                    if (allOn) next.delete(g.id)
                    else next.add(g.id)
                  }
                  setSelected(next)
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#7f77dd',
                  cursor: 'pointer',
                  fontSize: '10px',
                  textTransform: 'none',
                  letterSpacing: 0
                }}
              >
                {allOn ? 'Select none' : 'Select all'}
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {list.map((g) => (
                <div
                  key={g.id}
                  data-testid="cleanup-group"
                  style={{ ...row, display: 'flex', gap: '10px', alignItems: 'flex-start' }}
                >
                  <Checkbox
                    checked={selected.has(g.id)}
                    onCheckedChange={(v) => {
                      const next = new Set(selected)
                      if (v === true) next.add(g.id)
                      else next.delete(g.id)
                      setSelected(next)
                    }}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{ fontSize: '12px', color: '#c0c0d8', marginBottom: '4px' }}
                      title={g.examples
                        .map((e) => `${e.title ?? 'Untitled'}${e.artist ? ` — ${e.artist}` : ''}`)
                        .join('\n')}
                    >
                      {FIELD_LABEL[g.field] ?? g.field}: {g.label}{' '}
                      <span style={{ color: '#555' }}>
                        · {g.trackIds.length} track{g.trackIds.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <ChipEditor
                      values={results.get(g.id) ?? g.result}
                      onChange={(r) => setResults(new Map(results).set(g.id, r))}
                    />
                    {g.rare.length > 0 && (
                      <div data-testid="cleanup-rare" style={{ ...muted, marginTop: '6px' }}>
                        <span style={{ color: '#ba7517' }}>
                          {g.rare
                            .map(
                              (r) =>
                                `“${r.value}” would be on ${r.tracks} track${r.tracks === 1 ? '' : 's'}`
                            )
                            .join(', ')}
                        </span>
                        . Left as it is unless you tick it. Tracks:
                        <ul style={{ margin: '2px 0 0', paddingLeft: '18px' }}>
                          {g.examples.map((e) => (
                            <li key={e.trackId}>
                              {e.title ?? 'Untitled'}
                              {e.artist ? ` — ${e.artist}` : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function SummaryLine({ s }: { s: ApplySummary }): React.JSX.Element {
  const fields = Object.entries(s.byField)
    .map(([f, n]) => `${FIELD_LABEL[f] ?? f} ${n}`)
    .join(', ')
  return (
    <div
      data-testid="cleanup-summary"
      style={{ fontSize: '12px', color: '#c0c0d8', lineHeight: 1.7 }}
    >
      {s.dryRun ? 'Dry run: would change' : 'Changed'} {s.tracks} tracks ({fields}).{' '}
      {s.tagsCreated.length} new tag{s.tagsCreated.length === 1 ? '' : 's'}, {s.tagsDeleted.length}{' '}
      unused tag{s.tagsDeleted.length === 1 ? '' : 's'} removed
      {s.tagsDeleted.length > 0
        ? ` (${s.tagsDeleted.map((t) => t.split(':').slice(1).join(':')).join(', ')})`
        : ''}
      . {s.files} file{s.files === 1 ? '' : 's'} {s.dryRun ? 'could later be' : 'can now be'}{' '}
      written.
    </div>
  )
}

// ── The dialog ────────────────────────────────────────────────────────────

type Step = 'rules' | 'review' | 'done'

export function MetadataCleanupDialog(): React.JSX.Element {
  const open = useTagCleanupStore((s) => s.open)
  const hide = useTagCleanupStore((s) => s.hide)
  return (
    <Dialog open={open} onOpenChange={(o) => !o && hide()}>
      <DialogContent
        data-testid="metadata-cleanup"
        style={{
          background: '#13131b',
          border: '0.5px solid #1e1e2a',
          borderRadius: '12px',
          maxWidth: '680px',
          width: '100%',
          color: '#e8e8f0',
          padding: '20px'
        }}
      >
        {/* Remounts on every open, so each one starts from a fresh scan. */}
        {open && <CleanupBody />}
      </DialogContent>
    </Dialog>
  )
}

function CleanupBody(): React.JSX.Element {
  const source = useTagCleanupStore((s) => s.source)
  const hide = useTagCleanupStore((s) => s.hide)
  const changed = useTagCleanupStore((s) => s.changed)
  const [step, setStep] = useState<Step>('rules')
  const [inv, setInv] = useState<CleanupInventory | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [groups, setGroups] = useState<ReviewGroup[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [results, setResults] = useState<Map<string, string[]>>(new Map())
  const [preview, setPreview] = useState<ApplySummary | null>(null)
  const [applied, setApplied] = useState<ApplySummary | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api.tagCleanup.scan().then((r) => {
      if (cancelled) return
      if (!r.ok) {
        toast.error('Could not read your tags', { description: r.error })
        return
      }
      setInv(r.result)
      setDraft(draftFrom(r.result))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const choices = useMemo(() => (inv && draft ? choicesFrom(inv, draft) : null), [inv, draft])
  const request = (dryRun: boolean): Parameters<typeof window.api.tagCleanup.apply>[0] => ({
    choices: choices!,
    selections: groups
      .filter((g) => selected.has(g.id))
      .map((g) => ({ groupId: g.id, result: results.get(g.id) ?? g.result })),
    source,
    dryRun
  })
  // A track can be in two groups (its genre and its comment): count it once.
  const selectedTracks = new Set(
    groups.filter((g) => selected.has(g.id)).flatMap((g) => g.trackIds)
  ).size

  async function toReview(): Promise<void> {
    if (!choices) return
    setBusy(true)
    const r = await window.api.tagCleanup.plan(choices)
    setBusy(false)
    if (!r.ok) {
      toast.error('Could not build the preview', { description: r.error })
      return
    }
    setGroups(r.result.groups)
    // Groups with a one-off value start unticked: kept as they are unless
    // the DJ ticks them.
    setSelected(new Set(r.result.groups.filter((g) => g.rare.length === 0).map((g) => g.id)))
    setResults(new Map())
    setPreview(null)
    setStep('review')
  }

  async function dryRun(): Promise<void> {
    setBusy(true)
    const r = await window.api.tagCleanup.apply(request(true))
    setBusy(false)
    if (!r.ok) toast.error('Dry run failed', { description: r.error })
    else setPreview(r.result)
  }

  async function apply(): Promise<void> {
    setBusy(true)
    const r = await window.api.tagCleanup.apply(request(false))
    setBusy(false)
    if (!r.ok) {
      toast.error('Could not apply the cleanup', { description: r.error })
      return
    }
    setApplied(r.result)
    setStep('done')
    changed()
    await refreshLibrary()
  }

  return (
    <>
      <div
        style={{
          fontSize: '10px',
          color: '#555',
          letterSpacing: '0.8px',
          textTransform: 'uppercase'
        }}
      >
        Metadata cleanup ·{' '}
        {step === 'rules'
          ? '1 of 3 · Rules'
          : step === 'review'
            ? '2 of 3 · Review'
            : '3 of 3 · Files'}
      </div>
      <DialogTitle style={{ fontSize: '16px', fontWeight: 500, margin: '6px 0 4px' }}>
        {step === 'rules'
          ? 'Split combined tags'
          : step === 'review'
            ? 'Check every change'
            : 'Cleanup applied'}
      </DialogTitle>
      <DialogDescription style={muted}>
        {step === 'rules'
          ? 'Values like "Hip Hop x R&B" become separate tags. Nothing changes until you approve it on the next step.'
          : step === 'review'
            ? 'Untick anything to skip it, and edit any result. Only DeepCrated’s library changes here; your files are a separate step.'
            : 'Your library is updated. Your audio files are not, yet.'}
      </DialogDescription>

      <div style={{ maxHeight: '440px', overflowY: 'auto', marginTop: '6px', paddingRight: '4px' }}>
        {step === 'rules' &&
          (inv && draft ? (
            <RulesStep inv={inv} draft={draft} setDraft={setDraft} />
          ) : (
            <div style={{ ...muted, padding: '16px 0' }}>Reading your tags…</div>
          ))}
        {step === 'review' && (
          <ReviewStep
            groups={groups}
            selected={selected}
            setSelected={(s) => {
              setSelected(s)
              setPreview(null)
            }}
            results={results}
            setResults={(r) => {
              setResults(r)
              setPreview(null)
            }}
          />
        )}
        {step === 'done' && applied && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '10px' }}>
            <SummaryLine s={applied} />
            <CleanupFiles batchId={applied.batchId} />
            <div style={muted}>Undo this cleanup any time from Settings › Library.</div>
          </div>
        )}
      </div>

      {step === 'review' && preview && (
        <div style={{ ...row, marginTop: '10px' }}>
          <SummaryLine s={preview} />
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '16px' }}>
        <div>
          {step === 'review' && (
            <Button variant="ghost" size="sm" onClick={() => setStep('rules')} disabled={busy}>
              Back
            </Button>
          )}
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {step !== 'done' && (
            <Button variant="ghost" size="sm" onClick={hide}>
              Skip for now
            </Button>
          )}
          {step === 'rules' && (
            <Button
              size="sm"
              data-testid="cleanup-next"
              disabled={!choices || busy}
              onClick={() => void toReview()}
            >
              Preview changes
            </Button>
          )}
          {step === 'review' && (
            <>
              <Button
                variant="outline"
                size="sm"
                data-testid="cleanup-dry-run"
                disabled={busy || selected.size === 0}
                onClick={() => void dryRun()}
              >
                Dry run
              </Button>
              <Button
                size="sm"
                data-testid="cleanup-apply"
                disabled={busy || selected.size === 0}
                onClick={() => void apply()}
              >
                Apply {selected.size === groups.length ? 'all' : `${selected.size} selected`} (
                {selectedTracks} tracks)
              </Button>
            </>
          )}
          {step === 'done' && (
            <Button size="sm" onClick={hide}>
              Close
            </Button>
          )}
        </div>
      </div>
    </>
  )
}
