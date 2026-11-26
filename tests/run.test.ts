import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { input } from "../src/index.js";
import {
  BinaryNotFoundError,
  FFmpegAbortError,
  FFmpegError,
  FFmpegTimeoutError,
  run,
  runStreaming,
  type Progress,
} from "../src/run.js";

const fake = [process.execPath, fileURLToPath(new URL("./fixtures/fake-process.mjs", import.meta.url))];
const work = mkdtempSync(join(tmpdir(), "dt-ffmpeg-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const graph = input("in.mp4").output("out.mp4").build();
const options = (mode: string) => ({ cmd: fake, cwd: work, env: { ...process.env, FAKE_MODE: mode } });
const failure = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );

describe("run", () => {
  it("passes the compiled argv, global options first", async () => {
    const result = await run(graph, { ...options("ok"), loglevel: "error", overwrite: "never" });
    expect(JSON.parse(result.stderr.toString())).toEqual(["-loglevel", "error", "-i", "in.mp4", "out.mp4", "-n"]);
    expect(result.argv.slice(0, 2)).toEqual(fake);
    expect(result.stdout).toBeNull();
  });

  it("creates the parent directory of a file output only", async () => {
    await run(input("in").output("nested/deeper/out.mp4").build(), options("ok"));
    await run(input("in").output("rtmp://host/app/key").build(), options("ok"));
    expect(existsSync(join(work, "nested", "deeper"))).toBe(true);
    expect(existsSync(join(work, "rtmp:"))).toBe(false);
  });

  it("reports a failing process with its stderr", async () => {
    const error = await failure(run(graph, options("fail")));
    expect(error).toBeInstanceOf(FFmpegError);
    expect(error).toMatchObject({ exitCode: 3, stderr: Buffer.from("boom: no such file") });
  });

  it("keeps only the end of stderr", async () => {
    const result = await run(graph, { ...options("noisy"), stderrLimit: 10 });
    expect(result.stderr.toString()).toBe("aaaTHE-END");
  });

  it("names a missing binary", async () => {
    const error = await failure(run(graph, { cmd: join(work, "no-such-ffmpeg") }));
    expect(error).toBeInstanceOf(BinaryNotFoundError);
  });

  it("pipes input to captured output", async () => {
    const data = Buffer.alloc(1_000_000, 7);
    const result = await run(graph, { ...options("echo"), input: data, captureStdout: true });
    expect(result.stdout?.equals(data)).toBe(true);
  });

  it("streams through stdin and stdout", async () => {
    const running = runStreaming(graph, { ...options("echo"), pipeStdin: true, pipeStdout: true });
    const chunks: Buffer[] = [];
    running.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    running.stdin?.end("frames");
    await running.done;
    expect(Buffer.concat(chunks).toString()).toBe("frames");
  });

  it("kills on timeout", async () => {
    const error = await failure(run(graph, { ...options("hang"), timeoutMs: 200 }));
    expect(error).toBeInstanceOf(FFmpegTimeoutError);
    expect(error).toMatchObject({ signal: "SIGKILL" });
  });

  it("kills on abort, and does not start when already aborted", async () => {
    const controller = new AbortController();
    const pending = failure(
      run(graph, {
        ...options("progress-hang"),
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    );
    expect(await pending).toBeInstanceOf(FFmpegAbortError);
    const second = await failure(run(graph, { ...options("ok"), signal: controller.signal }));
    expect(second).toBeInstanceOf(FFmpegAbortError);
    expect(second).toMatchObject({ exitCode: null });
  });

  // The process has exited before the deadline; only the grandchild keeps its pipes open.
  const endOrphan = (error: unknown): void => {
    expect(error).toMatchObject({ exitCode: 0 });
    const pid = Number((error as FFmpegError).stderr.toString());
    expect(pid).toBeGreaterThan(0);
    process.kill(pid);
  };

  it("times out when an exited process left its stderr held open", async () => {
    const error = await failure(run(graph, { ...options("orphan"), timeoutMs: 1500 }));
    expect(error).toBeInstanceOf(FFmpegTimeoutError);
    endOrphan(error);
  });

  it("aborts when an exited process left its progress pipe held open", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1500);
    const error = await failure(
      run(graph, { ...options("orphan"), signal: controller.signal, onProgress: () => {} }),
    );
    expect(error).toBeInstanceOf(FFmpegAbortError);
    endOrphan(error);
  });

  it("reports progress blocks split across writes", async () => {
    const events: Progress[] = [];
    const result = await run(graph, { ...options("progress"), onProgress: (p) => events.push(p) });
    expect(result.argv.slice(2, 4)).toEqual(["-progress", "pipe:3"]);
    expect(events).toMatchObject([
      { frame: 1, fps: null, outTimeUs: -5, totalSize: null, speed: null, end: false },
      { frame: 2, fps: 29.97, outTimeUs: null, totalSize: 100, speed: "1.5x", end: true },
    ]);
  });

  it("stops ffmpeg when the progress callback throws", async () => {
    const boom = new Error("callback failed");
    const error = await failure(
      run(graph, {
        ...options("progress-hang"),
        onProgress: () => {
          throw boom;
        },
      }),
    );
    expect(error).toBe(boom);
  });
});
