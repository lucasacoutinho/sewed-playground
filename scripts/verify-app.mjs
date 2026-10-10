import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { verifyNative } from "./verify-native.mjs";

await verifyNative({
  fixture: "scripts/app-lifecycle-fixture.mjs",
  artifact: "app",
  marker: "APP_LIFECYCLE_VERIFICATION",
});

// Task 4, ruling 6 (App.exit bypasses the quit decider and exits with an exact code once
// finalizers have run): a separate entry and process, because the exit code itself -- not a
// printed report -- is the assertion, and by design nothing runs in the fixture after
// `app.exit(7)` fires (Electron's own `app.exit` fires no quit event and schedules nothing after
// it, not even a microtask). `requireReport: false` is why `verifyNative` does not wait for one.
const exitRoot = await mkdtemp(path.join(os.tmpdir(), "sewed-app-exit-"));
const exitMarker = path.join(exitRoot, "finalizer-ran");
const deciderMarker = path.join(exitRoot, "decider-consulted");
try {
  await verifyNative({
    fixture: "scripts/app-exit-fixture.mjs",
    artifact: "app-exit",
    marker: "APP_EXIT_VERIFICATION",
    electronArgs: [
      "--ozone-platform=x11",
      `--sewed-app-exit-marker=${exitMarker}`,
      `--sewed-app-exit-decider-marker=${deciderMarker}`,
    ],
    expectedExitCode: 7,
    requireReport: false,
  });
  assert.equal(existsSync(exitMarker), true, "the finalizer must run before App.exit(7) fires");
  assert.equal(
    readFileSync(exitMarker, "utf8"),
    "Closed",
    "a finalizer's own App.exit is refused Closed once shutdown is in progress, and 7 stands",
  );
  assert.equal(
    existsSync(deciderMarker),
    false,
    "App.exit must never consult the installed deny decider",
  );
  console.log(
    "PASS App.exit(7) closes the application scope, runs its finalizer (whose own App.exit is refused Closed), and exits 7 without consulting the quit decider",
  );
} finally {
  await rm(exitRoot, { recursive: true, force: true });
}

// Task 4, ruling 7 (App.preferredSystemLanguages is synchronous and read before readiness): a
// declaration thunk reads it under a forced `LANGUAGE=fr` environment and declares `--lang=fr`;
// the fixture then asserts the value reached a live renderer's own `navigator.language`.
await verifyNative({
  fixture: "scripts/app-languages-fixture.mjs",
  artifact: "app-languages",
  marker: "APP_LANGUAGES_VERIFICATION",
  electronArgs: ["--ozone-platform=x11"],
  env: { LANGUAGE: "fr" },
});
