import { Cause, Effect, Exit, Queue } from "effect";
import { Renderer } from "sewed";
import { Direct, Relayed } from "../transport-contract.mjs";
import { measure, measureConnections } from "../transport-measure.mjs";
import { checkLimits } from "../transport-checks.mjs";

Renderer.run(
  Renderer.entry(new URL(location.href), { bindings: [Direct, Relayed] }),
  Effect.gen(function* () {
    const commands = yield* Queue.make();
    const state = {
      ready: true,
      result: null,
      progress: null,
      start: () => Queue.offerUnsafe(commands, undefined),
    };
    window.transportBench = state;
    yield* Queue.take(commands);
    const progress = (value) => {
      state.progress = value;
    };
    const result = yield* Effect.exit(
      Effect.gen(function* () {
        const rows = yield* Effect.all(
          [
            measure("renderer-worker", Direct(), progress),
            measure("renderer-worker-dependency", Relayed(), progress),
            measureConnections("renderer-worker-deferred", Direct, progress),
          ],
          { concurrency: 1 },
        );
        progress({ phase: "limits" });
        const limits = yield* Effect.all(
          [
            checkLimits("renderer-worker", Direct()),
            checkLimits("renderer-worker-dependency", Relayed()),
          ],
          { concurrency: 1 },
        );
        return { rows: rows.flat(), limits };
      }),
    );
    state.result = Exit.isSuccess(result)
      ? { success: true, ...result.value }
      : { success: false, error: Cause.pretty(result.cause), progress: state.progress };
    yield* Effect.never;
  }),
);
