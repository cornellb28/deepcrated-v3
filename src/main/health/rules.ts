// ── Rules engine: serializable rule → parameterized SQL ──────────────────
// A rule is plain JSON: a group that combines leaves with all/any, nestable
// one level (a group may contain leaves and one more level of groups, and
// those inner groups contain leaves only). It compiles to a WHERE-clause
// fragment plus an ordered parameter list for better-sqlite3.
//
// Pure on purpose — no Electron, no db.ts, no better-sqlite3 import — so it
// is unit-testable and so Crate Health, smart crates and import triage can
// all call the same compiler. db.ts opens the real library as an import side
// effect; nothing here may pull it in.
//
// The safety property: user-supplied VALUES only ever travel as `?` params.
// The only strings spliced into SQL are the column expressions and the table
// alias, and both come from the registry below (or are validated against a
// strict identifier pattern), never from a rule.
//
// Adding a field (say play count, later) is one FIELDS entry.

export type Combinator = 'all' | 'any'

export type Operator =
  'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains' | 'in' | 'is_empty' | 'is_not_empty'

export type RuleValue = string | number | boolean
export type RuleValues = RuleValue | RuleValue[]

export interface RuleLeaf {
  field: string
  op: Operator
  value?: RuleValues
}

export interface RuleGroup {
  combine: Combinator
  rules: (RuleLeaf | RuleGroup)[]
}

export class RuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuleError'
  }
}

export interface CompiledRule {
  // A boolean SQL expression, safe to splice after WHERE / AND.
  sql: string
  params: (string | number)[]
}

// ── Field registry ───────────────────────────────────────────────────────

type FieldKind = 'text' | 'number' | 'flag' | 'tag'

interface FieldDef {
  kind: FieldKind
  // text / number / flag: the column, as a function of the table alias.
  column?: (alias: string) => string
  // number: treat 0 as "empty" too (bpm 0 is a failed analysis, not a tempo).
  zeroIsEmpty?: boolean
  // tag: which tags.field this field reads. null = any tag at all.
  tagField?: string | null
}

const TEXT_OPS: readonly Operator[] = ['eq', 'neq', 'contains', 'in', 'is_empty', 'is_not_empty']
const NUMBER_OPS: readonly Operator[] = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'is_empty',
  'is_not_empty'
]
const FLAG_OPS: readonly Operator[] = ['eq', 'neq']
// For a tag field: is_empty = the track has no tag of that field,
// eq/in = it has a tag with that value.
const TAG_OPS: readonly Operator[] = ['eq', 'in', 'is_empty', 'is_not_empty']

const OPS_BY_KIND: Record<FieldKind, readonly Operator[]> = {
  text: TEXT_OPS,
  number: NUMBER_OPS,
  flag: FLAG_OPS,
  tag: TAG_OPS
}

function col(name: string): (alias: string) => string {
  return (alias) => `${alias}.${name}`
}

function tagFieldDef(tagField: string | null): FieldDef {
  return { kind: 'tag', tagField }
}

// Keys are the names a rule may use. Anything not listed is rejected.
export const FIELDS: Readonly<Record<string, FieldDef>> = {
  title: { kind: 'text', column: col('title') },
  artist: { kind: 'text', column: col('artist') },
  album: { kind: 'text', column: col('album') },
  genre: { kind: 'text', column: col('genre') },
  key_camelot: { kind: 'text', column: col('key_camelot') },
  artwork_hash: { kind: 'text', column: col('artwork_hash') },
  analyzed_at: { kind: 'text', column: col('analyzed_at') },
  analysis_error: { kind: 'text', column: col('analysis_error') },
  bpm: { kind: 'number', column: col('bpm'), zeroIsEmpty: true },
  energy: { kind: 'number', column: col('energy') },
  duration_sec: { kind: 'number', column: col('duration_sec') },
  board_id: { kind: 'number', column: col('board_id') },
  missing: { kind: 'flag', column: col('missing') },

  // Tag lookups. `tag.any` with is_empty is "untagged".
  'tag.any': tagFieldDef(null),
  'tag.genre': tagFieldDef('genre'),
  'tag.artist': tagFieldDef('artist'),
  'tag.label': tagFieldDef('label'),
  'tag.remixer': tagFieldDef('remixer'),
  'tag.composer': tagFieldDef('composer'),
  'tag.grouping': tagFieldDef('grouping'),
  'tag.comment': tagFieldDef('comment'),
  'tag.vibe': tagFieldDef('vibe'),
  'tag.venue': tagFieldDef('venue'),
  'tag.custom': tagFieldDef('custom')
  // TODO(health): play_count / last_played once a plays-backed field is wanted
  // by smart crates — one entry here, backed by a subquery on `plays`.
}

export function isKnownField(field: string): boolean {
  return Object.prototype.hasOwnProperty.call(FIELDS, field)
}

// ── Compiler ─────────────────────────────────────────────────────────────

const ALIAS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_IN_VALUES = 500
const MAX_RULES_PER_GROUP = 100

export function isGroup(rule: RuleLeaf | RuleGroup): rule is RuleGroup {
  return typeof rule === 'object' && rule !== null && 'combine' in rule
}

