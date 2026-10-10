import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Binding } from "sewed";

export const Identity = Schema.Struct({
  pid: Schema.Number,
  type: Schema.String,
  role: Schema.String,
  counter: Schema.Number,
});

export const Route = Schema.Struct({
  main: Identity,
  worker: Identity,
  utility: Identity,
});

export class NegativeDelta extends Schema.TaggedError()("NegativeDelta", {
  delta: Schema.Number,
}) {}

export const Protocol = RpcGroup.make(
  Rpc.make("inspect", { success: Identity }),
  Rpc.make("increment", {
    payload: { delta: Schema.Number },
    success: Identity,
    error: NegativeDelta,
  }),
  Rpc.make("route", { success: Route }),
  Rpc.make("stream", {
    payload: { count: Schema.Number, delayMs: Schema.Number },
    success: Identity,
    stream: true,
  }),
  Rpc.make("wait", {
    payload: { milliseconds: Schema.Number },
    success: Identity,
  }),
  Rpc.make("crash", { success: Schema.String }),
);

export const MainBinding = Binding.slot("utility-main", Protocol);
export const WorkerBinding = Binding.slot("utility-worker", Protocol);
export const UtilityBinding = Binding.slot("utility-base", Protocol);
export const ConsumerBinding = Binding.slot("utility-consumer", Protocol);
