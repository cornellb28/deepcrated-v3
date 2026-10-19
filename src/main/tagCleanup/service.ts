// ── Metadata Cleanup: the main-process service ────────────────────────────
// Reads the library, plans with the pure rules in shared/tagCleanup.ts and
// applies through the store. Nothing here touches an audio file: file
// write-back is a separate, explicitly confirmed job (see index.ts), fed by
// fileWrites()/fileRestores().

import { randomUUID } from 'crypto'
import { splitValue } from '../tagFields'
import { tagValueKey } from '../../shared/tagKeys'
import {
  CANDIDATE_DELIMITERS,
  CLEANUP_FIELDS,
  findExactProposals,
  findSpellingGroups,
  findTypos,
  groupChanges,
  isAllowedDelimiter,
  mergeRules,
  planTrackField,
  rulesFromChoices,
  splitOnDelimiters,
  type CleanupChoices,
  type CleanupRules,
  type ExactProposal,
  type PlannedChange,
  type PlanGroup,
  type TypoSuggestion
} from '../../shared/tagCleanup'
import type {
  ApplySummary,
  BatchInfo,
  CleanupTrackRow,
  FileWrite,
  TagCleanupStore,
  UndoSummary
} from './sqliteStore'

const DELIMITER_PATTERNS: Record<string, RegExp> = {
  ' x ': /\s+x\s+/i,
  ' / ': /\s+\/\s+/,
  ' | ': /\s+\|\s+/,
  ';': /;/
}

export interface DelimiterCandidate {
  field: string
  delimiter: string
  tracks: number
  distinct: number
  examples: { value: string; count: number }[]
  allowed: boolean
  confirmed: boolean // a saved rule
  // " | " is the separator DeepCrated already uses: counted for the record,
  // never offered as something to split.
  existing: boolean
}

export interface SpellingChoiceGroup {
  field: string
  key: string
  spellings: { value: string; count: number }[]
  chosen: string | null // the saved canonical spelling, if every variant has one
}

export interface CleanupInventory {
  tracks: number
  delimiters: DelimiterCandidate[]
  spellings: SpellingChoiceGroup[]
  typos: TypoSuggestion[]
  exact: (ExactProposal & { saved: string[] | null })[]
  savedRules: CleanupRules
}

export interface ReviewGroup extends PlanGroup {
  examples: { trackId: number; title: string | null; artist: string | null }[]
}

export interface ApplyRequest {
  choices: CleanupChoices
  // The groups to apply, each with its result as edited on the review screen.
  selections: { groupId: string; result: string[] }[]
  source?: 'library' | 'import'
  dryRun?: boolean
}

export interface FileJobItem {
  filepath: string
  meta: Record<string, string>
  changeIds: number[]
}

// Several fields of one track are one file write.
function byFile(writes: readonly FileWrite[]): FileJobItem[] {
  const out = new Map<string, FileJobItem>()
  for (const w of writes) {
    let item = out.get(w.filepath)
    if (!item) out.set(w.filepath, (item = { filepath: w.filepath, meta: {}, changeIds: [] }))
    item.meta[w.field] = w.value
    item.changeIds.push(w.changeId)
  }
  return [...out.values()]
}

