import { test, expect } from '@playwright/test'
import { hasElectron } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// setTagsForField / renameTagAndCascade against the real schema. These hold
// the invariant the whole migration depends on: a track's tags and its
// derived column change together or not at all. The drift this replaces —
// ~40 tracks whose badges and library list disagreed — came from that not
// being true.

test.skip(!hasElectron(), 'electron/esbuild not installed')

let probe: ProbeSession

test.beforeEach(() => {
  probe = createProbeSession()
})
test.afterEach(() => {
  probe.cleanup()
})

async function run<T = unknown>(ops: ProbeOp[]): Promise<T[]> {
  return unwrap<T>(await probe.run(ops), ops)
}
function at<T>(results: unknown[], fromEnd: number): T {
  return results[results.length - fromEnd] as T
}

function seed(): ProbeOp[] {
  return [
    { fn: 'addRoot', args: ['Library', '/music'] },
    {
      fn: 'insertTrack',
      args: [
        {
          filepath: '/music/One.mp3',
          filename: 'One.mp3',
          title: 'One',
          artist: '',
          file_size_bytes: 4096,
          duration_sec: 180
        }
      ]
    }
  ]
}

test('setting tags writes the derived column in the same call', () => {
  // Nothing else has to run for the row and the badges to agree.
  return run([
    ...seed(),
    { fn: 'setTagsForField', args: [1, 'artist', ['Foxy Brown', 'Dru Hill']] },
    { fn: 'getTrackById', args: [1] },
    { fn: 'getTrackTags', args: [1] }
  ]).then((results) => {
    const derived = at<string | null>(results, 3)
    const track = at<{ artist: string }>(results, 2)
    const tags = at<{ field: string; value: string }[]>(results, 1)

    // The derived string keeps the order the DJ set (ORDER BY tt.rowid) ...
    expect(derived).toBe('Foxy Brown / Dru Hill')
    expect(track.artist).toBe('Foxy Brown / Dru Hill')
    // ... while getTrackTags lists badges alphabetically (ORDER BY tg.field,
    // tg.value). Deliberately different: the display string is the DJ's
    // ordering, the badge list is a stable one. Assert the set here, and the
    // ordering above where it is actually the contract.
    expect(tags.map((t) => t.value).sort()).toEqual(['Dru Hill', 'Foxy Brown'])
  })
})

test('order is preserved — it is what the display string reads', () => {
  return run([
    ...seed(),
    { fn: 'setTagsForField', args: [1, 'artist', ['Dru Hill', 'Foxy Brown']] }
  ]).then((results) => {
    expect(at<string>(results, 1)).toBe('Dru Hill / Foxy Brown')
  })
})

test('setting again REPLACES, it does not accumulate', () => {
  return run([
    ...seed(),
    { fn: 'setTagsForField', args: [1, 'artist', ['A', 'B']] },
    { fn: 'setTagsForField', args: [1, 'artist', ['C']] },
    { fn: 'getTrackById', args: [1] }
  ]).then((results) => {
    expect(at<{ artist: string }>(results, 1).artist).toBe('C')
  })
})

test('clearing a field nulls the column rather than emptying it to a string', () => {
  return run([
    ...seed(),
    { fn: 'setTagsForField', args: [1, 'artist', ['A']] },
    { fn: 'setTagsForField', args: [1, 'artist', []] },
    { fn: 'getTrackById', args: [1] }
  ]).then((results) => {
    expect(at<{ artist: string | null }>(results, 1).artist).toBeNull()
  })
})

test('one field never clears another sharing the pivot table', () => {
  // track_tags holds every field's rows. Setting genre must not unlink the
  // artist badges sitting beside them.
  return run([
    ...seed(),
    { fn: 'setTagsForField', args: [1, 'artist', ['Foxy Brown']] },
    { fn: 'setTagsForField', args: [1, 'genre', ['Hip Hop']] },
    { fn: 'getTrackById', args: [1] }
  ]).then((results) => {
    const track = at<{ artist: string; genre: string }>(results, 1)
    expect(track.artist).toBe('Foxy Brown')
    expect(track.genre).toBe('Hip Hop')
  })
})

