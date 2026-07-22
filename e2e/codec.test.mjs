/**
 * Cross-browser codec-selection regression test.
 *
 * The bug this exists for: pickMimeType chose `video/webm;codecs=vp8,opus` whenever a video
 * track was present, ignoring whether the stream had audio. Firefox honours that literally —
 * isTypeSupported returns true, the recorder reports state "recording", and it emits nothing
 * at all, with no error. Chromium silently drops the impossible codec and records anyway, so
 * a Chromium-only test suite called it healthy while Firefox screen sharing was dead.
 *
 * Asserting isTypeSupported is not enough — Firefox returns true for the broken combination.
 * The only assertion that catches it is "bytes actually came out".
 *
 *   pnpm test:codec
 */
import { chromium, firefox } from 'playwright'
import { createServer } from 'vite'

const LAYOUTS = [
  { name: 'video + audio', video: true, audio: true },
  { name: 'video only    ', video: true, audio: false }, // a Firefox screen share
  { name: 'audio only    ', video: false, audio: true },
]

// configFile: false — the fixture only needs TS transforms, not the app's plugins, and
// inheriting vite.config.ts drags in its fixed port. Read the *resolved* URL rather than the
// configured one: with a port already taken, Vite picks another and config.server.port still
// reports the original, which silently points the test at whatever else is running there.
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { port: 0 },
  logLevel: 'error',
})
await vite.listen()
const origin = vite.resolvedUrls.local[0].replace(/\/$/, '')

const failures = []

const skipped = []

async function check(browserName, launcher, launchOptions) {
  let browser
  try {
    browser = await launcher.launch(launchOptions)
  } catch (error) {
    // Don't fail the suite because a browser is unavailable in this environment — but say so
    // loudly, because silent single-browser coverage is exactly how this bug shipped.
    console.log(`\n=== ${browserName} === SKIPPED: ${error.message.split('\n')[0]}`)
    skipped.push(browserName)
    return
  }

  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`${origin}/e2e/codec-fixture.html`)
  await page.waitForFunction(() => window.fixtureReady)

  console.log(`\n=== ${browserName} ===`)
  console.log('layout           chosen mime                      data events   bytes')

  for (const layout of LAYOUTS) {
    const result = await page.evaluate(async ({ video, audio }) => {
      // Synthesise a stream with exactly the requested track layout, no devices involved.
      const stream = new MediaStream()

      if (video) {
        const canvas = document.createElement('canvas')
        canvas.width = 320
        canvas.height = 180
        const context2d = canvas.getContext('2d')
        let hue = 0
        setInterval(() => {
          context2d.fillStyle = `hsl(${(hue += 11) % 360} 80% 50%)`
          context2d.fillRect(0, 0, 320, 180)
        }, 60)
        for (const track of canvas.captureStream(10).getVideoTracks()) stream.addTrack(track)
      }

      if (audio) {
        const audioContext = new AudioContext()
        const oscillator = audioContext.createOscillator()
        const destination = audioContext.createMediaStreamDestination()
        oscillator.connect(destination)
        oscillator.start()
        for (const track of destination.stream.getAudioTracks()) stream.addTrack(track)
      }

      const mime = window.pickMimeType(stream)
      if (!mime) return { mime: null }

      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 90_000 })
      let events = 0
      let bytes = 0
      recorder.ondataavailable = event => {
        events++
        bytes += event.data.size
      }
      recorder.start(250)
      await new Promise(resolve => setTimeout(resolve, 2500))
      const state = recorder.state
      try {
        recorder.stop()
      } catch {}
      for (const track of stream.getTracks()) track.stop()

      return { mime, events, bytes, state }
    }, layout)

    const ok = result.mime && result.bytes > 0
    console.log(
      `${layout.name}   ${String(result.mime ?? '(none)').padEnd(32)} ` +
        `${String(result.events ?? 0).padStart(6)}   ${String(result.bytes ?? 0).padStart(7)}  ` +
        `${ok ? '✓' : '✗'}`,
    )

    if (!ok) {
      failures.push(
        `${browserName} / ${layout.name.trim()}: chose ${result.mime ?? '(none)'} but produced ` +
          `${result.bytes ?? 0} bytes`,
      )
    }
  }

  await browser.close()
}

try {
  await check('chromium', chromium, {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  })
  // Firefox is the browser that actually catches this class of bug. SKIP_FIREFOX=1 exists for
  // environments that can't launch it, not as a convenience.
  if (!process.env.SKIP_FIREFOX) await check('firefox', firefox, {})
  else skipped.push('firefox (SKIP_FIREFOX set)')
} finally {
  await vite.close()
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} failure(s)`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exitCode = 1
} else if (skipped.length) {
  console.log(`\n✓ every track layout records — but NOT verified in: ${skipped.join(', ')}`)
} else {
  console.log('\n✓ every track layout records in both browsers')
}
