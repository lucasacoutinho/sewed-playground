import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { app } from "electron";
import { Effect } from "effect";
import { Decidables, Decision } from "sewed";
import { App } from "sewed/main";

// Task 4, ruling 6: `App.exit(code)` bypasses `Decidables.App.Quit` entirely and ends the process
// with exactly this code once the application scope has closed and its finalizers have run --
// Electron's own `app.exit` fires no quit event and schedules nothing after it runs (not even a
// microtask), so this process's own exit code is the assertion. Nothing here ever prints its own
// report: by design, nothing runs after `App.exit(7)` fires.
const argumentValue = (prefix) =>
  process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
const finalizerMarker = argumentValue("--sewed-app-exit-marker=");
const deciderMarker = argumentValue("--sewed-app-exit-decider-marker=");
assert.ok(finalizerMarker, "missing --sewed-app-exit-marker=<path>");
assert.ok(deciderMarker, "missing --sewed-app-exit-decider-marker=<path>");

// `App.run` is called synchronously, in this module's own first pass, with no `await` anywhere
// before it -- the entry rule from sewed-round-two's Task 3 (App.run refuses to declare after
// readiness). The declaration list here is empty, which the rule allows regardless of entry shape,
// but the synchronous shape is kept anyway so this fixture is never a counter-example to it.
function main() {
  App.run(
    [],
    Effect.gen(function* () {
      // The finalizer writes its marker only once the application scope actually closes -- proving
      // "after finalizers" is not just an ordering claim in a doc comment. It also calls `App.exit`
      // itself: a finalizer runs only once a shutdown is in progress, so that call is refused,
      // typed, and the program's 7 stands. Before the refusal existed this call parked the finalizer
      // forever and the process never exited, so the marker carries the refusal's code and the
      // verifier proves both facts at once.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const refused = yield* Effect.flip(App.exit(2));
          writeFileSync(finalizerMarker, refused.code);
        }),
      );
      // If `App.exit` ever routed through the gate, this decider would run and write its own
      // marker -- the verifier asserts that file never appears.
      yield* App.decide(
        Decidables.App.Quit,
        Decision.async(() =>
          Effect.sync(() => {
            writeFileSync(deciderMarker, "consulted");
            return "deny";
          }),
        ),
      );
      yield* App.exit(7);
    }),
  );
}

try {
  main();
} catch (error) {
  console.error(error);
  app.exit(1);
}
