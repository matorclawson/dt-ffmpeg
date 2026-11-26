import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { BinaryNotFoundError, FFmpegAbortError, FFmpegError, FFmpegTimeoutError } from "./errors.js";

export const DEFAULT_STDERR_LIMIT = 16 * 1024 * 1024;

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the process after this many milliseconds. */
  timeoutMs?: number;
  /** Kill the process when aborted. */
  signal?: AbortSignal;
  /** Bytes of stderr to keep, counted from the end. */
  stderrLimit?: number;
}

export interface Pipes {
  stdin?: boolean;
  stdout?: boolean;
  /** Called with the text written to file descriptor 3. */
  onFd3?: (text: string) => void;
}

export interface ProcessResult {
  argv: string[];
  stderr: Buffer;
}

export interface RunningProcess {
  stdin: Writable | null;
  stdout: Readable | null;
  /** Resolves on exit code 0; otherwise rejects with an `FFmpegError`. Settles after the process is gone. */
  done: Promise<ProcessResult>;
}

/** Keeps the last `limit` bytes of a stream. */
function tail(limit: number): { add(chunk: Buffer): void; read(): Buffer } {
  let chunks: Buffer[] = [];
  let size = 0;
  return {
    add(chunk) {
      chunks.push(chunk);
      size += chunk.length;
      while (chunks.length > 1 && size - (chunks[0]?.length ?? 0) >= limit) {
        size -= chunks.shift()?.length ?? 0;
      }
    },
    read() {
      const all = Buffer.concat(chunks);
      chunks = [all];
      return all.subarray(Math.max(0, all.length - limit));
    },
  };
}

/** Start a program with an argv array (never a shell). */
export function startProcess(argv: string[], options: ProcessOptions, pipes: Pipes = {}): RunningProcess {
  const [command, ...args] = argv;
  if (command === undefined) throw new FFmpegError("empty command", { argv });
  if (options.signal?.aborted) {
    const error = new FFmpegAbortError(`${command} aborted before it started`, {
      argv,
      cause: options.signal.reason,
    });
    const done = Promise.reject<ProcessResult>(error);
    done.catch(() => {});
    return { stdin: null, stdout: null, done };
  }

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: [
      pipes.stdin ? "pipe" : "ignore",
      pipes.stdout ? "pipe" : "ignore",
      "pipe",
      ...(pipes.onFd3 ? ["pipe" as const] : []),
    ],
  });
  const stderr = tail(options.stderrLimit ?? DEFAULT_STDERR_LIMIT);
  child.stderr?.on("data", (chunk: Buffer) => stderr.add(chunk));
  // A process that exits without reading all of its input is reported by its exit code, not by EPIPE.
  child.stdin?.on("error", () => {});

  const done = new Promise<ProcessResult>((resolve, reject) => {
    let stopped: { kind: "timeout" | "abort" | "callback"; cause?: unknown } | undefined;
    const fd3 = child.stdio[3] as Readable | undefined | null;
    // Once stopped, do not wait for pipes that a grandchild may still hold open.
    const destroyPipes = (): void => {
      for (const stream of [child.stdout, child.stderr, fd3]) stream?.destroy();
    };
    const stop = (reason: NonNullable<typeof stopped>): void => {
      if (stopped) return;
      stopped = reason;
      // A process that has already exited emits no further "exit" event.
      if (child.exitCode !== null || child.signalCode !== null) destroyPipes();
      else child.kill("SIGKILL");
    };
    const timer =
      options.timeoutMs === undefined ? undefined : setTimeout(() => stop({ kind: "timeout" }), options.timeoutMs);
    const onAbort = (): void => stop({ kind: "abort", cause: options.signal?.reason });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    fd3?.setEncoding("utf8").on("data", (text: string) => {
      try {
        pipes.onFd3?.(text);
      } catch (cause) {
        stop({ kind: "callback", cause });
      }
    });

    child.on("exit", () => {
      if (stopped) destroyPipes();
    });
    child.on("error", (cause: NodeJS.ErrnoException) => {
      if (child.pid !== undefined) return; // the process runs; "close" reports how it ended
      cleanup();
      const Failure = cause.code === "ENOENT" ? BinaryNotFoundError : FFmpegError;
      reject(new Failure(`could not start ${command}: ${cause.message}`, { argv, cause }));
    });
    child.on("close", (exitCode, signal) => {
      cleanup();
      const failure = { argv, exitCode, signal, stderr: stderr.read() };
      if (stopped?.kind === "timeout") {
        reject(new FFmpegTimeoutError(`${command} timed out after ${options.timeoutMs} ms`, failure));
      } else if (stopped?.kind === "abort") {
        reject(new FFmpegAbortError(`${command} aborted`, { ...failure, cause: stopped.cause }));
      } else if (stopped) {
        reject(stopped.cause);
      } else if (exitCode !== 0) {
        reject(new FFmpegError(`${command} failed (${signal ?? `exit ${exitCode}`}); see stderr`, failure));
      } else {
        resolve({ argv, stderr: failure.stderr });
      }
    });
  });
  // A caller streaming data attaches to `done` later; an early failure must not crash the process.
  done.catch(() => {});

  return { stdin: child.stdin, stdout: child.stdout, done };
}

/** Collect a readable stream into one buffer. */
export function collect(stream: Readable | null): () => Buffer {
  const chunks: Buffer[] = [];
  stream?.on("data", (chunk: Buffer) => chunks.push(chunk));
  return () => Buffer.concat(chunks);
}
