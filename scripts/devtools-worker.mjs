import { Effect, Stream } from "effect";
import * as Worker from "sewed/worker";
import { Protocol } from "./devtools-contract.mjs";

export default Worker.define(Protocol, (implement) =>
  implement({
    placement: () =>
      Effect.gen(function* () {
        yield* Effect.log("devtools-worker-placement");
        return yield* Worker.threadId;
      }),
    ticks: () =>
      Stream.concat(
        Stream.fromEffect(
          Effect.log("devtools-worker-ticks").pipe(Effect.andThen(Worker.threadId)),
        ),
        Stream.never,
      ),
    busy: () =>
      Effect.gen(function* () {
        const started = performance.now();
        while (performance.now() - started < 750) {
          // Keep this synchronous so the worker's timer sampler measures event-loop lateness.
        }
        yield* Effect.log("devtools-worker-busy");
        return 750;
      }),
  }),
);
