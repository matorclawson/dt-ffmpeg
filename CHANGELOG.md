# Changelog

All notable changes to ffmpeg-zeo are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the project is below 1.0, minor releases may include breaking API changes.

## [Unreleased]

### Added

- Phase 2: `dt-ffmpeg/run` (`run`, `runStreaming` with stdin/stdout pipes, live progress, timeout, `AbortSignal`) and `dt-ffmpeg/probe` (typed ffprobe). Differences from Python: stderr is always captured (the last 16 MiB by default) and never written to the caller's terminal; stdin is closed unless input is given, so ffmpeg cannot prompt; progress arrives while ffmpeg runs (on file descriptor 3) instead of after it exits; probe results are not cached. Binaries come from `FFMPEG_BINARY` / `FFPROBE_BINARY`, then `PATH` (full resolution and `doctor` are phase 3).
- Phase 1: graph IR with zod schemas, fluent builder, `compile`/`getArgs` and filtergraph escaping, with argv parity against the goldens exported from the Python reference (compile and escape cases; the recipe graphs compile to the same argv too, the recipe functions themselves come in phase 4).

### Intentional differences from the Python reference

- Combining streams merges every stream's settings, also when they share nodes: each `globalArgs()` call is written once, and the later stream's overwrite policy wins. (Python dropped or repeated them depending on whether the node was already present.)
- The fluent API names things explicitly: `pad()` selects a filter output pad and `select()` an input stream selector (Python overloaded indexing). `overwrite()` and `globalArgs()` return a new stream instead of changing the shared graph.
- Combining two separately built chains of the same shape keeps both. Python treated structurally identical nodes from different graphs as one, silently dropping a branch.
- Compile errors are `GraphError`: unknown stream references, filter cycles, a single-value option given `null` or a list. Filter arguments must be strings, numbers or booleans.
- JavaScript has no separate float type, so `input(f, { ss: 1.0 })` writes `1`. `parseGraph` keeps Python's spelling (`1.0`) for JSON documents.
- `concat` rejects `v=0, a=0`.

### Changed

- Rewrite in TypeScript (operator ruling of 23 Nov 2026; design: org-ducktyper-ai `dt-ffmpeg-SOW-01`). Phase 0: package scaffold (Node >= 24.12, ESM, zod, eslint, vitest), `make verify`, `make doctor`, `make hooks`, `make release`, and the golden-argv export script.
- The Python package moved unchanged to `reference/python/` from the closed PR 6 head `211d45bf428c35c66fbf595fe48278ea7ff55b74` (see `reference/python/SOURCE-COMMIT`). It is frozen, is not built or published, and is excluded from `make verify`. It is removed once the TypeScript parity suite is green.
- Removed the Python CI and PyPI publish workflows. No PyPI release will be made (ruling); the published `ffmpeg-zeo 0.1.0` stays as it is.

## [0.1.0] - 2026-08-19

### Added

- Typed Pydantic graph IR for inputs, filters, outputs, stream references,
  global arguments, and explicit overwrite policies.
- Fluent Python API with stream selectors, multi-input filters, graph merging,
  and automatic `split` / `asplit` insertion for fan-out.
- Deterministic compilation from graph IR to FFmpeg argv.
- Synchronous and asynchronous runners with typed results, errors, timeouts,
  captured output, and progress events.
- Typed ffprobe models with convenience properties for duration, dimensions,
  codecs, bitrate, frame rate, and stream presence.
- Nine reusable recipes for conversion, thumbnails, H.264 transcoding, audio
  and cover extraction, scaling, clipping, subtitle burning, and concatenation.
- JSON-first Typer CLI for probing, compiling, running, recipes, catalogs,
  filter help, binary diagnostics, and version information.
- Optional stdio MCP server with tools for probing, graph compilation and
  execution, conversion, recipes, and FFmpeg capability discovery.
- FFmpeg and ffprobe resolution through environment variables, `PATH`, cache,
  or explicit BtbN LGPL binary download on supported Linux and Windows hosts.
- PEP 561 `py.typed` marker and Apache-2.0 package licensing.
- GitHub Actions CI and Trusted Publishing workflows for TestPyPI and PyPI.
- Full installation, Python, CLI, Graph JSON, MCP, architecture, and
  contributor documentation.

### Known limitations

- Python 3.12 or newer is required.
- macOS requires system-provided FFmpeg; automatic binary download is only
  available for supported Linux and Windows architectures.
- FFmpeg features vary by build. Use the live catalog and filter-help commands
  instead of assuming a codec or filter is present.
- ffmpeg-zeo is inspired by ffmpeg-python but is not a drop-in replacement.

[Unreleased]: https://github.com/zeroemployeeorg/ffmpeg-zeo/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/zeroemployeeorg/ffmpeg-zeo/releases/tag/v0.1.0
