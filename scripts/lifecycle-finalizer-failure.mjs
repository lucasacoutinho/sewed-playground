import { Effect } from "effect";
import { Decidables, Decision } from "sewed";
import { App } from "sewed/main";

App.run(
  [],
  Effect.gen(function* () {
    yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        console.log(
          `LIFECYCLE_FINALIZER_VERIFICATION ${JSON.stringify({ success: true, checks: [{ name: "a failing application finalizer makes normal quit exit with code 1" }] })}`,
        );
        throw new Error("Expected lifecycle finalizer failure");
      }),
    );
    yield* App.quit;
  }),
);
