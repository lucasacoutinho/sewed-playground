import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Binary, Binding, SewedError } from "sewed";

export class Rejected extends Schema.TaggedError()("BinaryRejected", { value: Schema.Number }) {}
export const Protocol = Binary.protocol(
  RpcGroup.make(
    Rpc.make("echo", { payload: { bytes: Binary.Bytes }, success: Binary.Bytes }),
    Rpc.make("bytes", {
      payload: { count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4096 })) },
      success: Binary.Bytes,
      stream: true,
    }),
    Rpc.make("stats", {
      success: Schema.Struct({
        runtime: Schema.String,
        thread: Schema.Number,
        pid: Schema.Number,
        active: Schema.Number,
        released: Schema.Number,
        produced: Schema.Number,
        rss: Schema.Number,
        external: Schema.Number,
      }),
    }),
    Rpc.make("reject", { success: Schema.Void, error: Rejected }),
    // Renderer to main only, over the real contextBridge/MessagePort/MainBridge path: a
    // conversation attachment ingest whose bulk field is named and bounded exactly.
    Binary.bulk(
      Rpc.make("ingest", {
        payload: { content: Binary.Bytes },
        success: Schema.Struct({ length: Schema.Number, sum: Schema.Number }),
        error: SewedError,
      }),
      { field: "content", maxBytes: 12 * 1024 * 1024 },
    ),
    // Renderer to main only: a Core-shaped search result, JSON not bytes, large enough that its
    // encoded Exit does not fit one envelope — the mirror of `ingest` above, in the answer
    // direction.
    Binary.bulkAnswer(
      Rpc.make("query", {
        payload: { count: Schema.Number, size: Schema.Number },
        success: Schema.Array(Schema.Struct({ index: Schema.Number, value: Schema.String })),
        error: SewedError,
      }),
      { maxBytes: 16 * 1024 * 1024 },
    ),
    // JSON-shaped data exactly as main gets it from `JSON.parse`: `"__proto__"` is an own key.
    // Once as an ordinary answer, once as a bulk answer large enough to leave in parts.
    Rpc.make("json", { success: Schema.Unknown, error: SewedError }),
    Binary.bulkAnswer(
      Rpc.make("jsonRows", {
        payload: { count: Schema.Number },
        success: Schema.Array(Schema.Struct({ index: Schema.Number, data: Schema.Unknown })),
        error: SewedError,
      }),
      { maxBytes: 4 * 1024 * 1024 },
    ),
    // Strings `JSON.parse` accepts but UTF-8 cannot carry: each holds a lone surrogate, short and
    // long, as a value and as a key. Once as an ordinary answer, once as a bulk answer in parts.
    Rpc.make("surrogates", { success: Schema.Unknown, error: SewedError }),
    Binary.bulkAnswer(
      Rpc.make("surrogateRows", {
        payload: { count: Schema.Number },
        success: Schema.Array(Schema.Struct({ index: Schema.Number, data: Schema.Unknown })),
        error: SewedError,
      }),
      { maxBytes: 4 * 1024 * 1024 },
    ),
  ),
);
export const MainBytes = Binding.slot("binary/main", Protocol);
export const WorkerBytes = Binding.slot("binary/worker", Protocol);
export const UtilityBytes = Binding.slot("binary/utility", Protocol);
export const RelayBytes = Binding.slot("binary/relay", Protocol);
export const slots = [MainBytes, WorkerBytes, UtilityBytes, RelayBytes];

// Lone surrogates, as `JSON.parse` yields them from escapes: short strings (under msgpackr's
// 64-unit path) and long ones (through its UTF-8 encoder), as values and as keys.
export const surrogatesJson = JSON.stringify({
  short: "a\ud800b",
  low: "\udc00",
  long: `${"x".repeat(200)}\ud83d`,
  longLow: `\udfff${"é".repeat(199)}`,
  keys: { "k\ud800": 1, [`${"k".repeat(200)}\udbff`]: 2 },
  nested: [{ deeper: ["\ud800", { [`\udc00${"y".repeat(100)}`]: "\ud801" }] }],
});
