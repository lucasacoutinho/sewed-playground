import { Effect } from "effect";
import * as Utility from "sewed/utility";
import { Protocol } from "./utility-contract.mjs";

export default Utility.define(Protocol, (implement) =>
  implement(
    Effect.sleep(30_000).pipe(
      Effect.as({
        inspect: () => Effect.fail(new Error("pending startup")),
        increment: () => Effect.fail(new Error("pending startup")),
        route: () => Effect.fail(new Error("pending startup")),
        stream: () => Effect.fail(new Error("pending startup")),
        wait: () => Effect.fail(new Error("pending startup")),
        crash: () => Effect.fail(new Error("pending startup")),
      }),
    ),
  ),
);
