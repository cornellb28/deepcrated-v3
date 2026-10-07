import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { compileRule, RuleError, type RuleGroup, type RuleLeaf } from '../../src/main/health/rules'

// The compiler is pure, but the point of it is the SQL it emits — so each
// case is run against a real in-memory SQLite and asserted on the rows that
// come back, not on the shape of a string.

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE tracks (
      id INTEGER PRIMARY KEY, title TEXT, artist TEXT, album TEXT, genre TEXT,
      key_camelot TEXT, artwork_hash TEXT, analyzed_at TEXT, bpm REAL, energy INTEGER,
      duration_sec REAL, board_id INTEGER, missing INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tags (id INTEGER PRIMARY KEY, field TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(field, value));
    CREATE TABLE track_tags (track_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (track_id, tag_id));
  `)
  const insert = db.prepare(
    `INSERT INTO tracks (id, title, artist, genre, bpm, key_camelot, energy, board_id, missing)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  insert.run(1, 'Alpha', 'Foxy Brown', 'Hip Hop', 90, '8A', 3, 1, 0)
  insert.run(2, 'Beta', 'Dru Hill', 'R&B', 100, '9A', 5, 1, 0)
  insert.run(3, '100% Pure_Gold', '', null, 0, null, null, 2, 0)
  insert.run(4, 'Delta', '   ', '', null, '', null, 2, 1)
  db.prepare(`INSERT INTO tags (id, field, value) VALUES (?, ?, ?)`).run(1, 'genre', 'Hip Hop')
  db.prepare(`INSERT INTO tags (id, field, value) VALUES (?, ?, ?)`).run(2, 'genre', 'R&B')
  db.prepare(`INSERT INTO tags (id, field, value) VALUES (?, ?, ?)`).run(3, 'vibe', 'DARK')
  db.prepare(`INSERT INTO track_tags VALUES (?, ?)`).run(1, 1)
  db.prepare(`INSERT INTO track_tags VALUES (?, ?)`).run(1, 3)
  db.prepare(`INSERT INTO track_tags VALUES (?, ?)`).run(2, 2)
  return db
}

function ids(db: Database.Database, rule: RuleGroup | RuleLeaf): number[] {
  const { sql, params } = compileRule(rule, 't')
  return (
    db.prepare(`SELECT t.id FROM tracks t WHERE ${sql} ORDER BY t.id`).all(...params) as {
      id: number
    }[]
  ).map((r) => r.id)
}

const leaf = (field: string, op: RuleLeaf['op'], value?: RuleLeaf['value']): RuleLeaf => ({
  field,
  op,
  value
})

// ── Operators ───────────────────────────────────────────────────────────

test('eq and neq (neq keeps rows with no value)', () => {
  const db = makeDb()
  expect(ids(db, leaf('artist', 'eq', 'Dru Hill'))).toEqual([2])
  // Track 3 has '' and 4 has spaces; neq must not drop them, and must
  // not silently drop NULLs either (genre of track 3 is NULL).
  expect(ids(db, leaf('genre', 'neq', 'Hip Hop'))).toEqual([2, 3, 4])
})

test('lt, lte, gt, gte on a number', () => {
  const db = makeDb()
  expect(ids(db, leaf('bpm', 'lt', 100))).toEqual([1, 3])
  expect(ids(db, leaf('bpm', 'lte', 100))).toEqual([1, 2, 3])
  expect(ids(db, leaf('bpm', 'gt', 90))).toEqual([2])
  expect(ids(db, leaf('bpm', 'gte', 90))).toEqual([1, 2])
})

test('contains matches a substring and treats % and _ literally', () => {
  const db = makeDb()
  expect(ids(db, leaf('artist', 'contains', 'oxy'))).toEqual([1])
  expect(ids(db, leaf('title', 'contains', '100%'))).toEqual([3])
  expect(ids(db, leaf('title', 'contains', 'e_G'))).toEqual([3])
  // A bare % must match a literal percent sign, not everything.
  expect(ids(db, leaf('title', 'contains', '%'))).toEqual([3])
  expect(ids(db, leaf('title', 'contains', '_'))).toEqual([3])
})

test('in matches any listed value', () => {
  const db = makeDb()
  expect(ids(db, leaf('artist', 'in', ['Foxy Brown', 'Dru Hill']))).toEqual([1, 2])
  expect(ids(db, leaf('board_id', 'in', [2]))).toEqual([3, 4])
})

