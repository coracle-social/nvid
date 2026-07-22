import {
  AUDIO_BITRATE,
  INIT_REPUBLISH_MS,
  MAX_EVENT_BYTES,
  RELAY_BUDGET_BYTES_PER_SEC,
  TIMESLICE_MS,
  VIDEO_BITRATE,
} from './config'
import { getRelay, sign } from './nostr'
import { buildChunkEvent } from './protocol'
import { splitInitSegment } from './webm'

export type BroadcastStats = {
  chunks: number
  bytesSent: number
  lastChunkBytes: number
  /** Base64 bytes/sec over a trailing window — the number the relay actually cares about. */
  bytesPerSecond: number
  overBudget: boolean
  /** Publishes the relay never acked. A non-zero value here is what viewers see as stutter. */
  failed: number
}

export type BroadcastOptions = {
  streamId: string
  stream: MediaStream
  onStats: (stats: BroadcastStats) => void
  onError: (message: string) => void
}

export type Broadcast = {
  mimeType: string
  stop: () => void
}

const VIDEO_CANDIDATES = [
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8',
  'video/webm',
]

const AUDIO_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm']

/**
 * VP8 over VP9 by default: it encodes faster at these bitrates and is the safest bet for
 * MediaSource support on the playback side.
 */
export function pickMimeType(stream: MediaStream): string | undefined {
  const candidates = stream.getVideoTracks().length ? VIDEO_CANDIDATES : AUDIO_CANDIDATES
  return candidates.find(type => MediaRecorder.isTypeSupported(type))
}

export function startBroadcast({ streamId, stream, onStats, onError }: BroadcastOptions): Broadcast {
  const mimeType = pickMimeType(stream)
  if (!mimeType) throw new Error('This browser has no supported WebM MediaRecorder profile.')

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: VIDEO_BITRATE,
    audioBitsPerSecond: AUDIO_BITRATE,
  })

  const stats: BroadcastStats = {
    chunks: 0,
    bytesSent: 0,
    lastChunkBytes: 0,
    bytesPerSecond: 0,
    overBudget: false,
    failed: 0,
  }

  /** Trailing 5s window of (timestamp, bytes) used to compute the wire rate. */
  const window: { at: number; bytes: number }[] = []

  let seq = 0
  let initSegment: Uint8Array | undefined
  let initTimer: ReturnType<typeof setInterval> | undefined
  let stopped = false

  const recordRate = (bytes: number) => {
    const now = Date.now()
    window.push({ at: now, bytes })
    while (window.length && now - window[0].at > 5000) window.shift()

    const span = Math.max(1, (now - (window[0]?.at ?? now)) / 1000)
    const total = window.reduce((sum, entry) => sum + entry.bytes, 0)
    stats.bytesPerSecond = Math.round(total / span)
    stats.overBudget = stats.bytesPerSecond > RELAY_BUDGET_BYTES_PER_SEC
  }

  const publish = async (bytes: Uint8Array, isInit: boolean) => {
    // Claim the sequence number synchronously — signing and publishing are async, so two
    // chunks can be in flight at once and must not race for their position in the stream.
    const template = buildChunkEvent(streamId, seq++, bytes, mimeType, isInit)

    if (template.content.length > MAX_EVENT_BYTES) {
      onError(
        `Dropped a ${Math.round(template.content.length / 1024)}KB chunk (over the ` +
          `${Math.round(MAX_EVENT_BYTES / 1024)}KB cap). Lower the bitrate or timeslice.`,
      )
      return
    }

    try {
      const relay = await getRelay()
      await relay.publish(sign(template))

      if (stopped) return
      stats.chunks++
      stats.bytesSent += template.content.length
      stats.lastChunkBytes = template.content.length
      recordRate(template.content.length)
      onStats({ ...stats })
    } catch (error) {
      if (stopped) return
      // Overshooting the relay's throughput shows up here first, as publish timeouts, and
      // the events behind it are simply lost. Surface it rather than failing silently.
      stats.failed++
      onStats({ ...stats })
      onError(error instanceof Error ? error.message : String(error))
    }
  }

  recorder.ondataavailable = async event => {
    if (stopped || !event.data.size) return

    const bytes = new Uint8Array(await event.data.arrayBuffer())

    // The first chunk is EBML header followed by media. Split it: the header alone is what
    // late joiners need re-sent, and it's ~200 B rather than the ~7 KB the whole chunk costs.
    // The media half still has to go out as an ordinary chunk or the stream loses its first
    // half-second.
    if (!initSegment) {
      const { init, media } = splitInitSegment(bytes)
      initSegment = init

      void publish(init, true)
      if (media) void publish(media, false)

      initTimer = setInterval(() => void publish(initSegment!, true), INIT_REPUBLISH_MS)
      return
    }

    void publish(bytes, false)
  }

  recorder.onerror = () => onError('MediaRecorder failed.')
  recorder.start(TIMESLICE_MS)

  return {
    mimeType,
    stop() {
      stopped = true
      clearInterval(initTimer)
      if (recorder.state !== 'inactive') recorder.stop()
      for (const track of stream.getTracks()) track.stop()
    },
  }
}
