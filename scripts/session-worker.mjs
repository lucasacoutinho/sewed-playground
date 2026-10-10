import { Effect, Ref } from "effect";
import * as Worker from "sewed/worker";
import { Counter } from "./session-contract.mjs";

export default Worker.define(
  Counter,
  Counter.toLayer(
    Effect.gen(function* () {
      const threadId = yield* Worker.threadId;
      const count = yield* Ref.make(0);
      return {
        next: () =>
          Ref.updateAndGet(count, (count) => count + 1).pipe(
            Effect.map((count) => ({ threadId, count })),
          ),
      };
    }),
  ),
);
