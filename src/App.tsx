import { createSignal, Match, onCleanup, Switch } from 'solid-js'
import Broadcaster from './Broadcaster'
import Viewer from './Viewer'
import { RELAY_URL, STREAM_KIND } from './config'

type Route = {
  name: 'home' | 'broadcast' | 'watch'
  streamId: string
}

function parseHash(): Route {
  const [mode, streamId] = location.hash.replace(/^#\/?/, '').split('/')

  if (mode === 'b' && streamId) return { name: 'broadcast', streamId }
  if (mode === 'w' && streamId) return { name: 'watch', streamId }

  return { name: 'home', streamId: '' }
}

export default function App() {
  const [route, setRoute] = createSignal(parseHash())

  const onHashChange = () => setRoute(parseHash())
  window.addEventListener('hashchange', onHashChange)
  onCleanup(() => window.removeEventListener('hashchange', onHashChange))

  return (
    <div class="app">
      <header>
        <a class="brand" href="#/">
          nvid
        </a>
        <span class="tagline">
          live a/v over nostr · kind {STREAM_KIND} · {RELAY_URL.replace('wss://', '')}
        </span>
      </header>

      <main>
        <Switch>
          <Match when={route().name === 'home'}>
            <Home />
          </Match>
          <Match when={route().name === 'broadcast'}>
            <Broadcaster streamId={route().streamId} />
          </Match>
          <Match when={route().name === 'watch'}>
            <Viewer streamId={route().streamId} />
          </Match>
        </Switch>
      </main>
    </div>
  )
}

function Home() {
  const [watchId, setWatchId] = createSignal('')

  const startBroadcast = () => {
    const streamId = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
    location.hash = `#/b/${streamId}`
  }

  const watch = (event: SubmitEvent) => {
    event.preventDefault()
    const id = watchId().trim()
    if (id) location.hash = `#/w/${id}`
  }

  return (
    <div class="home">
      <section class="card">
        <h2>Broadcast</h2>
        <p>
          Capture your camera, mic, or screen and publish it to the relay as a series of
          ephemeral events.
        </p>
        <button class="primary" onClick={startBroadcast}>
          Start a broadcast
        </button>
      </section>

      <section class="card">
        <h2>Watch</h2>
        <p>Enter a stream ID to subscribe and reassemble it back into playable media.</p>
        <form onSubmit={watch}>
          <input
            value={watchId()}
            onInput={event => setWatchId(event.currentTarget.value)}
            placeholder="stream id"
            spellcheck={false}
            autocapitalize="off"
          />
          <button type="submit" disabled={!watchId().trim()}>
            Watch
          </button>
        </form>
      </section>
    </div>
  )
}
