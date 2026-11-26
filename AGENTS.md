# Agent instructions

This repository is **dt-ffmpeg**, a TypeScript ffmpeg filter-graph package, being ported from Python (`ffmpeg-zeo`).

- Gate: `make verify` (typecheck, lint, test, build). Setup: `make setup`. See `docs/RUN.md`.
- Gates run on ENG-UK through Runtime. Never build or test on the Mac mini.
- Source is in `src/`, tests in `src/` and `tests/`.
- `reference/python/` is the frozen Python reference: not built, not part of the gate. Do not change its behaviour.
- The skill and plugin under `.cursor/` and `plugin/` describe the published Python `ffmpeg-zeo 0.1.0`.
