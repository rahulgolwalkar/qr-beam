# AGENTS.md

Instructions for AI coding agents working in this repository.

**The full engineering guide is [CLAUDE.md](CLAUDE.md). Read it before making
changes.** This file is the tool-agnostic entry point and repeats only the
constraints that are expensive to discover by breaking them.

## Project

`qr-beam` — a static web app that transfers text and files between two devices
through QR codes and cameras, with no network in between. Vanilla HTML, CSS, and
JavaScript. Deployed to GitHub Pages at `/qr-beam/`.

## Hard constraints

1. **No build step, no bundler, no npm dependencies.** The browser loads the source
   files as written.
2. **No CDN or remote assets.** Third-party libraries are vendored in `vendor/` and
   committed; the app must run fully offline.
3. **Relative asset paths only.** The site is served from a subpath, so a leading `/`
   breaks production while still working locally.
4. **Plain ES2020 browser JavaScript.** One IIFE, `"use strict"`, no modules or
   TypeScript.
5. **Don't hand-edit `vendor/*.min.js`.** Swap in a fresh upstream build instead.

## Before you change the protocol

`app.js` implements a stop-and-wait ARQ over dot-delimited QR payloads. Three things
break quietly if you miss them:

- Packet fields are **positional**; only the trailing payload field may contain dots.
  New fields go before the payload, and both parser length guards must be updated.
- The scan loop is serialised by `state.scanLock`. New async work in the scan path
  must stay inside it or chunks will be double-applied.
- Sender and receiver state are rebuilt from `createSenderState()` /
  `createReceiverState()`. A new field that is not in its factory will survive a reset
  and leak into the next transfer.

## Verification

No test suite exists, and the full path needs two cameras. Serve with
`python3 -m http.server 8000` and open `http://localhost:8000` — `getUserMedia`
requires `localhost` or HTTPS. Exercise protocol functions from the browser console.

Report exactly what you ran and what you could not. Do not describe an untested change
as working.

## Style

Two-space indent, double quotes, semicolons, named function declarations, early
returns. Match surrounding code rather than modernising it in passing.
