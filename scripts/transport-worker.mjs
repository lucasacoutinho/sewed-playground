import { Effect, Stream } from "effect";
import * as Worker from "sewed/worker";
import { Echo } from "./transport-contract.mjs";

export default Worker.define(
  Echo,
  Echo.toLayer(
    Effect.gen(function* () {
      const thread = yield* Worker.threadId;
      return {
        echo: ({ value, milliseconds }) => {
          const response = { value, thread, via: [] };
          return milliseconds === undefined
            ? Effect.succeed(response)
            : Effect.as(Effect.sleep(milliseconds), response);
        },
        repeat: ({ value, count }) =>
          Stream.range(0, count - 1).pipe(Stream.map(() => ({ value, thread, via: [] }))),
        produce: ({ size, count }) =>
          Stream.range(0, count - 1).pipe(
            Stream.map(() => ({ value: "x".repeat(size), thread, via: [] })),
          ),
      };
    }),
  ),
);
