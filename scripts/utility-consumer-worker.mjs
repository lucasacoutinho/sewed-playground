import { Effect } from "effect";
import * as Worker from "sewed/worker";
import { ConsumerBinding, NegativeDelta, Protocol } from "./utility-contract.mjs";

const role = new URL(import.meta.url).searchParams.get("role") ?? "service";

const service = Worker.define(Protocol, (implement) =>
  implement(
    Effect.gen(function* () {
      const threadId = yield* Worker.threadId;
      let counter = 0;
      return {
        inspect: () =>
          Effect.sync(() => ({
            pid: process.pid,
            type: String(process.type ?? "worker"),
            role: "worker-service",
            counter,
          })),
        increment: ({ delta }) =>
          delta < 0
            ? Effect.fail(new NegativeDelta({ delta }))
            : Effect.sync(() => {
                counter += delta;
                return {
                  pid: process.pid,
                  type: String(process.type ?? "worker"),
                  role: `worker-service-${threadId}`,
                  counter,
                };
              }),
        route: () => Effect.fail(new Error("worker service has no dependency route")),
        stream: () => Effect.fail(new Error("worker service stream is fixture-only")),
        wait: () => Effect.fail(new Error("worker service wait is fixture-only")),
        crash: () => Effect.fail(new Error("worker service cannot crash the fixture")),
      };
    }),
  ),
);

const consumer = Worker.define(
  Protocol,
  (implement) =>
    implement(
      Effect.gen(function* () {
        const utility = yield* ConsumerBinding();
        return {
          inspect: () => utility.inspect(),
          increment: ({ delta }) => utility.increment({ delta }),
          route: () => utility.route(),
          stream: ({ count, delayMs }) => utility.stream({ count, delayMs }),
          wait: ({ milliseconds }) => utility.wait({ milliseconds }),
          crash: () => utility.crash(),
        };
      }),
    ),
  { bindings: [ConsumerBinding] },
);

export default role === "consumer" ? consumer : service;
