import { appendFileSync } from "node:fs";
import { Effect } from "effect";
import * as Utility from "sewed/utility";
import { Protocol } from "./utility-contract.mjs";

const marker = process.env.SEWED_UTILITY_FINALIZER_MARKER;
const write = (phase) => {
  if (!marker) return;
  try {
    appendFileSync(
      marker,
      `${JSON.stringify({ pid: process.pid, role: "finalizer-failure", phase, at: Date.now() })}\n`,
    );
  } catch {
    // The marker is evidence for the parent process only.
  }
};

export default Utility.define(Protocol, (implement) =>
  implement(
    Effect.acquireRelease(
      Effect.sync(() => {
        write("started");
        return {
          inspect: () =>
            Effect.succeed({
              pid: process.pid,
              type: String(process.type ?? "unknown"),
              role: "finalizer-failure",
              counter: 0,
            }),
          increment: () => Effect.fail(new Error("finalizer failure fixture")),
          route: () => Effect.fail(new Error("finalizer failure fixture")),
          stream: () => Effect.fail(new Error("finalizer failure fixture")),
          wait: () => Effect.fail(new Error("finalizer failure fixture")),
          crash: () => Effect.fail(new Error("finalizer failure fixture")),
        };
      }),
      () =>
        Effect.gen(function* () {
          write("finalized");
          yield* Effect.fail(new Error("intentional utility finalizer defect"));
        }),
    ),
  ),
);
