import { isDeepStrictEqual } from "node:util";

import { compile, getArgs, type ArgsOptions, type CompileOptions } from "./compile.js";
import { GraphError } from "./errors.js";
import { escapeChars } from "./escape.js";
import {
  GraphSchema,
  type FilterNode,
  type Graph,
  type InputNode,
  type Options,
  type OutputNode,
  type OverwritePolicy,
  type StreamRef,
} from "./ir.js";
import type { Scalar } from "./value.js";

export type FilterOptions = Record<string, Scalar>;
type Node = InputNode | FilterNode | OutputNode;

/** Maps a renumbered copy back to the node it was copied from, so shared ancestors are recognised. */
const origins = new WeakMap<Node, Node>();
const originOf = (node: Node): Node => origins.get(node) ?? node;

function findSame<T extends Node>(nodes: T[], node: Node): T | undefined {
  const origin = originOf(node);
  return nodes.find((item) => originOf(item) === origin);
}

/** The mutable node lists behind a stream. Not part of the package exports. */
export class Builder {
  inputs: InputNode[] = [];
  filters: FilterNode[] = [];
  outputs: OutputNode[] = [];
  /** One entry per `globalArgs()` call, so a call inherited along two paths is written once. */
  globalArgGroups: string[][] = [];
  overwrite: OverwritePolicy | null = null;
  private seq = 0;
  private readonly merged = new Map<Builder, Map<string, string>>();

  clone(): Builder {
    const copy = new Builder();
    copy.inputs = [...this.inputs];
    copy.filters = [...this.filters];
    copy.outputs = [...this.outputs];
    copy.globalArgGroups = [...this.globalArgGroups];
    copy.overwrite = this.overwrite;
    copy.seq = this.seq;
    return copy;
  }

  newId(prefix: string): string {
    return `${prefix}${++this.seq}`;
  }

  all(): Node[] {
    return [...this.inputs, ...this.filters, ...this.outputs];
  }

  graph(): Graph {
    return GraphSchema.parse({
      inputs: this.inputs,
      filters: this.filters,
      outputs: this.outputs,
      global_args: this.globalArgGroups.flat(),
      overwrite: this.overwrite,
    });
  }

  /** Copy the nodes of `other` into this builder, renumbering colliding ids. Returns old id to new id. */
  merge(other: Builder): Map<string, string> {
    const cached = this.merged.get(other);
    if (cached) return cached;
    const taken = new Set(this.all().map((node) => node.id));
    const ids = new Map<string, string>();
    const take = (oldId: string, prefix: string): string => {
      let id = oldId;
      while (taken.has(id)) id = this.newId(prefix);
      taken.add(id);
      ids.set(oldId, id);
      return id;
    };
    const remap = (ref: StreamRef): StreamRef => ({ ...ref, node_id: ids.get(ref.node_id) ?? ref.node_id });
    const adopt = <T extends Node>(target: T[], node: T, prefix: string, change: (id: string) => T): void => {
      const found = findSame(target, node);
      if (found) {
        ids.set(node.id, found.id);
        return;
      }
      const copy = change(take(node.id, prefix));
      if (isDeepStrictEqual(copy, node)) {
        target.push(node);
      } else {
        origins.set(copy, originOf(node));
        target.push(copy);
      }
    };

    for (const node of other.inputs) {
      // The same file with the same options is one ffmpeg input.
      const same =
        findSame(this.inputs, node) ??
        this.inputs.find(
          (item) => item.filename === node.filename && isDeepStrictEqual(item.kwargs, node.kwargs),
        );
      if (same) ids.set(node.id, same.id);
      else adopt(this.inputs, node, "in", (id) => ({ ...node, id }));
    }
    for (const node of other.filters) {
      adopt(this.filters, node, "f", (id) => ({ ...node, id, inputs: node.inputs.map(remap) }));
    }
    for (const node of other.outputs) {
      adopt(this.outputs, node, "out", (id) => ({ ...node, id, inputs: node.inputs.map(remap) }));
    }
    this.globalArgGroups.push(...other.globalArgGroups.filter((g) => !this.globalArgGroups.includes(g)));
    if (other.overwrite !== null) this.overwrite = other.overwrite;
    this.seq = Math.max(this.seq, other.seq);
    this.merged.set(other, ids);
    return ids;
  }
}

/** Structure of the graph behind a reference, independent of node ids. */
function fingerprint(builder: Builder, ref: StreamRef): unknown {
  const node = builder.all().find((item) => item.id === ref.node_id);
  if (!node) throw new GraphError(`unknown node: ${ref.node_id}`);
  const inputs = "inputs" in node ? node.inputs.map((item) => fingerprint(builder, item)) : [];
  return { ...node, id: "", inputs, pad: ref.pad, selector: ref.selector };
}

/** A labelled edge in a graph being built. Every operation returns a new stream; the source is unchanged. */
export class Stream {
  /** @internal */
  constructor(
    /** @internal */ readonly builder: Builder,
    /** @internal */ readonly ref: StreamRef,
  ) {}

  private isFilter(): boolean {
    return this.builder.filters.some((node) => node.id === this.ref.node_id);
  }

  /** One output pad of a multi-output filter (`split`, `concat`, ...). */
  pad(pad: number | string): Stream {
    if (!this.isFilter()) throw new GraphError("only a filter has output pads");
    if (this.ref.pad !== null) throw new GraphError("stream already has a pad");
    return new Stream(this.builder, { ...this.ref, pad });
  }

