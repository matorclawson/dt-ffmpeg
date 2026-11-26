import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FFmpegError, probe, ProbeResultSchema, summarize } from "../src/probe.js";

// Hand-written ffprobe output; recorded fixtures are compared in probe-parity.test.ts.
const fake = [process.execPath, fileURLToPath(new URL("./fixtures/fake-process.mjs", import.meta.url))];
const options = (mode: string) => ({ cmd: fake, env: { ...process.env, FAKE_MODE: mode } });

describe("probe", () => {
  it("parses ffprobe output and keeps unknown fields", async () => {
    const result = await probe("movie.mp4", { ...options("probe"), options: { show_frames: null } });
    expect(result["args"]).toEqual(["-show_format", "-show_streams", "-of", "json", "-show_frames", "movie.mp4"]);
    expect(result.format["probe_score"]).toBe(100);
    expect(summarize(result)).toMatchObject({
      durationSeconds: 2.5,
      bitrateBps: 1000,
      width: 320,
      height: 240,
      videoCodec: "h264",
      audioCodec: "aac",
      fps: 30000 / 1001,
    });
  });

  it("limits how much ffprobe output it holds", async () => {
    await expect(probe("x", { ...options("probe"), stdoutLimit: 10 })).rejects.toThrow("more than 10 bytes");
  });

  it("gives nulls for what is missing", () => {
    expect(summarize(ProbeResultSchema.parse({}))).toMatchObject({
      durationSeconds: null,
      bitrateBps: null,
      video: null,
      audio: null,
      fps: null,
    });
    const odd = ProbeResultSchema.parse({
      format: { duration: "N/A" },
      streams: [{ codec_type: "video", avg_frame_rate: "0/0" }],
    });
    expect(summarize(odd)).toMatchObject({ durationSeconds: null, fps: null });
  });

  it("rejects output that is not JSON, and a failing ffprobe", async () => {
    await expect(probe("x", options("garbage"))).rejects.toThrow(FFmpegError);
    await expect(probe("x", options("fail"))).rejects.toMatchObject({ exitCode: 3 });
  });
});
