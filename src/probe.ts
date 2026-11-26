import { z } from "zod";

import { optionsToArgs } from "./compile.js";
import { FFmpegError } from "./errors.js";
import type { Options } from "./ir.js";
import { startProcess, type ProcessOptions } from "./process.js";

export { BinaryNotFoundError, FFmpegAbortError, FFmpegError, FFmpegTimeoutError } from "./errors.js";

const tags = z.record(z.string(), z.string()).default({});

/** Unknown ffprobe fields are kept. */
export const ProbeStreamSchema = z.looseObject({
  index: z.int().optional(),
  codec_name: z.string().optional(),
  codec_type: z.string().optional(),
  width: z.int().optional(),
  height: z.int().optional(),
  avg_frame_rate: z.string().optional(),
  r_frame_rate: z.string().optional(),
  duration: z.string().optional(),
  bit_rate: z.string().optional(),
  sample_rate: z.string().optional(),
  channels: z.int().optional(),
  tags,
  disposition: z.record(z.string(), z.unknown()).default({}),
});

export const ProbeFormatSchema = z.looseObject({
  filename: z.string().optional(),
  nb_streams: z.int().optional(),
  format_name: z.string().optional(),
  duration: z.string().optional(),
  size: z.string().optional(),
  bit_rate: z.string().optional(),
  tags,
});

export const ProbeResultSchema = z.looseObject({
  format: ProbeFormatSchema.prefault({}),
  streams: z.array(ProbeStreamSchema).default([]),
  frames: z.array(z.record(z.string(), z.unknown())).optional(),
});

export type ProbeStream = z.output<typeof ProbeStreamSchema>;
export type ProbeFormat = z.output<typeof ProbeFormatSchema>;
export type ProbeResult = z.output<typeof ProbeResultSchema>;

export interface ProbeSummary {
  durationSeconds: number | null;
  bitrateBps: number | null;
  /** The first video and audio streams. Cover art counts as video, as ffprobe reports it. */
  video: ProbeStream | null;
  audio: ProbeStream | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  fps: number | null;
}

function decimal(text: string | undefined): number | null {
  const value = text?.trim() ? Number(text) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

function frameRate(stream: ProbeStream | null): number | null {
  const rate = stream?.avg_frame_rate || stream?.r_frame_rate;
  if (!rate || rate === "0/0") return null;
  const [numerator, denominator] = rate.split("/");
  if (denominator === undefined) return decimal(rate);
  const top = decimal(numerator);
  const bottom = decimal(denominator);
  return top === null || !bottom ? null : top / bottom;
}

/** The commonly needed values of a probe result. */
export function summarize(result: ProbeResult): ProbeSummary {
  const first = (type: string): ProbeStream | null =>
    result.streams.find((stream) => stream.codec_type === type) ?? null;
  const video = first("video");
  const audio = first("audio");
  const bitrate = result.format.bit_rate;
  return {
    durationSeconds: decimal(result.format.duration),
    bitrateBps: bitrate !== undefined && /^\d+$/.test(bitrate) ? Number(bitrate) : null,
    video,
    audio,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    fps: frameRate(video),
  };
}

export interface ProbeOptions extends ProcessOptions {
  /** The command, or a command prefix. Default: `FFPROBE_BINARY`, then `ffprobe` on `PATH`. */
  cmd?: string | string[];
  /** Extra ffprobe options, such as `{ show_frames: null }`. */
  options?: Options;
}

/** Run ffprobe on a file or URL. */
export async function probe(filename: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const { cmd = (options.env ?? process.env)["FFPROBE_BINARY"] || "ffprobe" } = options;
  const argv = [
    ...(typeof cmd === "string" ? [cmd] : cmd),
    "-show_format",
    "-show_streams",
    "-of",
    "json",
    ...optionsToArgs(options.options ?? {}),
    filename,
  ];
  const running = startProcess(argv, options, { capture: true });
  const { stderr } = await running.done;
  try {
    return ProbeResultSchema.parse(JSON.parse(running.captured().toString("utf8")));
  } catch (cause) {
    throw new FFmpegError("ffprobe returned output that is not a probe result", {
      argv,
      exitCode: 0,
      stderr,
      cause,
    });
  }
}
