import { Effect } from "effect";
import * as Worker from "sewed/worker";
import { Definition } from "./remote-contract.mjs";
import { resourceHandlers } from "./remote-handlers.mjs";

const counters = {
  active: 0,
  created: 0,
  released: 0,
  streamsStarted: 0,
  streamsFinalized: 0,
};

export default Worker.define(
  Definition.protocol,
  resourceHandlers({
    counters,
    placement: Effect.gen(function* () {
      return {
        runtime: "worker",
        threadId: yield* Worker.threadId,
        processId: process.pid,
      };
    }),
  }),
);
