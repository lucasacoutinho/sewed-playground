import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Binding, Remote } from "sewed";

export const Placement = Schema.Struct({
  runtime: Schema.String,
  threadId: Schema.Number,
  processId: Schema.Number,
});

export const Inspect = Schema.Struct({
  seed: Schema.String,
  resourceId: Schema.Number,
  value: Schema.Number,
  placement: Placement,
  active: Schema.Number,
  created: Schema.Number,
  released: Schema.Number,
  streamsStarted: Schema.Number,
  streamsFinalized: Schema.Number,
  downstreamSeed: Schema.String,
  downstreamRuntime: Schema.String,
  downstreamResourceId: Schema.Number,
});

export const Progress = Schema.Struct({
  seed: Schema.String,
  step: Schema.Number,
  value: Schema.Number,
});

export const Methods = RpcGroup.make(
  Rpc.make("inspect", { success: Inspect }),
  Rpc.make("add", {
    payload: { delta: Schema.Number },
    success: Schema.Number,
  }),
  Rpc.make("read", { success: Schema.Number }),
  Rpc.make("progress", {
    payload: { hold: Schema.Boolean },
    success: Progress,
    stream: true,
  }),
);

export const Definition = Remote.make({
  payload: Schema.Struct({ seed: Schema.String }),
  protocol: Methods,
});

export const MainRemote = Binding.slot("remote/main", Definition.protocol);
export const WorkerRemote = Binding.slot("remote/worker", Definition.protocol);
export const UtilityRemote = Binding.slot("remote/utility", Definition.protocol);
export const RelayRemote = Binding.slot("remote/relay", Definition.protocol);

export const slots = [MainRemote, WorkerRemote, UtilityRemote, RelayRemote];
