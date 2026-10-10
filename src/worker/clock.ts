import { Effect, Stream } from "effect";
import * as Worker from "sewed/worker";
import { ClockProtocol } from "../shared/contracts.js";

export default Worker.define(ClockProtocol, (implement) =>
  implement(
    Effect.gen(function* () {
      const thread = yield* Worker.threadId;
      yield* Effect.addFinalizer(() =>
        Effect.annotateLogs(Effect.logInfo("playground.clock.stopped"), { thread }),
      );

      return {
        ticks: () =>
          Stream.scoped(
            Stream.fromEffect(
              Effect.acquireRelease(
                Effect.annotateLogs(Effect.logInfo("playground.clock.acquired"), { thread }),
                () => Effect.annotateLogs(Effect.logInfo("playground.clock.released"), { thread }),
              ),
            ).pipe(
              Stream.flatMap(() =>
                Stream.tick(100).pipe(
                  Stream.scan(() => 0, (ticks) => ticks + 1),
                  Stream.map((ticks) => ({ thread, ticks })),
                ),
              ),
            ),
          ),
      };
    }),
  ),
);
