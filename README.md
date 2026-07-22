# nvid

Proof-of-concept live audio/video streaming over nostr. A browser captures camera/mic/screen,
slices the encoded stream into ephemeral events, and publishes them to a relay; other browsers
subscribe and reassemble the byte stream back into playable media via MediaSource.

Stack: pnpm · SolidJS · Vite · nostr-tools. Relay: `wss://bucket.coracle.social`.

```bash
pnpm install
pnpm dev          # http://localhost:5173
```

Open the app, hit **Start a broadcast**, **Go live**, then copy the watch link into another
tab or device.

## Wire format

```
kind:    25845                      ephemeral (20000–29999): relays forward and forget
content: base64 of one raw MediaRecorder chunk
tags:
  ["t",    <streamId>]              stream identifier — subscribers filter on #t
  ["i",    <seq>]                   monotonic chunk counter, decimal string
  ["init", "1"]                     only on the codec init segment (re-sent periodically)
  ["m",    <mimeType>]              e.g. video/webm;codecs=vp8,opus
  ["ts",   <ms>]                    capture wall-clock, for the viewer's latency readout
```

At the default 250ms timeslice that's ~4 events/sec and ~15 KB/s of base64 on the wire.

## Latency budget

Measured end-to-end (capture → on screen), median over a 24s window: **0.8–1.1s.**

| term | cost | notes |
|---|---|---|
| `TIMESLICE_MS` | 250ms | MediaRecorder won't emit a chunk sooner |
| relay round trip | ~150ms | measured p50 130ms, p95 142ms |
| `TARGET_LATENCY_SECONDS` | 600ms | SourceBuffer depth the drift controller holds |
| jitter buffer | 0ms | removed — see below |

The buffer depth is the only term that's a free choice, and it trades directly against
smoothness. Two traps worth knowing about, both of which this hit:

- **The JS jitter buffer was dead weight.** It held chunks back to reorder them, but across
  750+ events at four rates the relay reordered *exactly zero* — a subscription is one
  websocket, so TCP already guarantees order. It cost `JITTER_CHUNKS × TIMESLICE_MS` of pure
  latency on top of the SourceBuffer, which is the buffer actually absorbing jitter.
- **Smoothness fixes silently buy latency.** An earlier pass raised the buffer target to 2.0s
  and added a 1.2s startup cushion to kill stalls. It worked, and pushed end-to-end latency to
  ~3.7s. Nothing caught it because the test measured stalls but not latency — so the test now
  asserts on latency too.

## Throughput is the whole ballgame

The relay, not the codec, is the binding constraint. Publishing at fixed rates and counting
what a second connection received:

| wire rate | result |
|---|---|
| 10.7 KB/s | 100% delivered over 1045 KB |
| 16.0 KB/s | 100% delivered |
| 21.3 KB/s | 100% delivered |
| 32.0 KB/s | 100% delivered over 1584 KB |
| 42.7 KB/s | publishes time out at 1024 KB; **17 consecutive events lost**, 11s latency |

It's a rate limit, not a cumulative cap — the same 16KB payload sent 4× slower sailed past
1 MB cleanly. And it doesn't degrade gracefully: past the ceiling you lose long *runs* of
events, which is exactly what stuttering playback looks like.

Everything else follows from fitting under that line:

- **Compression doesn't help.** VP8/Opus payloads are already entropy-coded. Measured on real
  MediaRecorder output: per-chunk gzip lands at **97.8% of raw**, and base64 hands that 2%
  straight back. Whole-stream brotli/zstd reach ~93%, but each event is compressed
  independently so there's no shared dictionary to exploit. The only lever that moves the
  number is encoding fewer bits — hence 90 kbps video at 320x180@15.
- **The init segment is header-only.** It used to be MediaRecorder's entire first chunk;
  parsing the EBML showed only **189 of 6840 bytes** was the header a decoder actually needs.
  The rest was media riding along, re-sent every 2s, for nothing.

## How it works

`MediaRecorder` with a timeslice emits a WebM byte stream cut at arbitrary boundaries. Chunk 0
carries the EBML/codec header a decoder needs to initialize; every chunk after it is clusters.
That asymmetry drives most of the design:

- **Late joiners.** Someone tuning in at chunk 400 has no header and can decode nothing, so the
  broadcaster splits chunk 0 and re-publishes just the header every 2s (`INIT_REPUBLISH_MS`).
  That interval is the worst-case time-to-first-frame.
- **Cluster resync.** Timeslice chunks are cut on byte boundaries, not element boundaries —
  measured, every chunk after the first starts *mid-cluster*. Appending a partial cluster
  straight after a header-only init segment feeds the decoder garbage, so the viewer skips
  ahead to the first real Cluster boundary once, at join. (The old code got away with this by
  accident: its init segment carried whole clusters, so the decoder had frames before it ever
  saw a partial one.)
