/**
 * Just enough EBML parsing to split MediaRecorder's first chunk into its two halves.
 *
 * A WebM byte stream is `EBML header · Segment[ Info, Tracks, …, Cluster, Cluster, … ]`.
 * Everything before the first Cluster is the initialization segment a decoder needs, and it
 * is *tiny* — measured at 189 bytes against a 6840 byte first chunk. Re-broadcasting the
 * whole chunk to serve late joiners therefore wasted ~97% of those bytes on media nobody
 * used, which matters a lot given how little throughput the relay has to spare.
 */

const ID_SEGMENT = 0x18538067
const ID_CLUSTER = 0x1f43b675

/** Length of an EBML variable-length integer, from the leading-zero count of its first byte. */
function vintLength(firstByte: number): number {
  for (let i = 0; i < 8; i++) {
    if (firstByte & (0x80 >> i)) return i + 1
  }
  return 0 // invalid
}

/**
 * Byte offset of the first Cluster, i.e. the length of the initialization segment.
 * Returns null if this chunk has no cluster yet, or if it doesn't parse as EBML.
 */
export function findFirstClusterOffset(bytes: Uint8Array): number | null {
  let pos = 0

  while (pos < bytes.length) {
    const elementStart = pos

    // Element ID — the marker bit is part of the ID, so read the bytes as-is.
    const idLength = vintLength(bytes[pos])
    if (!idLength || pos + idLength > bytes.length) return null

    let id = 0
    for (let i = 0; i < idLength; i++) id = id * 0x100 + bytes[pos + i]
    pos += idLength

    // Element size — here the marker bit is stripped. All-ones means "unknown size",
    // which is what a streaming Segment uses since its length isn't known up front.
    if (pos >= bytes.length) return null
    const sizeLength = vintLength(bytes[pos])
    if (!sizeLength || pos + sizeLength > bytes.length) return null

    let size = bytes[pos] & (0xff >> sizeLength)
    let unknownSize = size === (0xff >> sizeLength)
    for (let i = 1; i < sizeLength; i++) {
      size = size * 0x100 + bytes[pos + i]
      if (bytes[pos + i] !== 0xff) unknownSize = false
    }
    pos += sizeLength

    if (id === ID_CLUSTER) return elementStart

    // Descend into Segment rather than skipping it — the Clusters live inside.
    if (id === ID_SEGMENT) continue

    if (unknownSize) return null
    pos += size
  }

  return null
}

/**
 * Offset of the next Cluster boundary at or after `from`, or null if this chunk has none.
 *
 * Timeslice chunks are cut on byte boundaries, not element boundaries: measured against
 * Chrome, every chunk after the first starts *mid-cluster* and contains exactly one Cluster
 * ID. That's fine while appending a contiguous stream, but a late joiner appending a partial
 * cluster straight after the init segment is feeding the decoder garbage — so it has to skip
 * ahead to a real boundary once, at join.
 *
 * Matching the 4-byte ID alone would risk hitting those bytes inside compressed payload, so
 * the size vint that must follow is validated too. Live WebM writes clusters with unknown
 * size (observed: `01 ff ff ff ff ff ff ff`), and requiring that signature makes a false
 * match effectively impossible.
 */
export function findClusterStart(bytes: Uint8Array, from = 0): number | null {
  search: for (let i = from; i + 5 <= bytes.length; i++) {
    if (bytes[i] !== 0x1f || bytes[i + 1] !== 0x43 || bytes[i + 2] !== 0xb6 || bytes[i + 3] !== 0x75) {
      continue
    }

    const sizeLength = vintLength(bytes[i + 4])
    if (!sizeLength || i + 4 + sizeLength > bytes.length) continue

    const mask = 0xff >> sizeLength
    if ((bytes[i + 4] & mask) !== mask) continue
    for (let k = 1; k < sizeLength; k++) {
      if (bytes[i + 4 + k] !== 0xff) continue search
    }

    return i
  }

  return null
}

/**
 * Split MediaRecorder's first chunk into (init segment, leading media). Falls back to
 * treating the whole chunk as init if it can't be parsed, which is what the previous
 * version did unconditionally.
 */
export function splitInitSegment(bytes: Uint8Array): {
  init: Uint8Array
  media: Uint8Array | null
} {
  const offset = findFirstClusterOffset(bytes)

  if (offset === null || offset <= 0 || offset >= bytes.length) {
    return { init: bytes, media: null }
  }

  return { init: bytes.subarray(0, offset), media: bytes.subarray(offset) }
}
