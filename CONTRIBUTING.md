# Contributing to dt-ffmpeg

dt-ffmpeg is being rewritten in TypeScript. Bug fixes, tests, documentation and focused feature proposals are welcome.

## Development setup

You need Node 24.12 or newer, and `ffmpeg` with `ffprobe` on `PATH` (or set `FFMPEG_BINARY` and `FFPROBE_BINARY`).

```bash
make setup     # npm ci, the locked install
make doctor
```

## Make changes

- TypeScript strict, ESM only. Processes are started with argv arrays, never through a shell.
- Add or update tests for every behaviour change.
- Record intentional differences from the Python reference in `CHANGELOG.md`.
- Pin dependencies to exact versions.

## Checks

```bash
make verify    # typecheck + lint + test + build
```

## The Python reference

`reference/python/` is frozen. It is the behaviour the port is compared against and is not part of the gate. To run its tests:

```bash
cd reference/python
uv sync --locked --extra dev
uv run pytest
```

The published `ffmpeg-zeo 0.1.0` stays on PyPI as it is; no new PyPI release will be made.

## Pull requests

Keep them focused and explain the intended behaviour, any change to the public API or graph JSON, the commands used to verify, and the FFmpeg version where it matters. Do not commit media you cannot redistribute, build output, credentials or FFmpeg binaries.

## Releases

`make release` archives the commit tagged `v<version>` (the version in `package.json`), which must be on the main branch, into `releases/` with its `.sha256`.

## Reporting issues

Include a minimal reproduction, the compiled argv, platform, Node version and FFmpeg version. Remove private paths, media and credentials first.
