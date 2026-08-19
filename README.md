# qr-beam

Move text or a file between two devices using nothing but their screens and cameras.
No network, no pairing, no cloud. Point them at each other and the data crosses the
air gap as a stream of QR codes.

**Live:** https://rahulgolwalkar.github.io/qr-beam/

---

## How it works

`qr-beam` is a stop-and-wait ARQ protocol drawn in light. One device is the **sender**
and one is the **receiver**, and both run the same page.

```
  SENDER                                RECEIVER
 ┌────────────┐                        ┌────────────┐
 │  chunk N   │ ──── displays QR ────▶ │   camera   │
 │            │                        │  verifies  │
 │   camera   │ ◀──── ACK QR ───────── │  checksum  │
 └────────────┘                        └────────────┘
       │                                      │
       └── advances to N+1, resizes chunk ────┘
```

1. The payload is gzipped (where `CompressionStream` exists), then split into chunks.
2. The sender renders chunk *N* as a QR code and starts an ACK timer.
3. The receiver decodes it, checks an FNV-1a checksum, appends the bytes, and renders
   an ACK QR code.
4. The sender sees the ACK, advances the cursor, and adapts the chunk size.
5. On the final chunk both sides compare a checksum over the whole transfer.

### Adaptive chunk sizing

Throughput is governed by whatever the two cameras can actually resolve, so the
sender tunes it at runtime:

| Event | Effect on next chunk |
| --- | --- |
| ACK timeout | halve the chunk size, replay the same chunk |
| 3 consecutive clean ACKs | double the chunk size, capped at *max chunk size* |
| QR capacity overflow | shrink the candidate until the payload fits |

Good light and steady hands climb toward the max; a shaky handheld pair settles at a
smaller size on its own.

## Wire format

Both packet types are dot-delimited ASCII so they encode compactly in QR byte mode.

**Data**

```
D.<transferId>.<seq>.<isFinal>.<chunkChecksum>.<transferChecksum>.<kind>.<meta>.<payload>
```

| Field | Meaning |
| --- | --- |
| `transferId` | `tx` + base36 timestamp + random suffix; locks the receiver to one stream |
| `seq` | 0-based chunk index |
| `isFinal` | `1` on the last chunk, else `0` |
| `chunkChecksum` | FNV-1a 32-bit hex over this chunk's bytes |
| `transferChecksum` | FNV-1a over the whole payload, or `-` until the final chunk |
| `kind` | `text` or `file` |
| `meta` | base64url JSON (`fileName`, `mimeType`, `byteLength`, `compression`), or `-` |
| `payload` | base64url chunk bytes |

**Acknowledgement**

```
A.<transferId>.<seq>.<chunkChecksum>.<status>.<transferChecksum>.<acceptedSize>
```

`status` is `ok` for a mid-stream chunk and `done` once the transfer verifies.

## Using it

Open the page on both devices, over HTTPS or `localhost` — `getUserMedia` refuses to
run anywhere else.

1. **Receiver** — tap *Receiver*. It waits for chunk 0.
2. **Sender** — tap *Sender*, paste text or choose a file, tap *Start Transfer*.
3. Hold the devices so each camera sees the other's screen. Both previews are on
   screen so you can frame them without guessing.
4. Watch the progress readout. When it reads 100% the receiver either shows the text
   or enables *Download Received File*.

*Focus Camera* forces a single-shot refocus at the centre of the frame on devices
whose cameras expose focus controls.

### Realistic expectations

This is an air gap, not a cable. At a 768-byte chunk and roughly one round trip per
second you are moving on the order of a kilobyte per second under good conditions.
Text, config blobs, keys, and small documents are the sweet spot. A photo will take a
while; a video is not going to happen.

## Browser support

| Capability | Used for | Fallback |
| --- | --- | --- |
| `getUserMedia` | camera capture | none — required |
| `BarcodeDetector` | fast native QR decode | bundled jsQR |
| `CompressionStream` | gzip before chunking | send uncompressed |
| `Wake Lock` | keep the screen alive mid-transfer | screen may dim |
| Focus / zoom constraints | *Focus Camera* | button reports unsupported |

Chrome and Edge on Android hit every fast path. Safari on iOS works through the jsQR
fallback.

## Development

There is no build step. It is three files and two vendored libraries.

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Testing needs two devices — or one device plus a
second browser window on a machine with a webcam pointed at it.

```
index.html      markup and element ids
styles.css      light-theme design tokens and layout
app.js          protocol, camera pipeline, adaptive sizing, UI wiring
vendor/         qrcode.min.js (encode), jsQR.min.js (decode fallback)
```

`app.js` is a single IIFE with no modules or bundler. See [CLAUDE.md](CLAUDE.md) for
the architectural notes that matter when editing it.

## Security notes

QR codes are broadcast in the clear to anything with line of sight, and the FNV-1a
checksums detect corruption, not tampering. Treat a transfer as visible to the room.
Encrypt sensitive payloads before sending them.

## License

MIT — see [LICENSE](LICENSE).
