import { appendFileSync } from "node:fs";
import { Effect, Stream } from "effect";
import * as Utility from "sewed/utility";
import {
  MainBinding,
  NegativeDelta,
  Protocol,
  UtilityBinding,
  WorkerBinding,
} from "./utility-contract.mjs";

const role = new URL(import.meta.url).searchParams.get("role") ?? "dependent";
const marker = process.env.SEWED_UTILITY_FINALIZER_MARKER;
const streamMarker = process.env.SEWED_UTILITY_STREAM_MARKER;
const unaryMarker = process.env.SEWED_UTILITY_UNARY_MARKER;

const writeMarker = (file, value) => {
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify(value)}\n`);
  } catch {
    // The acceptance harness observes the marker when the owner is still live.
  }
};

const identity = (state, pid, counter = state.counter) => ({
  pid,
  type: String(process.type ?? "unknown"),
  role,
  counter,
});

const handlers = (implement) =>
  implement(
    Effect.gen(function* () {
      const pid = yield* Utility.processId;
      const state = yield* Effect.acquireRelease(
        Effect.sync(() => ({ counter: 0 })),
        () =>
          Effect.promise(
            () =>
              new Promise((resolve) => {
                setTimeout(() => {
                  writeMarker(marker, {
                    pid,
                    role,
                    phase: "finalized",
                    at: Date.now(),
                  });
                  resolve();
                }, 80);
              }),
          ),
      );
      const main = role === "base" ? undefined : yield* MainBinding();
      const worker = role === "base" ? undefined : yield* WorkerBinding();
      const utility = role === "base" ? undefined : yield* UtilityBinding();
      return {
        inspect: () => Effect.sync(() => identity(state, pid)),
        increment: ({ delta }) =>
          delta < 0
            ? Effect.fail(new NegativeDelta({ delta }))
            : Effect.sync(() => {
                state.counter += delta;
                return identity(state, pid);
              }),
        route: () =>
          role === "base"
            ? Effect.fail(new Error("base utility has no dependency route"))
            : Effect.all({
                main: main.inspect(),
                worker: worker.inspect(),
                utility: utility.inspect(),
              }),
        stream: ({ count, delayMs }) =>
          Stream.fromIterable(Array.from({ length: Math.max(0, count) }, (_, index) => index)).pipe(
            Stream.mapEffect((index) =>
              Effect.sleep(Math.max(0, delayMs)).pipe(Effect.as(identity(state, pid, index))),
            ),
            Stream.concat(Stream.never),
            Stream.ensuring(
              Effect.sync(() =>
                writeMarker(streamMarker, {
                  pid,
                  role,
                  phase: "stream-finalized",
                  at: Date.now(),
                }),
              ),
            ),
          ),
        wait: ({ milliseconds }) =>
          Effect.sleep(Math.max(0, milliseconds)).pipe(
            Effect.as(identity(state, pid)),
            Effect.ensuring(
              Effect.sync(() =>
                writeMarker(unaryMarker, {
                  pid,
                  role,
                  phase: "wait-finalized",
                  at: Date.now(),
                }),
              ),
            ),
          ),
        crash: () =>
          Effect.sync(() => {
            process.kill(process.pid, "SIGKILL");
            return "unreachable";
          }),
      };
    }),
  );

export default role === "base"
  ? Utility.define(Protocol, handlers)
  : Utility.define(Protocol, handlers, {
      bindings: [MainBinding, WorkerBinding, UtilityBinding],
    });
