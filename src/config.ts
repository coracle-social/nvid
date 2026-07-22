export const RELAY_URL = 'wss://bucket.coracle.social'

/** Ephemeral kind (20000–29999), so relays relay-and-forget rather than archiving a stream. */
export const STREAM_KIND = 25845

/**
 * How often MediaRecorder hands us a chunk — a direct term in end-to-end latency. Measured
 * against the relay at a fixed ~19 KB/s, varying only the event rate:
 *
 *   2/s (500ms) → 100% delivered, relay latency p50 152ms / p95 175ms
 *   4/s (250ms) → 100% delivered, p50 130ms / p95 142ms
 *   5/s (200ms) → 100% delivered, p50 144ms / p95 800ms
 *   8/s (125ms) → 100% delivered, p50 149ms / p95 237ms
 *
 * Event rate is not the constraint; bytes/sec is. 250ms halves the timeslice contribution
 * versus 500ms and measured cleanest.
 */
export const TIMESLICE_MS = 250

/**
 * The codec init segment is the only thing a late joiner can't decode without, so we
 * re-broadcast it on this interval. It bounds how long "click watch" takes to show video.
 * Cheap now that it's header-only (~200 B) rather than a whole media chunk.
 */
export const INIT_REPUBLISH_MS = 1000

/**
 * THE constraint on this design. Measured against bucket.coracle.social by publishing at
 * fixed rates and counting what a second connection received:
 *
 *   10.7 KB/s → 100% delivered over 1045 KB
 *   16.0 KB/s → 100% delivered
 *   21.3 KB/s → 100% delivered
 *   32.0 KB/s → 100% delivered over 1584 KB
 *   42.7 KB/s → publishes start timing out at 1024 KB; 17 consecutive events lost, 11s latency
 *
 * So the relay carries ~32 KB/s of base64 content and falls over somewhere before 43. The
 * encoder targets below are sized to sit near 20 KB/s on the wire, leaving real headroom —
 * exceeding this doesn't degrade gracefully, it drops long runs of events.
 */
export const RELAY_BUDGET_BYTES_PER_SEC = 24 * 1024

/**
 * Encoder targets, chosen to fit RELAY_BUDGET after base64's 4/3 inflation:
 * (90k video + 24k audio) / 8 * 1.34 ≈ 19 KB/s.
 *
 * Generic compression is not an option here — gzip/brotli/zstd recover ~2% from VP8/Opus
 * payloads (measured: per-chunk gzip = 97.8% of raw), which base64 immediately gives back.
 * The only lever that moves the number is encoding fewer bits in the first place.
 */
export const VIDEO_BITRATE = 90_000
export const AUDIO_BITRATE = 24_000

/** Capture constraints. 320x180@15 is what ~90 kbps of VP8 can carry without mushing. */
export const CAPTURE_WIDTH = 320
export const CAPTURE_HEIGHT = 180
export const CAPTURE_FPS = 15

/**
 * A chunk over this is dropped rather than silently rejected by the relay. Well under the
 * ~800 KB the relay accepts, and far above a normal chunk at the bitrates above.
 */
export const MAX_EVENT_BYTES = 256 * 1024

/**
 * Chunks held back to reorder out-of-order relay delivery — and measured across 750+ events
 * at four different rates, the relay reordered exactly zero of them. A subscription is one
 * websocket, so TCP already guarantees order. Holding chunks back here bought nothing and
 * cost JITTER * TIMESLICE of pure latency, on top of the SourceBuffer depth below, which is
 * the buffer that actually absorbs jitter.
 *
 * The reordering machinery is kept (a reconnect or a different relay could reorder) but at
 * zero depth it's a passthrough.
 */
export const JITTER_CHUNKS = 0

/** If no chunk arrives for this long, flush the jitter buffer so the tail isn't stranded. */
export const JITTER_FLUSH_MS = 1200

/**
 * Buffer depth playback aims to hold — the largest single term in end-to-end latency, so it
 * buys smoothness directly at the user's expense. It has to stay comfortably above the
 * TIMESLICE_MS sawtooth or the drift controller fires on every append and saws the buffer
 * down to nothing; at a 250ms timeslice, ~2.5 chunks of depth is enough to regulate around.
 */
export const TARGET_LATENCY_SECONDS = 0.6

/**
 * Drift correction. Seeking to the live edge is visible as a hitch, so ordinary lag is
 * absorbed by playing fractionally fast instead; seeking is reserved for being badly out.
 * DEADBAND has to comfortably exceed the sawtooth or the controller oscillates.
 */
export const CATCHUP_RATE = 1.06
export const DEADBAND_SECONDS = 0.4
/** The other half of the same idea: stretch a thin buffer rather than let it underrun. */
export const SLOWDOWN_RATE = 0.96
export const MIN_BUFFER_SECONDS = 0.2
export const MAX_LAG_SECONDS = 2

/**
 * Cushion to accumulate before starting playback. Starting on the first chunk means running
 * at ~0s of buffer forever — SLOWDOWN_RATE can only claw back 4% per second, so a stream that
 * starts empty stays empty. Cheaper to wait once up front, but this is startup delay the
 * viewer feels, so keep it near the steady-state target rather than above it.
 */
export const PREBUFFER_SECONDS = 0.4
/** ...but never wait longer than this for it, however slowly media is arriving. */
export const PREBUFFER_TIMEOUT_MS = 3000

/** How much already-played media to keep in the SourceBuffer before evicting it. */
export const BUFFER_BEHIND_SECONDS = 10