test('is_empty / is_not_empty: text treats NULL, empty and blank alike', () => {
  const db = makeDb()
  expect(ids(db, leaf('artist', 'is_empty'))).toEqual([3, 4])
  expect(ids(db, leaf('artist', 'is_not_empty'))).toEqual([1, 2])
  expect(ids(db, leaf('key_camelot', 'is_empty'))).toEqual([3, 4])
})

test('is_empty on bpm counts a stored 0 as empty', () => {
  const db = makeDb()
  expect(ids(db, leaf('bpm', 'is_empty'))).toEqual([3, 4])
  // energy has no zero-is-empty rule.
  expect(ids(db, leaf('energy', 'is_empty'))).toEqual([3, 4])
})

test('flag field supports eq and neq', () => {
  const db = makeDb()
  expect(ids(db, leaf('missing', 'eq', 1))).toEqual([4])
  expect(ids(db, leaf('missing', 'eq', true))).toEqual([4])
  expect(ids(db, leaf('missing', 'neq', 1))).toEqual([1, 2, 3])
})

test('tag fields: is_empty, is_not_empty, eq, in', () => {
  const db = makeDb()
  expect(ids(db, leaf('tag.any', 'is_empty'))).toEqual([3, 4])
  expect(ids(db, leaf('tag.any', 'is_not_empty'))).toEqual([1, 2])
  expect(ids(db, leaf('tag.genre', 'is_empty'))).toEqual([3, 4])
  expect(ids(db, leaf('tag.genre', 'eq', 'Hip Hop'))).toEqual([1])
  expect(ids(db, leaf('tag.genre', 'in', ['Hip Hop', 'R&B']))).toEqual([1, 2])
  // 'DARK' is a vibe tag, not a genre tag.
  expect(ids(db, leaf('tag.genre', 'eq', 'DARK'))).toEqual([])
  expect(ids(db, leaf('tag.vibe', 'eq', 'DARK'))).toEqual([1])
})

// ── Combining and nesting ───────────────────────────────────────────────

test('all and any', () => {
  const db = makeDb()
  const a = leaf('bpm', 'gte', 90)
  const b = leaf('artist', 'eq', 'Dru Hill')
  expect(ids(db, { combine: 'all', rules: [a, b] })).toEqual([2])
  expect(ids(db, { combine: 'any', rules: [leaf('artist', 'eq', 'Foxy Brown'), b] })).toEqual([
    1, 2
  ])
})

test('one level of nesting', () => {
  const db = makeDb()
  const rule: RuleGroup = {
    combine: 'all',
    rules: [
      leaf('missing', 'eq', 0),
      {
        combine: 'any',
        rules: [leaf('artist', 'is_empty'), leaf('bpm', 'gt', 95)]
      }
    ]
  }
  expect(ids(db, rule)).toEqual([2, 3])
})

test('two levels of nesting is rejected', () => {
  const rule: RuleGroup = {
    combine: 'all',
    rules: [{ combine: 'any', rules: [{ combine: 'all', rules: [leaf('bpm', 'gt', 1)] }] }]
  }
  expect(() => compileRule(rule)).toThrow(RuleError)
})

test('an empty rule set is the identity of its combinator', () => {
  const db = makeDb()
  expect(ids(db, { combine: 'all', rules: [] })).toEqual([1, 2, 3, 4])
  expect(ids(db, { combine: 'any', rules: [] })).toEqual([])
  // ...and still composes when nested.
  expect(
    ids(db, { combine: 'all', rules: [leaf('missing', 'eq', 0), { combine: 'any', rules: [] }] })
  ).toEqual([])
})

test('a lone leaf compiles too', () => {
  expect(ids(makeDb(), leaf('artist', 'eq', 'Dru Hill'))).toEqual([2])
})

// ── Injection and rejection ─────────────────────────────────────────────

