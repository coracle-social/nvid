import type { Event, EventTemplate } from 'nostr-tools/core'
import { STREAM_KIND } from './config'

/**
 * Wire format
 * ───────────
 *   kind:    25845 (ephemeral)
 *   content: base64 of one raw MediaRecorder chunk
 *   tags:
 *     ["t",    <streamId>]  stream identifier — subscribers filter on #t
 *     ["i",    <seq>]       monotonic chunk counter, decimal string
 *     ["init", "1"]         present only on the codec init segment (re-sent periodically)
 *     ["m",    <mimeType>]  container/codec string, e.g. video/webm;codecs=vp8,opus
 *     ["ts",   <ms>]        capture wall-clock, for the viewer's latency readout only
 *
 * The byte stream is a plain WebM byte stream cut at timeslice boundaries: chunk 0 carries
 * the EBML header the decoder needs to initialize, every later chunk is clusters. That's
 * why chunk 0 is special-cased and replayed — a viewer joining at chunk 400 has no header.
 */

export type StreamChunk = {
  id: string
  seq: number
  isInit: boolean
  mimeType: string
  bytes: Uint8Array
  /** Broadcaster wall-clock at capture. Undefined if the publisher didn't send one. */
  capturedAt: number | undefined
}

export function buildChunkEvent(
  streamId: string,
  seq: number,
  bytes: Uint8Array,
  mimeType: string,
  isInit: boolean,
): EventTemplate {
  const tags = [
    ['t', streamId],
    ['i', String(seq)],
    ['m', mimeType],
    ['ts', String(Date.now())],
  ]

  if (isInit) tags.push(['init', '1'])

  return {
    kind: STREAM_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: toBase64(bytes),
  }
}

export function parseChunkEvent(event: Event): StreamChunk | null {
  const seq = Number(tagValue(event, 'i'))
  const mimeType = tagValue(event, 'm')

  if (!Number.isFinite(seq) || !mimeType || !event.content) return null

  try {
    return {
      id: event.id,
      seq,
      mimeType,
      isInit: tagValue(event, 'init') === '1',
      capturedAt: Number(tagValue(event, 'ts')) || undefined,
      bytes: fromBase64(event.content),
    }
  } catch {
    return null // malformed base64 from some other publisher on this stream id
  }
}

function tagValue(event: Event, name: string): string | undefined {
  return event.tags.find(tag => tag[0] === name)?.[1]
}

// Uint8Array.toBase64/fromBase64 are recent additions; fall back to btoa/atob elsewhere.
type Base64Codec = {
  toBase64?: () => string
}
type Base64Static = {
  fromBase64?: (s: string) => Uint8Array
}

export function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & Base64Codec).toBase64
  if (native) return native.call(bytes)

  // String.fromCharCode is applied in slices to stay under the argument-count limit.
  let binary = ''
  const SLICE = 0x8000
  for (let i = 0; i < bytes.length; i += SLICE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + SLICE))
  }
  return btoa(binary)
}

export function fromBase64(b64: string): Uint8Array {
  const native = (Uint8Array as typeof Uint8Array & Base64Static).fromBase64
  if (native) return native(b64)

  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
