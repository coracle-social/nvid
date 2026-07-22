import {
  ADAPT_COOLDOWN_MS,
  AUDIO_BITRATE,
  INIT_REPUBLISH_MS,
  MAX_EVENT_BYTES,
  MIN_CAPTURE_FPS,
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
  /** Whether the relay websocket is up. Connected eagerly, not on first publish. */
  connected: boolean
  /** Current capture frame rate, lowered by the adaptive guard when over budget. */
  captureFps: number
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
    connected: false,
    captureFps: Math.round(stream.getVideoTracks()[0]?.getSettings().frameRate ?? 0),
    failed: 0,
  }

  /** Trailing 5s window of (timestamp, bytes) used to compute the wire rate. */
  const window: { at: number; bytes: number }[] = []

  let seq = 0
  let initSegment: Uint8Array | undefined
  let initTimer: ReturnType<typeof setInterval> | undefined
  let stopped = false
  let lastAdaptAt = 0

  const recordRate = (bytes: number) => {
    const now = Date.now()
    window.push({ at: now, bytes })
    while (window.length && now - window[0].at > 5000) window.shift()

    const span = Math.max(1, (now - (window[0]?.at ?? now)) / 1000)
    const total = window.reduce((sum, entry) => sum + entry.bytes, 0)
    stats.bytesPerSecond = Math.round(total / span)
    stats.overBudget = stats.bytesPerSecond > RELAY_BUDGET_BYTES_PER_SEC

    adapt(now)
  }

  /**
   * Backstop for content the fixed encoder settings can't handle — mostly screen shares, where
   * a fullscreen video is orders of magnitude heavier than a static editor. Halves the capture
   * frame rate whenever the wire rate is over budget, which is the one knob that can be turned
   * live without invalidating the init segment viewers have already decoded.
   *
   * Downshift only: recovering upward risks oscillating around the ceiling, and the ceiling is
   * a cliff rather than a slope.
   */
  const adapt = (now: number) => {
    const track = stream.getVideoTracks()[0]
    if (!track || !stats.overBudget) return
    if (now - lastAdaptAt < ADAPT_COOLDOWN_MS) return // let the measurement window refill
    if (window.length < 8) return // too few samples to trust the rate
    if (stats.captureFps <= MIN_CAPTURE_FPS) return

    stats.captureFps = Math.max(MIN_CAPTURE_FPS, Math.round(stats.captureFps / 2))
    lastAdaptAt = now

    void track.applyConstraints({ frameRate: { max: stats.captureFps } }).catch(() => {})
    onError(
      `Over the relay's budget — dropped capture to ${stats.captureFps} fps. Lower the ` +
        `resolution or bitrate in config.ts for better results.`,
    )
  }

  const publish = async (bytes: Uint8Array, isInit: boolean) => {
    // Chrome silently drops codecs the stream can't supply: a video-only screen share asked
    // for as vp8,opus records as plain vp8. Publishing the *requested* string would have
    // viewers build a SourceBuffer expecting an audio track that never arrives, so advertise
    // what the recorder actually produced.
    const actualMimeType = recorder.mimeType || mimeType

    // Claim the sequence number synchronously — signing and publishing are async, so two
    // chunks can be in flight at once and must not race for their position in the stream.
    const template = buildChunkEvent(streamId, seq++, bytes, actualMimeType, isInit)

    if (template.content.length > MAX_EVENT_BYTES) {
      onError(
        `Dropped a ${Math.round(template.content.length / 1024)}KB chunk (over the ` +
          `${Math.round(MAX_EVENT_BYTES / 1024)}KB cap). Lower the bitrate or timeslice.`,
      )
      return
    }

    // Measured on attempt, not on success: once the relay starts timing out, successes stop
    // arriving, and a rate computed from those would fall to zero exactly when the adaptive
    // guard most needs to see that we're over budget.
    recordRate(template.content.length)

    try {
      const relay = await getRelay()
      await relay.publish(sign(template))

      if (stopped) return
      stats.chunks++
      stats.bytesSent += template.content.length
      stats.lastChunkBytes = template.content.length
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

  // Connect up front rather than lazily on the first publish. The relay connection used to be
  // established inside publish(), which meant the whole send path was gated behind media
  // actually flowing — anything that stalled capture left the broadcast with no websocket at
  // all and no indication of why. It also keeps connection setup off the first chunk's latency.
  void getRelay().then(
    () => {
      if (stopped) return
      stats.connected = true
      onStats({ ...stats })
    },
    (error: unknown) => {
      if (!stopped) onError(`Relay connection failed: ${error}`)
    },
  )

  // Screen capture is change-driven: a perfectly static desktop can produce little or no
  // encoded output, and zero-length chunks are skipped. Say so rather than sitting silent.
  const silenceWatchdog = setTimeout(() => {
    if (!stopped && !stats.chunks) {
      onError(
        'Capture has produced no data yet. If you shared a static screen, try moving a ' +
          'window — screen capture only emits frames when something changes.',
      )
    }
  }, 4000)

  return {
    mimeType: recorder.mimeType || mimeType,
    stop() {
      stopped = true
      clearInterval(initTimer)
      clearTimeout(silenceWatchdog)
      if (recorder.state !== 'inactive') recorder.stop()
      for (const track of stream.getTracks()) track.stop()
    },
  }
}
