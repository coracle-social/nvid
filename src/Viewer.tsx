import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import { startPlayback, type Playback, type PlaybackStats, type PlaybackStatus } from './playback'
import { formatBytes } from './format'

const STATUS_TEXT: Record<PlaybackStatus, string> = {
  connecting: 'Connecting to relay…',
  waiting: 'Waiting for the next init segment…',
  buffering: 'Buffering…',
  playing: 'Playing',
  error: 'Error',
}

export default function Viewer(props: { streamId: string }) {
  const [status, setStatus] = createSignal<PlaybackStatus>('connecting')
  const [detail, setDetail] = createSignal('')
  const [stats, setStats] = createSignal<PlaybackStats>()
  const [needsGesture, setNeedsGesture] = createSignal(false)
  const [playback, setPlayback] = createSignal<Playback>()

  let videoRef: HTMLVideoElement | undefined

  createEffect(() => {
    const streamId = props.streamId
    if (!videoRef) return

    setStatus('connecting')
    setDetail('')
    setStats(undefined)
    setNeedsGesture(false)

    const instance = startPlayback({
      streamId,
      video: videoRef,
      onStatus: (next, why) => {
        setStatus(next)
        setDetail(why ?? '')
      },
      onStats: setStats,
      onNeedsGesture: () => setNeedsGesture(true),
    })

    setPlayback(instance)
    onCleanup(() => instance.stop())
  })

  const play = () => {
    playback()?.resume()
    setNeedsGesture(false)
  }

  return (
    <div class="stage">
      <div class="video-wrap">
        {/* No autoplay attribute: playback starts from ensurePlaying once a cushion exists. */}
        <video ref={videoRef} playsinline controls={false} />

        <Show when={status() !== 'playing'}>
          <div class="overlay">
            <Show when={status() !== 'error'} fallback={<p class="error">{detail()}</p>}>
              <div class="spinner" />
              <p>{STATUS_TEXT[status()]}</p>
            </Show>
          </div>
        </Show>

        <Show when={needsGesture()}>
          <button class="unmute" onClick={play}>
            ▶ Tap to play
          </button>
        </Show>
      </div>

      <div class="panel">
        <label class="field">
          <span>Stream ID</span>
          <code class="stream-id">{props.streamId}</code>
        </label>

        <label class="field">
          <span>Status</span>
          <strong classList={{ ok: status() === 'playing', bad: status() === 'error' }}>
            {STATUS_TEXT[status()]}
          </strong>
        </label>

        <dl class="stats">
          <div>
            <dt>Chunks</dt>
            <dd>{stats()?.chunks ?? 0}</dd>
          </div>
          <div>
            <dt>Received</dt>
            <dd>{formatBytes(stats()?.bytesReceived ?? 0)}</dd>
          </div>
          <div>
            <dt>Latency</dt>
            <dd>
              {stats()?.latencyMs === undefined
                ? '—'
                : `${(stats()!.latencyMs! / 1000).toFixed(2)}s`}
            </dd>
          </div>
          <div>
            <dt>Buffer</dt>
            <dd>{(stats()?.bufferedSeconds ?? 0).toFixed(1)}s</dd>
          </div>
          <div>
            <dt>Late/dupe</dt>
            <dd>{stats()?.droppedLate ?? 0}</dd>
          </div>
        </dl>

        <p class="hint">
          Playback joins at the live edge. The relay's 30s backlog is skipped, so nothing
          renders until the broadcaster's next init segment lands. Latency assumes both
          machines' clocks agree.
        </p>
      </div>
    </div>
  )
}
