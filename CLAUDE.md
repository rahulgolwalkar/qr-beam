# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A zero-dependency static web app that transfers text or files between two devices
over an optical air gap: one screen renders QR codes, the other's camera reads them,
and ACK QR codes flow back the other way. It is deployed to GitHub Pages, so
**anything that requires a build step or a server is out of scope**.

## Ground rules

- **No build step, no bundler, no npm.** `index.html` loads `app.js` directly. Keep it
  that way. If you reach for a package, you have taken a wrong turn.
- **No CDN links.** Third-party code is vendored under `vendor/` and committed. The
  app must work offline, and both devices are frequently off-network during a
  transfer.
- **Don't edit `vendor/*.min.js`.** Replace the whole file with a new upstream build
  and note the version in the commit message.
- **ES2020-level browser JS only.** `app.js` is one IIFE in `"use strict"`. No modules,
  no transpilation, no TypeScript.
- The site is served from a project subpath (`/qr-beam/`). Every asset reference must
  stay **relative** — a leading `/` breaks the deployed site while still working
  locally.

## Layout

| File | Contents |
| --- | --- |
| `index.html` | markup; the `id` attributes are the app's entire DOM contract |
| `styles.css` | design tokens on `:root`, card layout, one `max-width: 720px` breakpoint |
| `app.js` | protocol, camera pipeline, adaptive chunk sizing, UI wiring |
| `vendor/qrcode.min.js` | QR encoding (`qrcode()` global) |
| `vendor/jsQR.min.js` | QR decoding fallback (`jsQR()` global) |

`app.js` reads every element once into the `elements` object at the top. **If you add
an element to `index.html`, register it there** rather than calling
`getElementById` inline — a typo'd id then fails loudly at load instead of silently at
click time.

## Architecture

State lives in one `state` object with two factory-built sub-objects,
`createSenderState()` and `createReceiverState()`. Resetting a side means reassigning
it from its factory, never hand-clearing fields. When you add a field, add it to the
factory or it will survive a reset and corrupt the next transfer.

The flow, end to end:

```
readTransferSource()   gzip + wrap the payload with metadata
  └─ showCurrentChunk()
       └─ selectChunkPacket()   shrink until the QR encoder accepts it
            └─ buildDataPacket()   frame + checksum + base64url
       └─ renderQr()  +  scheduleSenderTimeout()

runScanLoop()  every 120ms
  └─ scanCurrentFrame()   BarcodeDetector, else jsQR over a canvas
       └─ consumeScannedValue()   dedupe, parsePacket()
            ├─ handleAckPacket()          sender mode
            └─ handleDataPacketAsync()    receiver mode
```

### Invariants worth protecting

- **`selectChunkPacket()` proves fit by encoding.** It calls `buildQrSvg()` on a
  candidate and treats a throw as "too big", halving toward `MIN_CHUNK_SIZE`. QR
  capacity depends on the data's character mix, so there is no formula to substitute
  here. Keep the try/encode approach.
- **The scan loop is serialised by `state.scanLock`.** `handleDataPacketAsync` awaits
  decompression; without the lock a second frame would interleave and duplicate a
  chunk. Anything you add to the scan path must stay inside that lock.
- **The receiver only ever accepts `expectedSeq`.** Lower sequence numbers replay a
  cached ACK from `ackMap`; higher ones are dropped. Do not "helpfully" buffer
  out-of-order chunks — the sender is strictly stop-and-wait and will never send them.
- **Both previews share one `MediaStream`.** `#camera-preview` and
  `#qr-camera-preview` get the same `srcObject`; only the first is scanned. Requesting
  a second stream will fail on most phones.
- **The video is mirrored in CSS only** (`transform: scaleX(-1)`). Decoding reads the
  unmirrored frame. Never mirror the canvas.
- **Chunk framing is positional and dot-delimited.** The payload is rejoined with
  `parts.slice(8).join(".")`, so only the last field may contain dots. If you add a
  field, add it *before* the payload and bump both the parser's length guards.

## Verifying changes

There are no tests, and the real path needs two cameras. Before saying something
works:

1. Serve locally with `python3 -m http.server 8000` and open `http://localhost:8000`.
   `getUserMedia` needs `localhost` or HTTPS — `file://` will not do.
2. For protocol changes, exercise `parsePacket` / `buildDataPacket` /
   `buildAckPacket` directly in the browser console rather than reasoning about the
   string format on paper.
3. For a real loop, open two browser windows and point a webcam at the other screen,
   or use two phones on the deployed URL.

State clearly which of these you actually ran. "Should work" is not verification.

## Deployment

`main` deploys to GitHub Pages automatically. `.nojekyll` is present and must stay —
Jekyll would otherwise ignore any future underscore-prefixed paths.

## Style

Match what is there: two-space indent, double quotes, semicolons, named function
declarations, early returns over nesting. String building uses `+` concatenation
throughout — don't convert a file to template literals as a drive-by. Comments are
rare and explain *why*; the code is expected to read on its own.
