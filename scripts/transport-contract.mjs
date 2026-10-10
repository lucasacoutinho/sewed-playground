import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Binding, SewedError } from "sewed";

export const Response = Schema.Struct({
  value: Schema.String,
  thread: Schema.Number,
  via: Schema.Array(Schema.Number),
});
export const Echo = RpcGroup.make(
  Rpc.make("echo", {
    payload: { value: Schema.String, milliseconds: Schema.optionalKey(Schema.Number) },
    success: Response,
    error: SewedError,
  }),
  Rpc.make("repeat", {
    payload: { value: Schema.String, count: Schema.Number },
    success: Response,
    error: SewedError,
    stream: true,
  }),
  Rpc.make("produce", {
    payload: { size: Schema.Number, count: Schema.Number },
    success: Response,
    error: SewedError,
    stream: true,
  }),
);
export const Direct = Binding.slot("benchmark-direct", Echo);
export const Relayed = Binding.slot("benchmark-relayed", Echo);
