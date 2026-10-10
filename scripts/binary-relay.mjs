import { Effect } from "effect";
import * as Worker from "sewed/worker";
import { Protocol, UtilityBytes } from "./binary-contract.mjs";
export default Worker.define(
  Protocol,
  (implement) =>
    implement(
      Effect.gen(function* () {
        const bytes = yield* UtilityBytes();
        return bytes;
      }),
    ),
  { bindings: [UtilityBytes] },
);
