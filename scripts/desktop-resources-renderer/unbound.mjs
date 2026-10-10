import { Cause, Effect, Match } from "effect";
import { Renderer } from "sewed";
import { TrayEventsSlot } from "../desktop-resources-contract.mjs";

Renderer.run(
  Renderer.entry(new URL(location.href), { bindings: [] }),
  Effect.gen(function* () {
    const state = {
      bound: false,
      session: crypto.randomUUID(),
      events: [],
    };
    const attempted = yield* Effect.exit(TrayEventsSlot());
    state.access = Match.value(attempted).pipe(
      Match.tag("Success", () => ({ tag: "Success" })),
      Match.tag("Failure", ({ cause }) => {
        const error = Cause.findErrorOption(cause);
        return {
          tag: "Failure",
          error:
            error._tag === "Some"
              ? { code: error.value.code, message: error.value.message }
              : { message: Cause.pretty(cause) },
        };
      }),
      Match.exhaustive,
    );
    window.desktopResourcesUnbound = state;
  }),
);
