import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Binding } from "sewed";

export const Protocol = RpcGroup.make(
  Rpc.make("placement", { success: Schema.Number }),
  Rpc.make("ticks", { success: Schema.Number, stream: true }),
  Rpc.make("busy", { success: Schema.Number }),
);
export const Compute = Binding.slot("inspector/compute", Protocol);
