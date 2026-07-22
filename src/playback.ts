import {
  BUFFER_BEHIND_SECONDS,
  CATCHUP_RATE,
  DEADBAND_SECONDS,
  JITTER_CHUNKS,
  JITTER_FLUSH_MS,
  MAX_LAG_SECONDS,
  MIN_BUFFER_SECONDS,
  PREBUFFER_SECONDS,
  PREBUFFER_TIMEOUT_MS,
  SLOWDOWN_RATE,
  STREAM_KIND,
  TARGET_LATENCY_SECONDS,
} from './config'
import { getRelay } from './nostr'
import { parseChunkEvent, type StreamChunk } from './protocol'
import { findClusterStart } from './webm'

export type PlaybackStatus = 'connecting' | 'waiting' | 'buffering' | 'playing' | 'error'

export type PlaybackStats = {
  chunks: number
  bytesReceived: number
  bufferedSeconds: number
  droppedLate: number
  /** Chunks discarded while hunting for the first cluster boundary after the init segment. */
  resyncDropped: number
  /**
   * Estimated glass-to-glass latency in ms: how old the media at the playhead is. Assumes the
   * two clocks agree, so treat it as indicative rather than exact across machines.
   */
  latencyMs: number | undefined
}

export type PlaybackOptions = {
  streamId: string
  video: HTMLVideoElement
  onStatus: (status: PlaybackStatus, detail?: string) => void
  onStats: (stats: PlaybackStats) => void
  /** Fired when autoplay is refused, so the UI can offer a tap-to-play affordance. */
  onNeedsGesture: () => void
}

export type Playback = {
  /** Retry playback after the user supplies the gesture autoplay was waiting for. */
  resume: () => void
  stop: () => void
}

