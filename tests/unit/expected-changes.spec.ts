import { test, expect } from '@playwright/test'
import {
  cancelExpectation,
  clearExpectations,
  consumeExpectedAddition,
  consumeExpectedRemoval,
  expectMove,
  pendingExpectationCount
} from '../../src/main/expectedChanges'

// The hook that stops the watcher treating CrateCloud's own moves as a DJ
// reorganising files in Finder. The risk it covers is asymmetric: suppressing
// too little is noise in the review queue, suppressing too much silently
// swallows a real deletion.

test.beforeEach(() => clearExpectations())

test('both halves of an announced move are recognised', () => {
  expectMove('/a/Track.mp3', '/b/Track.mp3')
  expect(consumeExpectedRemoval('/a/Track.mp3')).toBe(true)
  expect(consumeExpectedAddition('/b/Track.mp3')).toBe(true)
})

test('an unannounced path is not suppressed', () => {
  expectMove('/a/Track.mp3', '/b/Track.mp3')
  expect(consumeExpectedRemoval('/somewhere/else.mp3')).toBe(false)
  expect(consumeExpectedAddition('/a/Track.mp3')).toBe(false)
})

test('consume-once: a SECOND unlink of the same path is a real deletion', () => {
  // Move a file, then genuinely delete it from its new home. The second
  // event must reach the watcher or the track silently stays in the library.
  expectMove('/a/Track.mp3', '/b/Track.mp3')
  expect(consumeExpectedRemoval('/a/Track.mp3')).toBe(true)
  expect(consumeExpectedRemoval('/a/Track.mp3')).toBe(false)
})

test('an expired announcement does not suppress anything', () => {
  const t0 = 1_000_000
  expectMove('/a/Track.mp3', '/b/Track.mp3', 10_000, t0)
  // Same instant: live.
  expect(pendingExpectationCount(t0 + 1)).toBe(2)
  // Well past the TTL — a move that never happened must not deafen the
  // watcher to a real change at that path later.
  expect(consumeExpectedRemoval('/a/Track.mp3', t0 + 60_000)).toBe(false)
})

test('a cancelled announcement stops suppressing immediately', () => {
  // A move that failed before touching the disk. Without the cancel, the
  // watcher would ignore a genuine change at these paths until the TTL ran.
  expectMove('/a/Track.mp3', '/b/Track.mp3')
  cancelExpectation('/a/Track.mp3', '/b/Track.mp3')
  expect(consumeExpectedRemoval('/a/Track.mp3')).toBe(false)
  expect(consumeExpectedAddition('/b/Track.mp3')).toBe(false)
})

test('removal and addition are tracked separately for the same path', () => {
  // A path can be the source of one move and the destination of another.
  expectMove('/a/Track.mp3', '/b/Track.mp3')
  expectMove('/b/Track.mp3', '/c/Track.mp3')
  expect(consumeExpectedAddition('/b/Track.mp3')).toBe(true)
  expect(consumeExpectedRemoval('/b/Track.mp3')).toBe(true)
})
