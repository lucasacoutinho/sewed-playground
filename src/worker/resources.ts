import { Effect, Stream } from "effect";
import { Binary, Remote } from "sewed";
import * as Worker from "sewed/worker";
import { ByteResource, ResourceMethods } from "../shared/resources.js";

export default Worker.define(
  ByteResource.protocol,
  Remote.layer(ByteResource, ({ seed }) =>
    ResourceMethods.toLayer(
      Effect.gen(function* () {
        const thread = yield* Worker.threadId;
        yield* Effect.acquireRelease(
          Effect.logInfo("playground.byte-resource.acquired", { thread, seed }),
          () => Effect.logInfo("playground.byte-resource.released", { thread, seed }),
        );
        return {
          inspect: () => Effect.succeed({ thread, seed }),
          read: ({ chunks }) =>
            Stream.range(0, chunks - 1).pipe(
              Stream.rechunk(1),
              Stream.mapEffect(() =>
                Effect.sleep(5).pipe(Effect.as(new Uint8Array(Binary.chunkBytes).fill(seed))),
              ),
            ),
        };
      }),
    ),
  ),
);
