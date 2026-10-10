import { Effect, Stream, SubscriptionRef } from "effect";
import * as Worker from "sewed/worker";
import { Clock } from "../shared/bindings.js";
import { ComputeProtocol, Rejected } from "../shared/contracts.js";

export default Worker.define(
  ComputeProtocol,
  (implement) =>
    implement(
      Effect.gen(function* () {
        const thread = yield* Worker.threadId;
        const state = yield* SubscriptionRef.make({ thread, active: 0, released: 0 });

        return {
          changes: () => SubscriptionRef.changes(state),
          background: () =>
            Stream.scoped(
              Stream.unwrap(
                Effect.gen(function* () {
                  yield* Effect.acquireRelease(
                    Effect.annotateLogs(Effect.logInfo("playground.background.acquired"), {
                      thread,
                    }),
                    () =>
                      Effect.annotateLogs(Effect.logInfo("playground.background.released"), {
                        thread,
                      }),
                  );
                  const clock = yield* Clock();
                  return clock.ticks().pipe(
                    Stream.map(({ thread: sourceThread, ticks }) => ({
                      thread,
                      sourceThread,
                      ticks,
                    })),
                  );
                }),
              ),
            ).pipe(Stream.orDie),
          compute: ({ milliseconds, label }) =>
            Effect.sync(() => {
              const end = performance.now() + milliseconds;
              let iterations = 0;
              while (performance.now() < end) iterations++;
              return { label, thread, iterations };
            }),
          wait: ({ milliseconds, label }) =>
            Effect.acquireUseRelease(
              SubscriptionRef.update(state, (value) => ({ ...value, active: value.active + 1 })),
              () => Effect.as(Effect.sleep(milliseconds), { label, thread, iterations: 0 }),
              () =>
                SubscriptionRef.update(state, (value) => ({
                  ...value,
                  active: value.active - 1,
                  released: value.released + 1,
                })),
            ),
          reject: () => Effect.fail(new Rejected({ message: "The worker returned a typed error" })),
        };
      }),
    ),
  { bindings: [Clock] },
);
