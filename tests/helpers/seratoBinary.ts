// Writers for the three Serato binary formats the app only ever reads
// (`database V2`, `Subcrates/*.crate`, `History/Sessions/*.session`).
//
// These exist so the reader specs can assert against bytes whose intended
// meaning is known by construction. Reading the developer's own real
// `_Serato_` folder instead would make the suite machine-dependent and,
// worse, would only ever prove "the reader agrees with itself" — the
// encoders here are written from the format description, independently of
// src/main/serato/chunkReader.ts's decoder, so a round-trip failure points
// at a real disagreement.

export function utf16be(value: string): Buffer {
  const le = Buffer.from(value, 'utf16le')
  const be = Buffer.allocUnsafe(le.length)
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1]
    be[i + 1] = le[i]
  }
  return be
}

export function chunk(tag: string, payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(8)
  header.write(tag.padEnd(4, ' ').slice(0, 4), 0, 'ascii')
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

export function stringChunk(tag: string, value: string): Buffer {
  return chunk(tag, utf16be(value))
}

export function uint32Chunk(tag: string, value: number): Buffer {
  const payload = Buffer.allocUnsafe(4)
  payload.writeUInt32BE(value, 0)
  return chunk(tag, payload)
}

export function boolChunk(tag: string, value: boolean): Buffer {
  return chunk(tag, Buffer.from([value ? 1 : 0]))
}

// ── database V2 ───────────────────────────────────────────────────────────

export interface FakeSeratoTrack {
  /** Volume-relative, exactly as Serato stores it in `pfil`. */
  relativePath: string
  title?: string
  artist?: string
  album?: string
  genre?: string
  comment?: string
  label?: string
  composer?: string
  remixer?: string
  grouping?: string
  year?: string
  key?: string
  /** Serato writes bpm as a decimal string, e.g. "128.00". */
  bpm?: string
  /** Serato writes length as "mm:ss.hh", e.g. "04:22.74". */
  length?: string
  fileSizeBytes?: number
  addedAtEpochSec?: number
  /** Omit `uadd` and leave only the decimal-string `tadd` behind. */
  addedAtStringOnly?: boolean
}

export function buildDatabaseV2(tracks: FakeSeratoTrack[]): Buffer {
  const chunks: Buffer[] = [stringChunk('vrsn', '2.0/Serato Scratch LIVE Database')]

  for (const track of tracks) {
    const fields: Buffer[] = [stringChunk('ttyp', 'mp3'), stringChunk('pfil', track.relativePath)]
    const optional: [string, string | undefined][] = [
      ['tsng', track.title],
      ['tart', track.artist],
      ['talb', track.album],
      ['tgen', track.genre],
      ['tcom', track.comment],
      ['tlbl', track.label],
      ['tcmp', track.composer],
      ['trmx', track.remixer],
      ['tgrp', track.grouping],
      ['ttyr', track.year],
      ['tkey', track.key],
      ['tbpm', track.bpm],
      ['tlen', track.length]
    ]
    for (const [tag, value] of optional) {
      if (value !== undefined) fields.push(stringChunk(tag, value))
    }
    if (track.fileSizeBytes !== undefined) fields.push(uint32Chunk('ufsb', track.fileSizeBytes))
    if (track.addedAtEpochSec !== undefined) {
      fields.push(stringChunk('tadd', String(track.addedAtEpochSec)))
      if (!track.addedAtStringOnly) fields.push(uint32Chunk('uadd', track.addedAtEpochSec))
    }
    // Serato's own trailing flags — present in every real entry, and
    // meaningless to the reader. Included so the fixture exercises the
    // "skip tags we don't care about" path rather than a tidy subset.
    fields.push(boolChunk('bmis', false), boolChunk('bply', false))

    chunks.push(chunk('otrk', Buffer.concat(fields)))
  }

  return Buffer.concat(chunks)
}

// ── Subcrates/*.crate ─────────────────────────────────────────────────────

export function buildCrateFile(relativePaths: string[]): Buffer {
  const chunks: Buffer[] = [
    stringChunk('vrsn', '1.0/Serato ScratchLive Crate'),
    // Serato's own UI state, which the reader must skip past to reach otrk.
    stringChunk('osrt', 'song'),
    stringChunk('ovct', 'song')
  ]
  for (const path of relativePaths) {
    chunks.push(chunk('otrk', stringChunk('ptrk', path)))
  }
  return Buffer.concat(chunks)
}

// ── History/Sessions/*.session ────────────────────────────────────────────
// `adat` uses a 4-byte BIG-ENDIAN NUMERIC field id where the outer format
// uses a 4-character ASCII tag — see seratoHistory.ts. Strings inside adat
// are UTF-16BE and null-terminated.

function adatField(id: number, payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(8)
  header.writeUInt32BE(id, 0)
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

function adatString(id: number, value: string): Buffer {
  return adatField(id, Buffer.concat([utf16be(value), Buffer.from([0, 0])]))
}

function adatUint32(id: number, value: number): Buffer {
  const payload = Buffer.allocUnsafe(4)
  payload.writeUInt32BE(value, 0)
  return adatField(id, payload)
}

export interface FakeSeratoPlay {
  /** History stores an already-absolute path, unlike pfil/ptrk. */
  absolutePath: string
  title?: string
  artist?: string
  playedAtEpochSec: number
  durationPlayedSec?: number
  row?: number
}

export function buildSessionFile(plays: FakeSeratoPlay[]): Buffer {
  const chunks: Buffer[] = [stringChunk('vrsn', '1.0/Serato ScratchLive Session')]
  plays.forEach((play, index) => {
    const fields: Buffer[] = [
      adatUint32(1, play.row ?? index + 1),
      adatString(2, play.absolutePath)
    ]
    if (play.title !== undefined) fields.push(adatString(6, play.title))
    if (play.artist !== undefined) fields.push(adatString(7, play.artist))
    fields.push(adatUint32(28, play.playedAtEpochSec))
    if (play.durationPlayedSec !== undefined) fields.push(adatUint32(45, play.durationPlayedSec))
    chunks.push(chunk('oent', chunk('adat', Buffer.concat(fields))))
  })
  return Buffer.concat(chunks)
}
