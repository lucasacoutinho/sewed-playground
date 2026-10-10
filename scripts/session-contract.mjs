import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Binding, WindowControls } from "sewed";

export const Counter = RpcGroup.make(
  Rpc.make("next", { success: Schema.Struct({ threadId: Schema.Number, count: Schema.Number }) }),
);
export const CounterSlot = Binding.slot("session-counter", Counter);
export const ControlsSlot = Binding.slot("session-controls", WindowControls.protocol);