test('values only ever travel as bound parameters', () => {
  const db = makeDb()
  const attacks = [
    "'; DROP TABLE tracks; --",
    "x' OR '1'='1",
    "Dru Hill' --",
    '") OR 1=1 --',
    'a\\'
  ]
  for (const attack of attacks) {
    for (const op of ['eq', 'neq', 'contains'] as const) {
      const compiled = compileRule(leaf('artist', op, attack))
      expect(compiled.sql).not.toContain(attack)
      expect(compiled.sql).not.toContain('DROP')
      // `contains` additionally escapes LIKE wildcards in the bound value.
      const expected = op === 'contains' ? attack.replace(/[\\%_]/g, '\\$&') : attack
      expect(compiled.params.join('|')).toContain(expected)
      db.prepare(`SELECT t.id FROM tracks t WHERE ${compiled.sql}`).all(...compiled.params)
    }
    const inList = compileRule(leaf('artist', 'in', [attack, 'ok']))
    expect(inList.sql).not.toContain(attack)
    const tag = compileRule(leaf('tag.genre', 'eq', attack))
    expect(tag.sql).not.toContain(attack)
  }
  // The table survived every attempt, and an attack matches nothing.
  expect(ids(db, leaf('artist', 'eq', "'; DROP TABLE tracks; --"))).toEqual([])
  expect(ids(db, leaf('artist', 'eq', "x' OR '1'='1"))).toEqual([])
  expect((db.prepare('SELECT COUNT(*) n FROM tracks').get() as { n: number }).n).toBe(4)
})

test('an injection attempt in the field name or operator is rejected', () => {
  expect(() => compileRule(leaf('artist; DROP TABLE tracks', 'eq', 'x'))).toThrow(RuleError)
  expect(() => compileRule(leaf('artist', 'eq OR 1=1' as never, 'x'))).toThrow(RuleError)
  expect(() => compileRule(leaf('1=1) --', 'is_empty'))).toThrow(RuleError)
})

test('an injection attempt in the table alias is rejected', () => {
  expect(() => compileRule(leaf('artist', 'is_empty'), 't; DROP TABLE tracks')).toThrow(RuleError)
  expect(() => compileRule(leaf('artist', 'is_empty'), '')).toThrow(RuleError)
})

test('an unknown field is rejected, including inherited object keys', () => {
  expect(() => compileRule(leaf('nope', 'eq', 1))).toThrow(/Unknown field/)
  expect(() => compileRule(leaf('constructor', 'eq', 1))).toThrow(/Unknown field/)
  expect(() => compileRule(leaf('__proto__', 'eq', 1))).toThrow(/Unknown field/)
  expect(() => compileRule(leaf('tag.nope', 'is_empty'))).toThrow(/Unknown field/)
})

test('an operator not valid for the field is rejected', () => {
  expect(() => compileRule(leaf('artist', 'gt', 1))).toThrow(RuleError)
  expect(() => compileRule(leaf('missing', 'contains', 'x'))).toThrow(RuleError)
  expect(() => compileRule(leaf('tag.genre', 'contains', 'x'))).toThrow(RuleError)
})

test('malformed values are rejected', () => {
  expect(() => compileRule(leaf('bpm', 'gt'))).toThrow(RuleError)
  expect(() => compileRule(leaf('bpm', 'gt', NaN))).toThrow(RuleError)
  expect(() => compileRule(leaf('bpm', 'gt', Infinity))).toThrow(RuleError)
  expect(() => compileRule(leaf('artist', 'in', []))).toThrow(RuleError)
  expect(() => compileRule(leaf('artist', 'in', 'x'))).toThrow(RuleError)
  expect(() => compileRule(leaf('artist', 'eq', [] as never))).toThrow(RuleError)
  expect(() => compileRule(leaf('tag.genre', 'eq', 5))).toThrow(RuleError)
  expect(() => compileRule(leaf('tag.genre', 'eq'))).toThrow(RuleError)
  expect(() =>
    compileRule(
      leaf(
        'artist',
        'in',
        Array.from({ length: 501 }, (_, i) => `v${i}`)
      )
    )
  ).toThrow(RuleError)
})

test('malformed groups are rejected', () => {
  expect(() => compileRule({ combine: 'xor', rules: [] } as never)).toThrow(RuleError)
  expect(() => compileRule({ combine: 'all' } as never)).toThrow(RuleError)
  expect(() => compileRule({ combine: 'all', rules: [null] } as never)).toThrow(RuleError)
  expect(() => compileRule({ combine: 'all', rules: [{ op: 'eq' }] } as never)).toThrow(RuleError)
})

test('a serialized rule round-trips through JSON and compiles identically', () => {
  const rule: RuleGroup = {
    combine: 'all',
    rules: [leaf('missing', 'eq', 0), { combine: 'any', rules: [leaf('bpm', 'is_empty')] }]
  }
  expect(compileRule(JSON.parse(JSON.stringify(rule)))).toEqual(compileRule(rule))
})
