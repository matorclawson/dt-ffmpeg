import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";

import { getArgs } from "./compile.js";
import { FFmpegError } from "./errors.js";
import type { Graph, OverwritePolicy } from "./ir.js";
import {
  startProcess,
  type ProcessOptions,
  type ProcessResult,
  type RunningProcess,
} from "./process.js";
import { progressParser, type Progress } from "./progress.js";

export { BinaryNotFoundError, FFmpegAbortError, FFmpegError, FFmpegTimeoutError } from "./errors.js";
export { DEFAULT_STDERR_LIMIT, DEFAULT_STDOUT_LIMIT, type ProcessResult } from "./process.js";
export type { Progress } from "./progress.js";

export interface CommonRunOptions extends ProcessOptions {
  /** The command, or a command prefix. Default: `FFMPEG_BINARY`, then `ffmpeg` on `PATH`. */
  cmd?: string | string[];
  /** Replaces the graph's overwrite policy. */
  overwrite?: OverwritePolicy;
  loglevel?: string;
  /** Called for each progress report while ffmpeg runs. A throw stops ffmpeg and rejects with that error. */
  onProgress?: (progress: Progress) => void;
}

export interface StreamingOptions extends CommonRunOptions {
  /** Give the caller ffmpeg's stdin (for a `pipe:0` input). */
  pipeStdin?: boolean;
  /** Give the caller ffmpeg's stdout (for a `pipe:1` output). It must be read, or ffmpeg blocks. */
  pipeStdout?: boolean;
}

export interface StreamingRun {
  argv: string[];
  stdin: Writable | null;
  stdout: Readable | null;
  done: Promise<ProcessResult>;
}

export interface RunOptions extends CommonRunOptions {
  /** Bytes written to ffmpeg's stdin. */
  input?: Uint8Array;
  captureStdout?: boolean;
}

export interface RunResult extends ProcessResult {
  /** `null` unless `captureStdout` was set. */
  stdout: Buffer | null;
}

/** Outputs that name a file get their parent directory; pipes and URLs do not. */
function makeOutputDirectories(graph: Graph, cwd: string, argv: string[]): void {
  for (const { filename } of graph.outputs) {
    if (filename === "-" || /^[a-z][a-z0-9+.-]+:/i.test(filename)) continue;
    try {
      mkdirSync(dirname(resolve(cwd, filename)), { recursive: true });
    } catch (cause) {
      throw new FFmpegError(`could not create the directory for output ${filename}`, { argv, cause });
    }
  }
}

function start(graph: Graph, options: StreamingOptions, capture: boolean): RunningProcess & { argv: string[] } {
  const { cmd = (options.env ?? process.env)["FFMPEG_BINARY"] || "ffmpeg", onProgress } = options;
  const effective = options.overwrite ? { ...graph, overwrite: options.overwrite } : graph;
  const argv = [
    ...(typeof cmd === "string" ? [cmd] : cmd),
    ...(onProgress ? ["-progress", "pipe:3"] : []),
    ...(options.loglevel ? ["-loglevel", options.loglevel] : []),
    ...getArgs(effective),
  ];
  if (!options.signal?.aborted) makeOutputDirectories(graph, options.cwd ?? process.cwd(), argv);
  const running = startProcess(argv, options, {
    stdin: options.pipeStdin ?? false,
    stdout: options.pipeStdout ?? false,
    capture,
    ...(onProgress ? { onFd3: progressParser(onProgress) } : {}),
  });
  return { argv, ...running };
}

/** Start ffmpeg for a graph and return its pipes. Throws, or rejects `done`, as `run` does. */
export function runStreaming(graph: Graph, options: StreamingOptions = {}): StreamingRun {
  const { argv, stdin, stdout, done } = start(graph, options, false);
  return { argv, stdin, stdout, done };
}

/**
 * Run ffmpeg to completion. Rejects with an `FFmpegError` when the run cannot be prepared or started, or
 * ffmpeg fails or is stopped. Two errors are passed through unchanged: a `GraphError` for a graph that cannot
 * be compiled, and whatever `onProgress` throws.
 */
export async function run(graph: Graph, options: RunOptions = {}): Promise<RunResult> {
  const { input, captureStdout = false } = options;
  const running = start(graph, { ...options, pipeStdin: input !== undefined, pipeStdout: false }, captureStdout);
  running.stdin?.end(input);
  const result = await running.done;
  return { ...result, stdout: captureStdout ? running.captured() : null };
}