  /** A stream selector of an input file, such as `a`, `v` or `1`. */
  select(selector: string): Stream {
    if (!this.builder.inputs.some((node) => node.id === this.ref.node_id)) {
      throw new GraphError("only an input has stream selectors; use pad() on a filter");
    }
    if (this.ref.selector !== null) throw new GraphError("stream already has a selector");
    return new Stream(this.builder, { ...this.ref, selector });
  }

  get audio(): Stream {
    return this.select("a");
  }

  get video(): Stream {
    return this.select("v");
  }

  /** True when both streams describe the same operations on the same files. */
  equals(other: Stream): boolean {
    return isDeepStrictEqual(fingerprint(this.builder, this.ref), fingerprint(other.builder, other.ref));
  }

  filter(name: string, args: Scalar[] = [], options: FilterOptions = {}): Stream {
    return filterStreams([this], name, args, options);
  }

  split(): Stream {
    return this.filter("split");
  }

  asplit(): Stream {
    return this.filter("asplit");
  }

  hflip(): Stream {
    return this.filter("hflip");
  }

  vflip(): Stream {
    return this.filter("vflip");
  }

  trim(options: FilterOptions): Stream {
    return this.filter("trim", [], options);
  }

  setpts(expression: string): Stream {
    return this.filter("setpts", [expression]);
  }

  crop(x: Scalar, y: Scalar, width: Scalar, height: Scalar, options: FilterOptions = {}): Stream {
    return this.filter("crop", [width, height, x, y], options);
  }

  drawbox(
    x: Scalar,
    y: Scalar,
    width: Scalar,
    height: Scalar,
    color: string,
    options: FilterOptions & { thickness?: Scalar } = {},
  ): Stream {
    const { thickness, ...rest } = options;
    if (thickness) rest["t"] = thickness;
    return this.filter("drawbox", [x, y, width, height, color], rest);
  }

  /** `text` is escaped for drawtext's own expansion unless `escapeText` is false. */
  drawtext(text: string, options: FilterOptions = {}, { escapeText = true } = {}): Stream {
    return this.filter("drawtext", [], {
      ...options,
      text: escapeText ? escapeChars(text, "\\'%") : text,
    });
  }

  overlay(top: Stream, options: FilterOptions = {}): Stream {
    return filterStreams([this, top], "overlay", [], { eof_action: "repeat", ...options });
  }

  output(filename: string, options: Options = {}): Stream {
    return output([this], filename, options);
  }

  /** Set the overwrite policy (`-y` or `-n`) of the graph. */
  overwrite(policy: OverwritePolicy = "always"): Stream {
    const builder = this.builder.clone();
    builder.overwrite = policy;
    return new Stream(builder, this.ref);
  }

  globalArgs(...args: string[]): Stream {
    const builder = this.builder.clone();
    builder.globalArgGroups.push([...args]);
    return new Stream(builder, this.ref);
  }

  build(): Graph {
    return this.builder.graph();
  }

  getArgs(options: ArgsOptions = {}): string[] {
    return getArgs(this.build(), options);
  }

  compile(options: CompileOptions = {}): string[] {
    return compile(this.build(), options);
  }
}

/**
 * Bring the streams into one builder (a clone of the first) and return their references there. Every stream's
 * graph is merged, also when its node is already present: each `globalArgs()` call is kept once, and where
 * streams set different overwrite policies the later stream wins.
 */
function combine(streams: Stream[]): { builder: Builder; refs: StreamRef[] } {
  const [first] = streams;
  if (!first) throw new GraphError("at least one stream is required");
  const builder = first.builder.clone();
  const refs = streams.map((stream) => {
    if (stream.builder === first.builder) return stream.ref;
    const id = builder.merge(stream.builder).get(stream.ref.node_id);
    return { ...stream.ref, node_id: id ?? stream.ref.node_id };
  });
  return { builder, refs };
}

/** A filter with any number of inputs. */
export function filterStreams(
  streams: Stream[],
  name: string,
  args: Scalar[] = [],
  options: FilterOptions = {},
): Stream {
  const { builder, refs } = combine(streams);
  const id = builder.newId("f");
  builder.filters.push({ id, name, inputs: refs, args: [...args], kwargs: { ...options } });
  return new Stream(builder, { node_id: id, pad: null, selector: null });
}

export function input(filename: string, options: Options = {}): Stream {
  const builder = new Builder();
  const id = builder.newId("in");
  builder.inputs.push({ id, filename, kwargs: { ...options } });
  return new Stream(builder, { node_id: id, pad: null, selector: null });
}

export function output(streams: Stream[], filename: string, options: Options = {}): Stream {
  const { builder, refs } = combine(streams);
  const id = builder.newId("out");
  builder.outputs.push({ id, filename, inputs: refs, kwargs: { ...options } });
  return new Stream(builder, { node_id: id, pad: null, selector: null });
}

/** Concatenate segments. `v` and `a` are the video and audio streams per segment (defaults 1 and 0). */
export function concat(streams: Stream[], options: FilterOptions & { v?: number; a?: number } = {}): Stream {
  const video = options.v ?? 1;
  const audio = options.a ?? 0;
  const perSegment = video + audio;
  if (perSegment <= 0 || streams.length % perSegment !== 0) {
    throw new GraphError(
      `Expected concat input streams to have length multiple of ${perSegment} (v=${video}, a=${audio}); got ${streams.length}`,
    );
  }
  return filterStreams(streams, "concat", [], { ...options, n: streams.length / perSegment });
}

/** Put several outputs into one graph, in the order given. */
export function mergeOutputs(...outputs: Stream[]): Stream {
  const { builder, refs } = combine(outputs);
  return new Stream(builder, refs[0] as StreamRef);
}