- **`sequence` mode.** The replayed init segment carries timestamps from the start of the
  broadcast, while the clusters following it are from now. `SourceBuffer.mode = 'sequence'` lays
  each appended group down end-to-end instead of honouring those timestamps, which would
  otherwise leave a stream-length hole in the timeline.
- **Reordering.** The viewer sorts on the `i` tag, but at `JITTER_CHUNKS = 0` that's a
  passthrough; the machinery is kept only because a reconnect or a different relay could
  reorder where this one measurably doesn't.
- **Smooth live edge.** Seeking to catch up is visible as a hitch, so drift is absorbed by
  nudging `playbackRate` (1.06 when the buffer is deep, 0.96 when it's thin) and seeking only
  when badly out. Playback also waits for a small cushion before starting — beginning on the
  first chunk leaves a stream running at zero buffer indefinitely, since a 4%/s correction
  can't build a cushion that was never there.
- **Eviction.** Media more than 10s behind the playhead is dropped so the SourceBuffer doesn't
  grow without bound.

Streams are addressed by their `t` tag, not by author, so each tab signs with a throwaway key
held in `sessionStorage`. A NIP-07 extension would mean a permission prompt per chunk.

### Relay behaviour

`bucket.coracle.social` describes itself as "a relay which only stores events for 30 seconds",
which suits a streaming PoC. Measured directly:

- Accepts events up to at least 800KB, but see the throughput table above — size per event is
  not the limit that bites.
- Does replay its 30s backlog to a fresh subscription, before EOSE. The viewer **discards
  everything until EOSE** and joins at the live edge — otherwise a new viewer would start half a
  minute in the past. Buffering that backlog instead would be a one-line change in
  `playback.ts` and would give instant startup at the cost of being 30s behind.
- No NIP-42, so no AUTH round-trip.

## Verifying it

```bash
pnpm build && pnpm test:e2e
```

Drives two real Chromium pages against the live relay using a synthetic camera
(`--use-fake-device-for-media-stream`). The viewer always opens *after* the broadcast is
underway, so the late-joiner path is what's actually exercised.

It watches a **24s sustained window**, not a snapshot — the relay's ceiling only bites after
~20s of publishing, so a short check called the badly over-budget build healthy. Assertions:
zero unacked publishes, playback tracking wall clock, no stalls, median and peak latency under
budget, and non-zero decoded bytes on both tracks (appending to a SourceBuffer without erroring
is not the same as decoding).

```
▸ camera + mic
  broadcaster wire rate 15.3 KB/s / 24.0 KB · failed publishes 0
  viewer received 99 chunks · 320x180
  playback advanced 24.1s over 24s wall (101%) · stalls 0/11 · min buffer 0.26s
  end-to-end latency: median 0.80s · max 0.81s
  decoded video=178524B audio=75001B
```

`ONLY=camera` / `ONLY=mic` narrows the run when chasing an intermittent failure.

## Limitations

This is a proof of concept, not a streaming stack.

- **Chromium-only in practice.** It depends on WebM MediaRecorder output and MSE playback of the
  same. Safari won't play it.
- **Low quality by necessity.** 320x180@15 at 90 kbps is what fits under the relay's
  throughput ceiling with headroom. This approach can't carry a high-bitrate stream, and no
  amount of encoding cleverness changes that — the ceiling is ~32 KB/s.
- **~0.8–1.1s latency.** Most of what's left is the timeslice and the SourceBuffer depth;
  lowering `TIMESLICE_MS` and `TARGET_LATENCY_SECONDS` buys more back, at the cost of
  stalling on the first network hiccup. The relay itself is only ~150ms of it.
- **No packet recovery.** A dropped event is a visible glitch until the next keyframe; there's
  no retransmit or FEC.
- **No fragmentation.** A chunk that exceeds `MAX_EVENT_BYTES` is dropped rather than split
  across events. Fine at these bitrates, but a hard cap.
- **Bitrate is fixed and open-loop.** The broadcaster reports its wire rate and warns when it
  exceeds budget, but nothing automatically backs off — real use would drop bitrate in
  response to publish failures.
- **Nothing is encrypted or authenticated.** Anyone who knows the stream ID can watch, and
  anyone can publish to it. Real use would want NIP-44 payload encryption and an author filter.
- Broadcasting needs a secure context. `localhost` qualifies; over LAN you'll need HTTPS, e.g.
  by adding `@vitejs/plugin-basic-ssl`.
