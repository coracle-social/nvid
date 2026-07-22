import { createSignal, onCleanup, Show } from 'solid-js'
import { startBroadcast, type Broadcast, type BroadcastStats } from './broadcast'
import {
  CAPTURE_FPS,
  CAPTURE_HEIGHT,
  CAPTURE_WIDTH,
  RELAY_BUDGET_BYTES_PER_SEC,
  SCREEN_FPS,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  TIMESLICE_MS,
} from './config'
import { formatBytes } from './format'

type Source = 'camera' | 'screen' | 'mic'

const SOURCES: { value: Source; label: string }[] = [
  { value: 'camera', label: 'Camera + mic' },
  { value: 'screen', label: 'Screen' },
  { value: 'mic', label: 'Mic only' },
]

// Capture small. Asking the encoder to squeeze 720p into the relay's throughput budget just
// spends every bit on artefacts — better to send fewer, cleaner pixels.
const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: CAPTURE_WIDTH },
  height: { ideal: CAPTURE_HEIGHT },
  frameRate: { ideal: CAPTURE_FPS },
}

// Screen shares get more pixels and fewer frames than a camera: desktop content is mostly
// static, but illegible text makes the whole thing pointless. `max` rather than `ideal` —
// getDisplayMedia treats `ideal` as a suggestion and will hand back a full 1440p monitor.
const SCREEN_CONSTRAINTS: MediaTrackConstraints = {
  width: { max: SCREEN_WIDTH },
  height: { max: SCREEN_HEIGHT },
  frameRate: { max: SCREEN_FPS },
}

async function capture(source: Source): Promise<MediaStream> {
  switch (source) {
    case 'camera':
      return navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS, audio: true })

    case 'screen': {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: SCREEN_CONSTRAINTS,
        audio: true,
      })

      // getDisplayMedia routinely ignores sizing on the initial request and returns the
      // native monitor resolution regardless, so re-assert it on the track.
      //
      // Deliberately not awaited: applyConstraints on a *display-capture* track is unreliable
      // across platforms and can settle late or not at all. Awaiting it meant a screen share
      // could hang here forever — capture() never resolved, the recorder was never created,
      // and the broadcast never even opened its relay connection. Best effort only; the
      // adaptive frame-rate guard is the real backstop.
      void stream.getVideoTracks()[0]?.applyConstraints(SCREEN_CONSTRAINTS).catch(() => {})

      return stream
    }

    case 'mic':
      return navigator.mediaDevices.getUserMedia({ audio: true })
  }
}

export default function Broadcaster(props: { streamId: string }) {
  const [source, setSource] = createSignal<Source>('camera')
  const [broadcast, setBroadcast] = createSignal<Broadcast>()
  const [stats, setStats] = createSignal<BroadcastStats>()
  const [error, setError] = createSignal('')
  const [copied, setCopied] = createSignal(false)

  let videoRef: HTMLVideoElement | undefined
  let previewStream: MediaStream | undefined

  const watchUrl = () => `${location.origin}${location.pathname}#/w/${props.streamId}`

  const start = async () => {
    setError('')

    try {
      const stream = await capture(source())
      previewStream = stream

      if (videoRef) {
        videoRef.srcObject = stream
        void videoRef.play().catch(() => {})
      }

      // Ending the share from the browser's own UI should tear the broadcast down too.
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', stop)
      }

      setBroadcast(
        startBroadcast({
          streamId: props.streamId,
          stream,
          onStats: setStats,
          onError: setError,
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const stop = () => {
    broadcast()?.stop()
    setBroadcast(undefined)

    if (videoRef) videoRef.srcObject = null
    previewStream?.getTracks().forEach(track => track.stop())
    previewStream = undefined
  }

  const copyLink = async () => {
    await navigator.clipboard.writeText(watchUrl())
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  onCleanup(stop)

  const eventsPerSecond = (1000 / TIMESLICE_MS).toFixed(1)

  return (
    <div class="stage">
      <div class="video-wrap">
        <video ref={videoRef} muted playsinline autoplay />
        <Show when={!broadcast()}>
          <div class="overlay">
            <p>Pick a source and go live.</p>
          </div>
        </Show>
        <Show when={broadcast()}>
          <div class="badge live">LIVE</div>
        </Show>
      </div>

      <div class="panel">
        <label class="field">
          <span>Stream ID</span>
          <code class="stream-id">{props.streamId}</code>
        </label>

        <label class="field">
          <span>Source</span>
          <select
            value={source()}
            disabled={!!broadcast()}
            onChange={event => setSource(event.currentTarget.value as Source)}
          >
            {SOURCES.map(option => (
              <option value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        <Show
          when={broadcast()}
          fallback={
            <button class="primary" onClick={start}>
              Go live
            </button>
          }
        >
          <button class="danger" onClick={stop}>
            Stop broadcasting
          </button>
        </Show>

        <button class="secondary" onClick={copyLink}>
          {copied() ? 'Copied' : 'Copy watch link'}
        </button>

        <Show when={broadcast()}>
          {handle => (
            <dl class="stats">
              <div>
                <dt>Relay</dt>
                <dd classList={{ ok: stats()?.connected, bad: stats() && !stats()!.connected }}>
                  {stats()?.connected ? 'connected' : 'connecting…'}
                </dd>
              </div>
              <div>
                <dt>Codec</dt>
                <dd>{handle().mimeType}</dd>
              </div>
              <div>
                <dt>Events</dt>
                <dd>
                  {stats()?.chunks ?? 0} <span class="dim">(~{eventsPerSecond}/s)</span>
                </dd>
              </div>
              <div>
                <dt>Last event</dt>
                <dd>{formatBytes(stats()?.lastChunkBytes ?? 0)}</dd>
              </div>
              <div>
                <dt>Wire rate</dt>
                <dd classList={{ bad: stats()?.overBudget, ok: stats() && !stats()!.overBudget }}>
                  {formatBytes(stats()?.bytesPerSecond ?? 0)}/s
                  <span class="dim"> / {formatBytes(RELAY_BUDGET_BYTES_PER_SEC)}</span>
                </dd>
              </div>
              <div>
                <dt>Failed</dt>
                <dd classList={{ bad: !!stats()?.failed }}>{stats()?.failed ?? 0}</dd>
              </div>
              <Show when={stats()?.captureFps}>
                <div>
                  <dt>Capture</dt>
                  <dd>{stats()!.captureFps} fps</dd>
                </div>
              </Show>
              <div>
                <dt>Total sent</dt>
                <dd>{formatBytes(stats()?.bytesSent ?? 0)}</dd>
              </div>
            </dl>
          )}
        </Show>

        <Show when={stats()?.overBudget}>
          <p class="error">
            Over the relay's throughput budget — it drops long runs of events rather than
            degrading gracefully. Lower VIDEO_BITRATE in config.ts.
          </p>
        </Show>

        <Show when={error()}>
          <p class="error">{error()}</p>
        </Show>
      </div>
    </div>
  )
}