test('a field outside the allow-list is refused, not written into SQL', () => {
  // The field name is interpolated into the UPDATE, so this is the guard
  // that keeps it from being anything the caller likes.
  return probe
    .run([...seed(), { fn: 'setTagsForField', args: [1, 'title; DROP TABLE tracks', ['x']] }])
    .then((results) => {
      const last = results[results.length - 1]
      expect(last.ok).toBe(false)
      if (!last.ok) expect(last.error).toContain('Not a tag-backed field')
    })
})

test('renaming a tag re-derives every track carrying it', () => {
  return run([
    ...seed(),
    {
      fn: 'insertTrack',
      args: [
        {
          filepath: '/music/Two.mp3',
          filename: 'Two.mp3',
          title: 'Two',
          file_size_bytes: 4096,
          duration_sec: 180
        }
      ]
    },
    { fn: 'setTagsForField', args: [1, 'artist', ['Foxy Brown', 'Dru Hill']] },
    { fn: 'setTagsForField', args: [2, 'artist', ['Foxy Brown']] },
    { fn: 'getTagsByField', args: ['artist'] },
    { fn: 'getTrackById', args: [1] },
    { fn: 'getTrackById', args: [2] }
  ]).then(async (results) => {
    const tags = at<{ id: number; value: string }[]>(results, 3)
    const foxy = tags.find((t) => t.value === 'Foxy Brown')!

    const after = await run([
      { fn: 'renameTagAndCascade', args: [foxy.id, 'Inga Marchand'] },
      { fn: 'getTrackById', args: [1] },
      { fn: 'getTrackById', args: [2] }
    ])

    const outcome = at<{ renamed: boolean; tracksUpdated: number }>(after, 3)
    expect(outcome.renamed).toBe(true)
    expect(outcome.tracksUpdated).toBe(2)

    // Both derived columns followed the rename — the thing that did not
    // happen before, because nothing renamed tags at all.
    expect(at<{ artist: string }>(after, 2).artist).toBe('Inga Marchand / Dru Hill')
    expect(at<{ artist: string }>(after, 1).artist).toBe('Inga Marchand')
  })
})

test('renaming onto an existing tag merges instead of violating UNIQUE', () => {
  return run([
    ...seed(),
    { fn: 'setTagsForField', args: [1, 'artist', ['Foxy Brown', 'Dru Hill']] },
    { fn: 'getTagsByField', args: ['artist'] }
  ]).then(async (results) => {
    const tags = at<{ id: number; value: string }[]>(results, 1)
    const dru = tags.find((t) => t.value === 'Dru Hill')!

    const after = await run([
      { fn: 'renameTagAndCascade', args: [dru.id, 'Foxy Brown'] },
      { fn: 'getTrackById', args: [1] },
      { fn: 'getTagsByField', args: ['artist'] }
    ])

    const outcome = at<{ mergedInto: number | null }>(after, 3)
    expect(outcome.mergedInto).not.toBeNull()

    // The track carried both, so after the merge it carries one.
    expect(at<{ artist: string }>(after, 2).artist).toBe('Foxy Brown')
    expect(at<{ value: string }[]>(after, 1).map((t) => t.value)).toEqual(['Foxy Brown'])
  })
})

test('renaming to the same value is a no-op', () => {
  return run([
    ...seed(),
    { fn: 'setTagsForField', args: [1, 'artist', ['Foxy Brown']] },
    { fn: 'getTagsByField', args: ['artist'] }
  ]).then(async (results) => {
    const tag = at<{ id: number }[]>(results, 1)[0]
    const after = await run([{ fn: 'renameTagAndCascade', args: [tag.id, 'Foxy Brown'] }])
    expect(at<{ renamed: boolean }>(after, 1).renamed).toBe(false)
  })
})
