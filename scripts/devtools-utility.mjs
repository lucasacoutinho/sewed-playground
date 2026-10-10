import { Effect, Stream } from "effect";
import * as Utility from "sewed/utility";
import { Protocol } from "./devtools-contract.mjs";

export default Utility.define(Protocol, (implement) =>
  implement({
    placement: () =>
      Effect.gen(function* () {
        yield* Effect.log("devtools-utility-placement");
        return yield* Utility.processId;
      }),
    ticks: () =>
      Stream.concat(
        Stream.fromEffect(
          Effect.log("devtools-utility-ticks").pipe(Effect.andThen(Utility.processId)),
        ),
        Stream.never,
      ),
    busy: () => Effect.succeed(0),
  }),
);
