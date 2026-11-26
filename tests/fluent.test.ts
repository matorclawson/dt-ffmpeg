import { describe, expect, it } from "vitest";

import {
  concat,
  filterStreams,
  getArgs,
  GraphError,
  input,
  mergeOutputs,
  output,
  parseGraph,
} from "../src/index.js";

// Expected argv are those asserted by reference/python/tests/test_compile.py.
describe("fluent builder", () => {
  it("compiles the complex graph", () => {
    const split = input("in1.mp4").vflip().split();
    const overlayFile = input("overlay.png").crop(10, 10, 158, 112);
    const args = concat([
      split.pad(0).trim({ start_frame: 10, end_frame: 20 }),
      split.pad(1).trim({ start_frame: 30, end_frame: 40 }),
    ])
      .overlay(overlayFile.hflip())
      .drawbox(50, 50, 120, 120, "red", { thickness: 5 })
      .output("out1.mp4")
      .overwrite()
      .getArgs();
    expect(args).toEqual([
      "-i",
      "in1.mp4",
      "-i",
      "overlay.png",
      "-filter_complex",
      "[0]vflip[s0];" +
        "[s0]split=2[s1][s2];" +
        "[s1]trim=end_frame=20:start_frame=10[s3];" +
        "[s2]trim=end_frame=40:start_frame=30[s4];" +
        "[s3][s4]concat=n=2[s5];" +
        "[1]crop=158:112:10:10[s6];" +
        "[s6]hflip[s7];" +
        "[s5][s7]overlay=eof_action=repeat[s8];" +
        "[s8]drawbox=50:50:120:120:red:t=5[s9]",
      "-map",
      "[s9]",
      "out1.mp4",
      "-y",
    ]);
  });

  it("maps selectors and concat pads", () => {
    const first = input("in1.mp4");
    const second = input("in2.mp4");
    const joined = concat([first.video, first.audio, second.hflip(), second.audio], { v: 1, a: 1 });
    expect(output([joined.pad(0), joined.pad(1)], "out.mp4").getArgs()).toEqual([
      "-i",
      "in1.mp4",
      "-i",
      "in2.mp4",
      "-filter_complex",
      "[1]hflip[s0];[0:v][0:a][s0][1:a]concat=a=1:n=2:v=1[s1][s2]",
      "-map",
      "[s1]",
      "-map",
      "[s2]",
      "out.mp4",
    ]);
  });

  it("keeps both chains when two inputs get the same filter", () => {
    const args = concat([input("a.mp4").hflip(), input("b.mp4").hflip()])
      .output("out.mp4")
      .getArgs();
    expect(args.slice(0, 6)).toEqual([
      "-i",
      "a.mp4",
      "-i",
      "b.mp4",
      "-filter_complex",
      "[0]hflip[s0];[1]hflip[s1];[s0][s1]concat=n=2[s2]",
    ]);
  });

  it("shares one input and splits a filter used twice", () => {
    const flipped = input("a.mp4").hflip();
    const args = filterStreams([flipped.vflip(), flipped], "hstack").output("out.mp4").getArgs();
    expect(args).toEqual([
      "-i",
      "a.mp4",
      "-filter_complex",
      "[0]hflip[s0];[s0]split=2[s1][s2];[s1]vflip[s3];[s3][s2]hstack[s4]",
      "-map",
      "[s4]",
      "out.mp4",
    ]);
  });

  it("merges outputs that share an input", () => {
    const source = input("in.mp4");
    const merged = mergeOutputs(source.output("out1.mp4"), source.output("out2.mp4"));
    expect(merged.getArgs()).toEqual(["-i", "in.mp4", "out1.mp4", "out2.mp4"]);
  });

  it("does not change the source stream", () => {
    const out = input("in").output("out");
    out.overwrite();
    out.globalArgs("-progress", "url");
    expect(out.getArgs()).toEqual(["-i", "in", "out"]);
  });

  it("keeps the settings of a stream whose node is already present", () => {
    const flipped = input("a.mp4").hflip();
    const configured = flipped.overwrite("never").globalArgs("-progress", "url");
    const args = filterStreams([flipped, configured], "hstack").output("out.mp4").getArgs();
    expect(args.slice(-4)).toEqual(["out.mp4", "-progress", "url", "-n"]);
  });

  it("writes an inherited global argument once, and a repeated call twice", () => {
    const shared = input("in.mp4").globalArgs("-hide_banner");
    expect(mergeOutputs(shared.output("1.mp4"), shared.output("2.mp4")).getArgs()).toEqual([
      "-i",
      "in.mp4",
      "1.mp4",
      "2.mp4",
      "-hide_banner",
    ]);
    const separate = (file: string) => input("in.mp4").output(file).globalArgs("-hide_banner");
    expect(mergeOutputs(separate("1.mp4"), separate("2.mp4")).getArgs().slice(-2)).toEqual([
      "-hide_banner",
      "-hide_banner",
    ]);
  });

  it("lets the later stream decide the overwrite policy", () => {
    const source = input("in.mp4");
    const merged = mergeOutputs(source.output("1.mp4").overwrite("never"), source.output("2.mp4").overwrite());
    expect(merged.getArgs().at(-1)).toBe("-y");
  });

  it("compares streams by structure", () => {
    const base = input("a.mp4");
    const trimmed = base.trim({ start_frame: 10 });
    expect(trimmed.equals(input("a.mp4").trim({ start_frame: 10 }))).toBe(true);
    expect(trimmed.equals(base.trim({ start_frame: 11 }))).toBe(false);
    expect(trimmed.equals(input("b.mp4").trim({ start_frame: 10 }))).toBe(false);
  });

  it("rejects misuse", () => {
    const source = input("a.mp4");
    expect(() => source.audio.audio).toThrow(GraphError);
    expect(() => source.pad(0)).toThrow(GraphError);
    expect(() => source.hflip().select("a")).toThrow(GraphError);
    expect(() => concat([source, source, source], { v: 1, a: 1 })).toThrow("Expected concat input streams");
  });
});

describe("graph documents", () => {
  it("keeps a whole float as Python wrote it, and leaves strings alone", () => {
    const graph = parseGraph(
      '{"inputs":[{"id":"i","filename":"v 2.0.mp4","kwargs":{"ss":1.0,"t":0.00001}}],' +
        '"outputs":[{"id":"o","filename":"out","inputs":[{"node_id":"i"}]}]}',
    );
    expect(graph.inputs[0]?.filename).toBe("v 2.0.mp4");
    expect(input("x", graph.inputs[0]?.kwargs).output("y").getArgs().slice(0, 4)).toEqual([
      "-ss",
      "1.0",
      "-t",
      "1e-05",
    ]);
  });

  it("rejects duplicate ids and cycles", () => {
    const node = { id: "i", filename: "a" };
    expect(() => parseGraph({ inputs: [node, node] })).toThrow("duplicate node id");
    const cycle = parseGraph({
      filters: [
        { id: "a", name: "null", inputs: [{ node_id: "b" }] },
        { id: "b", name: "null", inputs: [{ node_id: "a" }] },
      ],
    });
    expect(() => getArgs(cycle)).toThrow("cycle");
  });
});