function assertScalar(value: unknown, what: string): asserts value is RuleValue {
  if (typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  throw new RuleError(`${what} needs a string, number or boolean value`)
}

// better-sqlite3 binds numbers and strings, not booleans.
function bindable(value: RuleValue): string | number {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function compileLeaf(leaf: RuleLeaf, alias: string, params: (string | number)[]): string {
  if (typeof leaf !== 'object' || leaf === null || typeof leaf.field !== 'string') {
    throw new RuleError('A rule needs a field')
  }
  if (!isKnownField(leaf.field)) throw new RuleError(`Unknown field "${leaf.field}"`)
  const def = FIELDS[leaf.field]
  if (!OPS_BY_KIND[def.kind].includes(leaf.op)) {
    throw new RuleError(`Operator "${String(leaf.op)}" is not valid for field "${leaf.field}"`)
  }

  if (def.kind === 'tag') return compileTagLeaf(leaf, def, alias, params)

  const column = (def.column as (a: string) => string)(alias)

  switch (leaf.op) {
    case 'is_empty':
    case 'is_not_empty': {
      const empty =
        def.kind === 'text'
          ? `(${column} IS NULL OR TRIM(${column}) = '')`
          : def.zeroIsEmpty
            ? `(${column} IS NULL OR ${column} = 0)`
            : `${column} IS NULL`
      return leaf.op === 'is_empty' ? empty : `NOT ${empty}`
    }
    case 'in': {
      if (!Array.isArray(leaf.value) || leaf.value.length === 0) {
        throw new RuleError('"in" needs a non-empty list of values')
      }
      if (leaf.value.length > MAX_IN_VALUES) throw new RuleError('"in" list is too long')
      for (const v of leaf.value) assertScalar(v, '"in"')
      for (const v of leaf.value) params.push(bindable(v))
      return `${column} IN (${leaf.value.map(() => '?').join(', ')})`
    }
    case 'contains': {
      assertScalar(leaf.value, '"contains"')
      params.push(`%${escapeLike(String(leaf.value))}%`)
      return `${column} LIKE ? ESCAPE '\\'`
    }
    default: {
      assertScalar(leaf.value, `"${leaf.op}"`)
      params.push(bindable(leaf.value))
      const sqlOp = { eq: '=', neq: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' }[leaf.op]
      // neq must keep NULL rows: `NULL <> 'x'` is NULL, which would silently
      // drop every track that has no value at all.
      return leaf.op === 'neq'
        ? `(${column} IS NULL OR ${column} ${sqlOp} ?)`
        : `${column} ${sqlOp} ?`
    }
  }
}

function compileTagLeaf(
  leaf: RuleLeaf,
  def: FieldDef,
  alias: string,
  params: (string | number)[]
): string {
  const parts: string[] = [`tt.track_id = ${alias}.id`]
  if (def.tagField !== null && def.tagField !== undefined) {
    parts.push('g.field = ?')
    params.push(def.tagField)
  }
  if (leaf.op === 'eq' || leaf.op === 'in') {
    const values = leaf.op === 'eq' ? [leaf.value] : leaf.value
    if (!Array.isArray(values) || values.length === 0) {
      throw new RuleError(`"${leaf.op}" needs a value`)
    }
    if (values.length > MAX_IN_VALUES) throw new RuleError('"in" list is too long')
    for (const v of values) {
      if (typeof v !== 'string') throw new RuleError('Tag values must be strings')
      params.push(v)
    }
    parts.push(`g.value IN (${values.map(() => '?').join(', ')})`)
  }
  const exists = `EXISTS (SELECT 1 FROM track_tags tt JOIN tags g ON g.id = tt.tag_id WHERE ${parts.join(' AND ')})`
  return leaf.op === 'is_empty' ? `NOT ${exists}` : exists
}

function compileGroup(
  group: RuleGroup,
  alias: string,
  params: (string | number)[],
  depth: number
): string {
  if (typeof group !== 'object' || group === null || !Array.isArray(group.rules)) {
    throw new RuleError('A rule group needs a rules list')
  }
  if (group.combine !== 'all' && group.combine !== 'any') {
    throw new RuleError('A rule group must combine with "all" or "any"')
  }
  if (group.rules.length > MAX_RULES_PER_GROUP) throw new RuleError('Too many rules in a group')
  // The identity of each combinator: all-of-nothing matches everything,
  // any-of-nothing matches nothing. Without this an empty set would
  // compile to `()`, which is a syntax error.
  if (group.rules.length === 0) return group.combine === 'all' ? '1 = 1' : '0 = 1'

  const joiner = group.combine === 'all' ? ' AND ' : ' OR '
  const parts = group.rules.map((rule) => {
    if (isGroup(rule)) {
      // One level of nesting: a nested group may not contain groups.
      if (depth >= 1) throw new RuleError('Rule groups can only nest one level deep')
      return compileGroup(rule, alias, params, depth + 1)
    }
    return compileLeaf(rule, alias, params)
  })
  return `(${parts.join(joiner)})`
}

// Compile a rule (a group, or a single leaf) against a tracks table
// reachable as `alias`. Throws RuleError on anything malformed.
export function compileRule(rule: RuleGroup | RuleLeaf, alias = 't'): CompiledRule {
  if (!ALIAS_PATTERN.test(alias)) throw new RuleError('Invalid table alias')
  const params: (string | number)[] = []
  const sql = isGroup(rule)
    ? compileGroup(rule, alias, params, 0)
    : compileLeaf(rule, alias, params)
  return { sql, params }
}
