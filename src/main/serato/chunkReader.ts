// ── Serato binary chunk format ────────────────────────────────────────────
// Shared by `database V2`, `Subcrates/*.crate`, and `History/**/*.database`
// `.session` files. Every chunk is a 4-byte ASCII tag, a 4-byte big-endian
// UInt32 length, then that many bytes of payload. Chunks are concatenated
// back-to-back with no padding or trailer; a container chunk's payload is
// itself a run of more chunks in the same shape.
//
// Payload type is inferred from the tag's first letter (verified against a
// real `database V2` and a real `.crate` file — see scripts/serato-dump.ts):
//   o = container (more chunks)         t = UTF-16BE string
//   u = UInt32BE                        b = single byte (bool)
//   p = UTF-16BE path string            v = version string (UTF-16BE)
//   anything else = raw bytes (e.g. the 's'-tagged fields Serato itself
//   doesn't publicly document — keep them opaque rather than guess).

export type ChunkValue = string | number | boolean | Buffer | ChunkContainer
export type ChunkContainer = Map<string, ChunkValue>

export interface RawChunk {
  tag: string
  payload: Buffer
}

const HEADER_BYTES = 8 // 4-byte tag + 4-byte BE length

function decodeUtf16BE(buf: Buffer): string {
  // Buffer has no native UTF-16BE decoder — swap to LE pairs first, the same
  // trick serato.ts's writer uses in reverse (toUtf16BE).
  const le = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i + 1 < buf.length; i += 2) {
    le[i] = buf[i + 1]
    le[i + 1] = buf[i]
  }
  return le.toString('utf16le')
}

function decodeChunkPayload(tag: string, payload: Buffer): ChunkValue {
  switch (tag[0]) {
    case 'o':
      return readContainer(payload)
    case 't':
    case 'p':
    case 'v':
      return decodeUtf16BE(payload)
    case 'u':
      return payload.length >= 4 ? payload.readUInt32BE(0) : 0
    case 'b':
      return payload.length > 0 && payload[0] !== 0
    default:
      return payload
  }
}

// Yields one raw {tag, payload} pair at a time — callers decide whether and
// how deep to decode each one. Never materializes the whole file as a tree:
// the database layer relies on this to stream `otrk` entries one at a time
// instead of holding every track in memory at once.
export function* readChunks(buffer: Buffer): Iterable<RawChunk> {
  let offset = 0
  while (offset + HEADER_BYTES <= buffer.length) {
    const tag = buffer.toString('ascii', offset, offset + 4)
    const length = buffer.readUInt32BE(offset + 4)
    const payloadStart = offset + HEADER_BYTES
    const payloadEnd = payloadStart + length
    if (payloadEnd > buffer.length) break // truncated/corrupt trailing chunk — stop, don't throw
    yield { tag, payload: buffer.subarray(payloadStart, payloadEnd) }
    offset = payloadEnd
  }
}

// Fully decodes one bounded container's direct children into a flat
// tag -> value map (nested containers decode recursively, since a single
// `otrk`/`adat` is small and bounded — this is not the whole-file tree the
// comment above warns against skipping).
export function readContainer(buffer: Buffer): ChunkContainer {
  const result: ChunkContainer = new Map()
  for (const { tag, payload } of readChunks(buffer)) {
    result.set(tag, decodeChunkPayload(tag, payload))
  }
  return result
}
