import { Effect } from "effect";
import * as Utility from "sewed/utility";
import { Definition } from "./remote-contract.mjs";
import { resourceHandlers } from "./remote-handlers.mjs";

const counters = {
  active: 0,
  created: 0,
  released: 0,
  streamsStarted: 0,
  streamsFinalized: 0,
};

export default Utility.define(
  Definition.protocol,
  resourceHandlers({
    counters,
    placement: Effect.gen(function* () {
      return {
        runtime: "utility",
        threadId: 0,
        processId: yield* Utility.processId,
      };
    }),
  }),
);
