# Running dt-ffmpeg

dt-ffmpeg (TypeScript) is a **library**. It has no listener, no port, no health URL and no launchd job. Phase 0 contains only the scaffold; the library, CLI and MCP server come in later phases of `dt-ffmpeg-SOW-01`. `make verify` runs on ENG-UK; `make release` has not been run yet.

## Runtime
Node >= 24.12, and `ffmpeg` + `ffprobe` on PATH or via `FFMPEG_BINARY` / `FFPROBE_BINARY`. Integration tests require ffmpeg **8.1.2** exactly. Nothing is downloaded.

## Commands (run as: any user, in the repository root, on ENG-UK for gates; sudo not needed)
```
make setup     # npm ci
make verify    # typecheck + lint + test + build, the gate
make doctor    # JSON: node, ffmpeg and ffprobe versions; exit 0 only when usable
```

## Release
`make release` needs tag `v<version>` on `upstream/main` (override with `MAIN_REF`) and writes `releases/dt-ffmpeg-<version>.tar.gz` with its `.sha256`. It never overwrites a release, and `make clean` leaves `releases/` alone. One run at a time holds the empty directory `releases/.lock-<version>`; if a run was killed, remove that directory with `rmdir` and run again.

## Configuration (names only)
| Variable | Meaning |
|---|---|
| `FFMPEG_BINARY`, `FFPROBE_BINARY` | absolute paths to the binaries |

No secrets are needed.

## Smoke command
`make doctor` exits 0 and prints `"ok": true`.

## Data directory
None.
