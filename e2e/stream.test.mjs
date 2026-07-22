/**
 * End-to-end proof: one page broadcasts synthetic media through the live relay, a second page
 * subscribes and reassembles it. Passes only if the viewer's element decodes real bytes and
 * its playback clock advances.
 *
 * The viewer always opens *after* the broadcast is underway, so this also covers the
 * late-joiner path — it never sees chunk 0 live and must bootstrap off a replayed init segment.
 *
 *   pnpm build && pnpm test:e2e
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

const DIST = new URL('../dist/', import.meta.url).pathname
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

const server = createServer(async (req, res) => {
  const path = req.url === '/' || req.url.startsWith('/#') ? '/index.html' : req.url.split('?')[0]
  try {
    const body = await readFile(join(DIST, path))
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})
await new Promise(resolve => server.listen(0, resolve))
const origin = `http://localhost:${server.address().port}`

const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream', // synthetic spinning-ball camera + beeping mic
    '--use-fake-ui-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen', // makes getDisplayMedia non-interactive
    '--autoplay-policy=no-user-gesture-required',
    // The broadcaster tab is backgrounded as soon as the viewer opens; without these,
    // Chromium throttles its timers and starves the stream. Real users have theirs focused.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
})

const failures = []
const fail = message => {
  console.error(`  ✗ ${message}`)
  failures.push(message)
}

async function runScenario({ label, source, expectVideo }) {
  console.log(`\n▸ ${label}`)

  const streamId = 'e2e' + Math.random().toString(36).slice(2, 9)
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] })

  try {
    const broadcaster = await context.newPage()
    broadcaster.on('console', m => m.type() === 'error' && console.log('  [bc]', m.text()))
    await broadcaster.goto(`${origin}/#/b/${streamId}`)
    await broadcaster.locator('select').selectOption(source)
    await broadcaster.getByRole('button', { name: 'Go live' }).click()

    await broadcaster.locator('.stats').waitFor({ timeout: 15_000 })
    await broadcaster.waitForFunction(
      // The events cell reads like "8 (~2.0/s)", so parse the leading integer.
      () =>
        parseInt(
          document.querySelectorAll('.stats > div')[1]?.querySelector('dd')?.innerText ?? '',
          10,
        ) >= 4,
      { timeout: 25_000 },
    )

    const codec = await broadcaster.locator('.stats > div:nth-child(1) dd').innerText()
    const sent = await broadcaster.locator('.stats > div:nth-child(2) dd').innerText()
    console.log(`  broadcaster: ${codec.trim()} · ${sent.trim()} events`)

    const viewer = await context.newPage()
    viewer.on('console', m => m.type() === 'error' && console.log('  [vw]', m.text()))
    await viewer.goto(`${origin}/#/w/${streamId}`)

    await viewer.getByText('Playing').first().waitFor({ timeout: 25_000 })

    await viewer.waitForFunction(
      wantVideo => {
        const v = document.querySelector('video')
        return v && v.readyState >= 2 && (!wantVideo || v.videoWidth > 0)
      },
      expectVideo,
      { timeout: 25_000 },
    )

    const first = await viewer.evaluate(() => {
      const v = document.querySelector('video')
      return { w: v.videoWidth, h: v.videoHeight, t: v.currentTime }
    })

    // Sample over a sustained window. The relay's throughput ceiling only bites after ~20s
    // of publishing, so a 4s check would have called the old, badly over-budget build healthy.
    const SAMPLES = 12
    const INTERVAL = 2_000
    const timeline = []
    for (let i = 0; i < SAMPLES; i++) {
      await viewer.waitForTimeout(INTERVAL)
      timeline.push(
        await viewer.evaluate(() => {
          const v = document.querySelector('video')
          const cells = document.querySelectorAll('.stats > div')
          const latency = [...cells].find(d => d.querySelector('dt')?.innerText === 'Latency')
          return {
            t: v.currentTime,
            buf: v.buffered.length ? v.buffered.end(v.buffered.length - 1) - v.currentTime : 0,
            rate: v.playbackRate,
            latency: parseFloat(latency?.querySelector('dd')?.innerText ?? 'NaN'),
          }
        }),
      )
    }

    const last = await viewer.evaluate(() => {
      const v = document.querySelector('video')
      return {
        t: v.currentTime,
        paused: v.paused,
        // Chrome-only counters, but they're the only way to prove the tracks really decoded
        // rather than just being appended to the SourceBuffer.
        audioBytes: v.webkitAudioDecodedByteCount,
        videoBytes: v.webkitVideoDecodedByteCount,
      }
    })

    // A stall is a 2s wall-clock window in which playback advanced less than half a second.
    let stalls = 0
    for (let i = 1; i < timeline.length; i++) {
      if (timeline[i].t - timeline[i - 1].t < 0.5) stalls++
    }
    const minBuf = Math.min(...timeline.map(s => s.buf))
    const elapsed = (SAMPLES * INTERVAL) / 1000
    const advanced = last.t - first.t

    const received = (await viewer.locator('.stats > div:nth-child(1) dd').innerText()).trim()
    const wireRate = (await broadcaster.locator('.stats > div:nth-child(4) dd').innerText()).trim()
    const failed = parseInt(
      await broadcaster.locator('.stats > div:nth-child(5) dd').innerText(),
      10,
    )

    const dimensions = expectVideo ? `${first.w}x${first.h}` : 'audio-only'
    console.log(`  broadcaster wire rate ${wireRate.replace(/\s+/g, ' ')} · failed publishes ${failed}`)
    console.log(`  viewer received ${received} chunks · ${dimensions}`)
    const latencies = timeline.map(s => s.latency).filter(Number.isFinite)
    const medianLatency = latencies.sort((a, b) => a - b)[latencies.length >> 1]
    const maxLatency = latencies.at(-1)

    console.log(
      `  playback advanced ${advanced.toFixed(1)}s over ${elapsed}s wall ` +
        `(${((advanced / elapsed) * 100).toFixed(0)}%) · stalls ${stalls}/${SAMPLES - 1} · ` +
        `min buffer ${minBuf.toFixed(2)}s`,
    )
    console.log(
      `  end-to-end latency: median ${medianLatency?.toFixed(2)}s · max ${maxLatency?.toFixed(2)}s`,
    )
    console.log(`  decoded video=${last.videoBytes}B audio=${last.audioBytes}B`)

    if (last.paused) fail(`${label}: element is paused`)
    if (!last.audioBytes) fail(`${label}: no audio decoded`)
    if (expectVideo && !last.videoBytes) fail(`${label}: no video decoded`)
    if (expectVideo && first.w === 0) fail(`${label}: no video frames`)
    if (failed > 0) fail(`${label}: ${failed} publishes were never acked by the relay`)
    // Real-time playback should track wall clock closely; the catch-up rate is only 1.06.
    if (advanced < elapsed * 0.85) {
      fail(`${label}: playback fell behind wall clock (${advanced.toFixed(1)}s / ${elapsed}s)`)
    }
    if (stalls > 1) fail(`${label}: ${stalls} stalls during playback`)
    // Latency is the thing smoothness fixes are always tempted to trade away, so pin it.
    if (!Number.isFinite(medianLatency)) fail(`${label}: no latency measurement`)
    else if (medianLatency > 1.5) fail(`${label}: median latency ${medianLatency.toFixed(2)}s > 1.5s`)
    // Growing latency means the buffer is filling faster than it drains — a slow drift the
    // median wouldn't catch on its own.
    else if (maxLatency > 2.5) fail(`${label}: latency peaked at ${maxLatency.toFixed(2)}s`)
    if (!failures.length) console.log('  ✓ ok')
  } catch (error) {
    fail(`${label}: ${error.message.split('\n')[0]}`)
    // Dump what the viewer thought was going on, so a timeout says *why* rather than just that.
    for (const page of context.pages()) {
      const panel = await page.locator('.panel').innerText().catch(() => null)
      if (panel) console.log('  panel:\n' + panel.split('\n').map(l => '      ' + l).join('\n'))
      const media = await page
        .evaluate(() => {
          const v = document.querySelector('video')
          if (!v) return null
          return {
            paused: v.paused,
            readyState: v.readyState,
            ranges: v.buffered.length,
            buffered: v.buffered.length ? +(v.buffered.end(v.buffered.length - 1) - v.buffered.start(0)).toFixed(2) : 0,
            currentTime: +v.currentTime.toFixed(2),
            error: v.error?.message ?? null,
          }
        })
        .catch(() => null)
      if (media) console.log('  media: ' + JSON.stringify(media))
    }
  } finally {
    await context.close()
  }
}

try {
  // ONLY=camera / ONLY=mic narrows the run when chasing an intermittent failure.
  const only = process.env.ONLY
  if (!only || only === 'camera') {
    await runScenario({ label: 'camera + mic', source: 'camera', expectVideo: true })
  }
  if (!only || only === 'mic') {
    await runScenario({ label: 'mic only', source: 'mic', expectVideo: false })
  }
  if (!only || only === 'screen') {
    await runScenario({ label: 'screen', source: 'screen', expectVideo: true })
  }
} finally {
  await browser.close()
  server.close()
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} failure(s)`)
  process.exitCode = 1
} else {
  console.log('\n✓ live a/v round-tripped through bucket.coracle.social')
}
