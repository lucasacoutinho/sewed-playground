import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Binary, Binding, Remote } from "sewed";

export const ResourceMethods = Binary.protocol(
  RpcGroup.make(
    Rpc.make("inspect", { success: Schema.Struct({ thread: Schema.Number, seed: Schema.Number }) }),
    Rpc.make("read", {
      payload: { chunks: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 })) },
      success: Binary.Bytes,
      stream: true,
    }),
  ),
);
export const ByteResource = Remote.make({
  payload: Schema.Struct({
    seed: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
  }),
  protocol: ResourceMethods,
});
export const Resources = Binding.slot("byte-resources", ByteResource.protocol);
