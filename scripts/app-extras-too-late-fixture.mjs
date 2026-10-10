import { app } from "electron";
import { Effect } from "effect";
import { App, CommandLine } from "sewed/main";

// Task 3 (App.run refuses to declare after readiness): this entry demonstrates the shape the fix
// targets, not a contrived one. `main` is an `async function` that is never awaited at the top
// level of this ES module -- per the readiness probe (sewed-round-two, .artifacts/probe-ready,
// Case 3), `ready` fires almost immediately once this module's own synchronous top level finishes,
// independent of and well before `main`'s internal `await app.whenReady()` resolves. By the time
// `App.run` runs below, Electron is already ready, so its non-empty declaration list must be
// refused -- loudly, at Startup -- instead of the switch silently having no effect.
async function main() {
  await app.whenReady();
  App.run([CommandLine.declare({ name: "sewed-too-late", value: "on" })], Effect.void);
}

void main();
