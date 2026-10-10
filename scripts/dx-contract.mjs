import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Binding } from "sewed";

export class Rejected extends Schema.TaggedError()("Rejected", { message: Schema.String }) {}

export const Protocol = RpcGroup.make(
  Rpc.make("values", {
    payload: { key: Schema.String },
    success: Schema.Struct({ key: Schema.String, subscription: Schema.Number }),
    error: Rejected,
    stream: true,
  }),
);
export const Values = Binding.slot("dx-values", Protocol);
export const Other = Binding.slot("dx-other", Protocol);