export function createTagCleanup(store: TagCleanupStore, uuid: () => string = randomUUID) {
  function plan(
    rows: readonly CleanupTrackRow[],
    rules: CleanupRules
  ): { changes: PlannedChange[]; groups: ReviewGroup[] } {
    const changes: PlannedChange[] = []
    const info = new Map<number, CleanupTrackRow>()
    for (const row of rows) {
      const c = planTrackField(row.input, rules, splitValue)
      if (!c) continue
      changes.push(c)
      info.set(row.input.trackId, row)
    }
    const groups = groupChanges(changes, (c) => c.prevColumn ?? c.prevTags.join(' | ')).map(
      (g) => ({
        ...g,
        examples: g.trackIds.slice(0, 5).map((id) => ({
          trackId: id,
          title: info.get(id)?.title ?? null,
          artist: info.get(id)?.artist ?? null
        }))
      })
    )
    return { changes, groups }
  }

  function rulesFor(choices: CleanupChoices): CleanupRules {
    return mergeRules(store.loadRules(), rulesFromChoices(choices))
  }

  return {
    scan(): CleanupInventory {
      const rows = store.readTracks()
      const saved = store.loadRules()
      const trackIds = new Set(rows.map((r) => r.input.trackId))

      const delimiters: DelimiterCandidate[] = []
      for (const field of CLEANUP_FIELDS) {
        const columns = new Map<string, number>()
        for (const r of rows) {
          if (r.input.field !== field || r.missing) continue
          const v = r.input.linked.length > 0 ? r.input.linked.join(' | ') : (r.input.column ?? '')
          if (v) columns.set(v, (columns.get(v) ?? 0) + 1)
        }
        for (const d of CANDIDATE_DELIMITERS) {
          const re = DELIMITER_PATTERNS[d]
          const hits = [...columns].filter(([v]) => re.test(v)).sort((a, b) => b[1] - a[1])
          if (hits.length === 0) continue
          delimiters.push({
            field,
            delimiter: d,
            tracks: hits.reduce((a, [, n]) => a + n, 0),
            distinct: hits.length,
            examples: hits.slice(0, 5).map(([value, count]) => ({ value, count })),
            allowed: isAllowedDelimiter(field, d) && d !== ' | ',
            confirmed: (saved.delimiters[field] ?? []).includes(d),
            existing: d === ' | '
          })
        }
      }

      // Every value as it would be after the " x " split, one per track.
      const partsOf = (field: string): string[] =>
        rows
          .filter((r) => r.input.field === field && !r.missing)
          .flatMap((r) =>
            (r.input.linked.length > 0
              ? r.input.linked
              : splitValue(field, r.input.column)
            ).flatMap((v) => splitOnDelimiters(field, v, [' x ']))
          )
      const genre = partsOf('genre')
      const savedGenre = saved.rewrites.genre ?? {}
      const spellings = findSpellingGroups('genre', genre).map((g) => {
        const targets = new Set(
          g.spellings.map((s) => JSON.stringify(savedGenre[tagValueKey(s.value)] ?? null))
        )
        const only = targets.size === 1 ? JSON.parse([...targets][0]) : null
        return { ...g, chosen: Array.isArray(only) && only.length === 1 ? only[0] : null }
      })
      const savedComment = saved.rewrites.comment ?? {}
      const exact = findExactProposals('comment', partsOf('comment')).map((p) => ({
        ...p,
        saved: (savedComment[tagValueKey(p.value)] as string[] | undefined) ?? null
      }))
      return {
        tracks: trackIds.size,
        delimiters,
        spellings,
        typos: findTypos('genre', genre),
        exact,
        savedRules: saved
      }
    },

    plan(choices: CleanupChoices): { groups: ReviewGroup[]; tracks: number } {
      const { changes, groups } = plan(store.readTracks(), rulesFor(choices))
      return { groups, tracks: new Set(changes.map((c) => c.trackId)).size }
    },

    // dryRun applies in a transaction that is rolled back: the real code,
    // the real counts, nothing kept.
    apply(req: ApplyRequest): ApplySummary {
      const rules = rulesFor(req.choices)
      const { changes } = plan(store.readTracks(), rules)
      const wanted = new Map(req.selections.map((s) => [s.groupId, s.result]))
      const chosen: PlannedChange[] = []
      for (const c of changes) {
        const result = wanted.get(c.groupKey)
        if (!result) continue
        const clean: string[] = []
        const seen = new Set<string>()
        for (const v of result) {
          const t = v.replace(/\s+/g, ' ').trim()
          const k = tagValueKey(t)
          if (k === '' || seen.has(k)) continue
          seen.add(k)
          clean.push(t)
        }
        if (clean.length === 0) throw new Error('A group cannot be cleaned to no tags at all')
        chosen.push({ ...c, newTags: clean })
      }
      const isCombined = (field: string, value: string): boolean =>
        splitOnDelimiters(field, value, rules.delimiters[field] ?? []).length > 1
      const summary = store.apply(uuid(), req.source ?? 'library', chosen, isCombined, !!req.dryRun)
      if (!req.dryRun) store.saveRules(rulesFromChoices(req.choices))
      return summary
    },

    batches(): BatchInfo[] {
      return store.listBatches()
    },

    undo(batchId: string, dryRun = false): UndoSummary {
      return store.undo(batchId, dryRun)
    },

    fileWrites(batchId: string, limit?: number): FileJobItem[] {
      const writes = store.pendingFileWrites(batchId)
      const items = byFile(writes)
      return limit ? items.slice(0, limit) : items
    },

    fileRestores(batchId: string): FileJobItem[] {
      return byFile(store.pendingFileRestores(batchId))
    },

    markFileWritten(changeIds: readonly number[]): void {
      for (const id of changeIds) store.markFileWritten(id)
    },
    markFileRestored(changeIds: readonly number[]): void {
      for (const id of changeIds) store.markFileRestored(id)
    },
    setFilesStatus(batchId: string, status: string): void {
      store.setFilesStatus(batchId, status)
    },

    // After an import: how many of the new tracks the saved rules would
    // change. Nothing is applied; the DJ is asked.
    importMatches(trackIds: readonly number[]): number {
      if (trackIds.length === 0) return 0
      const rules = store.loadRules()
      if (Object.keys(rules.delimiters).length === 0 && Object.keys(rules.rewrites).length === 0) {
        return 0
      }
      const { changes } = plan(store.readTracks(trackIds), rules)
      return new Set(changes.map((c) => c.trackId)).size
    }
  }
}

export type TagCleanup = ReturnType<typeof createTagCleanup>