export function startPlayback({
  streamId,
  video,
  onStatus,
  onStats,
  onNeedsGesture,
}: PlaybackOptions): Playback {
  const stats: PlaybackStats = {
    chunks: 0,
    bytesReceived: 0,
    bufferedSeconds: 0,
    droppedLate: 0,
    resyncDropped: 0,
    latencyMs: undefined,
  }

  /** Reordering buffer: the relay makes no ordering promise, so sort by `i` before appending. */
  const pending: StreamChunk[] = []
  /** Byte chunks accepted and awaiting a free SourceBuffer. */
  const queue: Uint8Array[] = []
  const seenEventIds = new Set<string>()

  let mediaSource: MediaSource | undefined
  let sourceBuffer: SourceBuffer | undefined
  let objectUrl: string | undefined
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let lastSeq = -1
  let initialized = false
  let live = false
  let stopped = false
  let awaitingGesture = false
  /** Set after appending an init segment: the next append must start on a cluster boundary. */
  let needsClusterStart = false
  /** Playback holds off until PREBUFFER_SECONDS is banked; see ensurePlaying. */
  let hasStarted = false
  let firstDataAt: number | undefined
  /** Capture time of the newest media accepted, for the latency estimate. */
  let newestCapturedAt: number | undefined

  onStatus('connecting')

  // ── Assembly ────────────────────────────────────────────────────────────────────────

  const attachMediaSource = (mimeType: string) => {
    mediaSource = new MediaSource()
    objectUrl = URL.createObjectURL(mediaSource)
    video.src = objectUrl

    mediaSource.addEventListener(
      'sourceopen',
      () => {
        if (stopped || !mediaSource) return

        if (!MediaSource.isTypeSupported(mimeType)) {
          onStatus('error', `This browser can't play ${mimeType} via MediaSource.`)
          return
        }

        try {
          sourceBuffer = mediaSource.addSourceBuffer(mimeType)
          // The init segment we replay to late joiners carries timestamps from the start of
          // the broadcast, while the clusters after it are from now. 'sequence' mode makes
          // the decoder lay each appended group down end-to-end instead of honouring those
          // timestamps, which would otherwise leave a stream-length hole in the timeline.
          sourceBuffer.mode = 'sequence'
          sourceBuffer.addEventListener('updateend', onUpdateEnd)
          sourceBuffer.addEventListener('error', () =>
            onStatus('error', 'SourceBuffer rejected the media data.'),
          )
          pump()
        } catch (error) {
          onStatus('error', error instanceof Error ? error.message : String(error))
        }
      },
      { once: true },
    )
  }

  /**
   * Autoplay is only granted once the element actually has something to show, and a live
   * stream can also stall itself by draining the buffer. Both are fixed by retrying play()
   * whenever new media lands, rather than once at startup.
   */
  const ensurePlaying = () => {
    if (stopped) return

    const buffered = video.buffered
    if (!buffered.length) return

    if (!hasStarted) {
      firstDataAt ??= Date.now()
      const cushion = buffered.end(buffered.length - 1) - buffered.start(0)

      if (cushion < PREBUFFER_SECONDS && Date.now() - firstDataAt < PREBUFFER_TIMEOUT_MS) {
        // The element starts itself the moment it has a frame, which both skips the cushion
        // and leaves hasStarted false forever. Hold it until there's something banked.
        if (!video.paused) video.pause()
        onStatus('buffering')
        return
      }

      hasStarted = true
      onStatus('playing')
    }

    if (awaitingGesture || !video.paused) return

    video.play().catch(error => {
      // Only a genuine autoplay block needs a user gesture. A pending play() that gets
      // interrupted by our own live-edge seek rejects with AbortError — that one is
      // transient, so leave the flag alone and let the next updateend retry.
      if (error?.name === 'NotAllowedError') {
        awaitingGesture = true
        onNeedsGesture()
      }
    })
  }

  const onUpdateEnd = () => {
    pump()
    evictOldBuffer()
    ensurePlaying()
    syncToLiveEdge()
    reportStats()
  }

  const pump = () => {
    if (stopped || !sourceBuffer || sourceBuffer.updating || !queue.length) return

    const bytes = queue.shift()!
    try {
      sourceBuffer.appendBuffer(bytes as BufferSource)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        // Buffer is full. Put the chunk back, drop the oldest media, and retry on updateend.
        queue.unshift(bytes)
        evictOldBuffer(true)
        return
      }
      onStatus('error', error instanceof Error ? error.message : String(error))
    }
  }

  const evictOldBuffer = (aggressive = false) => {
    if (!sourceBuffer || sourceBuffer.updating) return

    const buffered = sourceBuffer.buffered
    if (!buffered.length) return

    const start = buffered.start(0)
    const keepFrom = video.currentTime - (aggressive ? 1 : BUFFER_BEHIND_SECONDS)

    if (keepFrom > start + 1) {
      try {
        sourceBuffer.remove(start, keepFrom)
      } catch {
        // A remove() racing an append is harmless — the next updateend retries.
      }
    }
  }

  /**
   * Live streams accumulate lag whenever the tab is backgrounded or a decode hiccups.
   *
   * Seeking to the live edge fixes that but is visible as a hitch, so ordinary drift is
   * absorbed by playing ~6% fast until the buffer is back to target — inaudible, and the
   * picture never jumps. Seeking is kept for the case where we're so far out that catching
   * up gradually would take longer than the drift itself.
   */
  const syncToLiveEdge = () => {
    const buffered = video.buffered
    if (!buffered.length) return

    const end = buffered.end(buffered.length - 1)
    const start = buffered.start(0)

    if (video.currentTime < start) {
      // Playhead fell behind evicted media — it would stall here forever.
      video.currentTime = start
      return
    }

    // Only chase the edge while actually playing; seeking a paused element just races
    // the play() we're about to issue.
    if (video.paused) return

    const lag = end - video.currentTime

    if (lag > MAX_LAG_SECONDS) {
      video.currentTime = Math.max(start, end - TARGET_LATENCY_SECONDS)
      video.playbackRate = 1
    } else if (lag > TARGET_LATENCY_SECONDS + DEADBAND_SECONDS) {
      video.playbackRate = CATCHUP_RATE
    } else if (lag < MIN_BUFFER_SECONDS) {
      // Running on fumes. Easing off buys the next chunk time to arrive, which is far less
      // visible than letting the buffer hit zero and stalling the element outright.
      video.playbackRate = SLOWDOWN_RATE
    } else if (video.playbackRate !== 1) {
      video.playbackRate = 1
    }
  }

  const reportStats = () => {
    const buffered = video.buffered
    const ahead = buffered.length ? buffered.end(buffered.length - 1) - video.currentTime : 0
    stats.bufferedSeconds = ahead

    // The newest buffered media was captured at newestCapturedAt, and the playhead sits
    // `ahead` seconds behind it — so what's on screen right now is that much older again.
    stats.latencyMs = newestCapturedAt
      ? Math.max(0, Date.now() - newestCapturedAt + ahead * 1000)
      : undefined

    onStats({ ...stats })
  }

  // ── Ordering ────────────────────────────────────────────────────────────────────────

  const enqueue = (chunk: StreamChunk) => {
    lastSeq = chunk.seq

    let bytes = chunk.bytes

    // The init segment is a header with no frames in it, so whatever we append next has to
    // begin at a real cluster boundary — and chunks are cut mid-cluster. Skip forward to one,
    // discarding chunks entirely until we find it. Only happens once, at join.
    if (!chunk.isInit && needsClusterStart) {
      const start = findClusterStart(bytes)
      if (start === null) {
        stats.resyncDropped++
        reportStats()
        return
      }
      bytes = bytes.subarray(start)
      needsClusterStart = false
    }

    stats.chunks++
    stats.bytesReceived += chunk.bytes.length
    if (chunk.capturedAt) newestCapturedAt = chunk.capturedAt
    queue.push(bytes)
    pump()
    reportStats()
  }

  const flushPending = (drainAll = false) => {
    pending.sort((a, b) => a.seq - b.seq)

    // Hold JITTER_CHUNKS back so a chunk that arrives out of order still has a chance to
    // slot into place ahead of its successor.
    while (pending.length > (drainAll ? 0 : JITTER_CHUNKS)) {
      const chunk = pending.shift()!
      if (chunk.seq <= lastSeq) {
        stats.droppedLate++
        continue
      }
      enqueue(chunk)
    }

    clearTimeout(flushTimer)
    if (pending.length) flushTimer = setTimeout(() => flushPending(true), JITTER_FLUSH_MS)
  }

  const onChunk = (chunk: StreamChunk) => {
    if (!initialized) {
      // Nothing is decodable until the header lands, so ignore everything before it.
      if (!chunk.isInit) return

      initialized = true
      lastSeq = chunk.seq
      needsClusterStart = true
      attachMediaSource(chunk.mimeType)
      enqueue(chunk)
      return
    }

    if (chunk.isInit) return // periodic re-broadcast; we already have the header
    if (chunk.seq <= lastSeq) {
      stats.droppedLate++
      return
    }

    pending.push(chunk)
    flushPending()
  }

  // ── Subscription ────────────────────────────────────────────────────────────────────

  let close: (() => void) | undefined

  void (async () => {
    try {
      const relay = await getRelay()
      if (stopped) return

      const sub = relay.subscribe([{ kinds: [STREAM_KIND], '#t': [streamId] }], {
        onevent(event) {
          // bucket.coracle.social keeps events for 30s and replays them on subscribe. That
          // backlog is history, not live video — skip it and join at the current edge.
          if (!live || stopped) return
          if (seenEventIds.has(event.id)) return
          // Sequence numbers are the real dedup mechanism; this set only catches duplicates
          // that arrive before the reordering buffer drains, so it can be dropped wholesale.
          if (seenEventIds.size > 5000) seenEventIds.clear()
          seenEventIds.add(event.id)

          const chunk = parseChunkEvent(event)
          if (chunk) onChunk(chunk)
        },
        oneose() {
          live = true
          if (!stopped && !initialized) onStatus('waiting')
        },
        onclose(reason) {
          if (!stopped) onStatus('error', `Relay closed the subscription: ${reason}`)
        },
      })

      close = () => sub.close()
    } catch (error) {
      if (!stopped) onStatus('error', error instanceof Error ? error.message : String(error))
    }
  })()

  return {
    resume() {
      awaitingGesture = false
      ensurePlaying()
    },
    stop() {
      stopped = true
      clearTimeout(flushTimer)
      close?.()

      if (mediaSource?.readyState === 'open') {
        try {
          mediaSource.endOfStream()
        } catch {
          // Already torn down.
        }
      }

      video.removeAttribute('src')
      video.load()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    },
  }
}
