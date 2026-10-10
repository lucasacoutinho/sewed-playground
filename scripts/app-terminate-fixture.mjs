import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { app } from "electron";
import { Effect } from "effect";
import { App } from "sewed/main";

// Task 2 (fully-on-sewed wave 1), ruling 4: this is the harness shape App.terminate exists for.
// The program's own finalizer would write its "started" marker and then hang forever
// (Effect.never), simulating a finalizer that would never finish -- exactly what a harness's own
// timeout must survive regardless. App.terminate ends the process at once, consulting no
// finalizer, no listener and no quit decider, so that marker must never appear.
const argumentValue = (prefix) =>
  process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
const finalizerMarker = argumentValue("--sewed-app-terminate-marker=");
assert.ok(finalizerMarker, "missing --sewed-app-terminate-marker=<path>");

// `App.run` is called synchronously, in this module's own first pass, with an empty declaration
// list -- always allowed, ready or not.
function main() {
  App.run(
    [],
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          writeFileSync(finalizerMarker, "started");
          yield* Effect.never;
        }),
      );
      yield* Effect.never;
    }),
  );
}

try {
  main();
} catch (error) {
  console.error(error);
  app.exit(1);
}

// A harness's own timeout: it must answer the shell even when the program's finalizers would
// never finish. `App.terminate(3)`, called from outside any Effect and consulting nothing, is that
// answer -- the process below is never given the chance to close its scope or run its finalizer.
setTimeout(() => {
  App.terminate(3);
}, 500);
