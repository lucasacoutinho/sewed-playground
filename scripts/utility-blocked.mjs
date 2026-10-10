import { appendFileSync } from "node:fs";
import { Effect } from "effect";
import * as Utility from "sewed/utility";
import { Protocol } from "./utility-contract.mjs";

const marker = process.env.SEWED_UTILITY_FINALIZER_MARKER;
const write = (phase) => {
  if (!marker) return;
  try {
    appendFileSync(marker, `${JSON.stringify({ pid: process.pid, phase, at: Date.now() })}\n`);
  } catch {
    // The marker is diagnostic evidence only.
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
              role: "blocked",
              counter: 0,
            }),
          increment: () => Effect.fail(new Error("blocked fixture")),
          route: () => Effect.fail(new Error("blocked fixture")),
          stream: () => Effect.fail(new Error("blocked fixture")),
          wait: () => Effect.fail(new Error("blocked fixture")),
          crash: () => Effect.fail(new Error("blocked fixture")),
        };
      }),
      () =>
        Effect.promise(
          () =>
            new Promise((resolve) => {
              setTimeout(() => {
                write("released");
                resolve();
              }, 30_000);
            }),
        ),
    ),
  ),
);
