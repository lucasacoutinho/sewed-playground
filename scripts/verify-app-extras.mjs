import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { verifyNative } from "./verify-native.mjs";

// Task 3 ("declared, therefore present"): a `logs` path three parent levels deep under a fresh
// temp directory that does not exist. The verifier -- not the app -- checks it exists once the
// program has run, because the claim is about what a process outside Electron can observe on
// disk, not what the app believes about its own call.
const logsRoot = await mkdtemp(path.join(os.tmpdir(), "sewed-app-extras-logs-"));
const logsTarget = path.join(logsRoot, "declared", "three", "levels");
assert.equal(existsSync(logsTarget), false, "the logs target must not exist before the run");

try {
  await verifyNative({
    fixture: "scripts/app-extras-fixture.mjs",
    artifact: "app-extras",
    marker: "APP_EXTRAS_VERIFICATION",
    electronArgs: ["--ozone-platform=x11", `--sewed-app-extras-logs=${logsTarget}`],
  });
  assert.equal(
    existsSync(logsTarget),
    true,
    "Paths.declare({ logs }) must create the directory before the program runs",
  );
  console.log("PASS a logs path declared three levels deep exists once the program runs");

  // Task 3 ("App.run refuses to declare after readiness"): a separate entry, because the shape
  // under test is the entry's -- an `async function main` awaited internally but never awaited at
  // the top level. The fixture never gets to print its own report (the refusal fires before any of
  // its own code would); `requireReport: false` is why `verifyNative` does not wait for one, and
  // `stderrPatterns` reads the child's actual stderr stream, the same process-observed rule as the
  // `logs` check above.
  await verifyNative({
    fixture: "scripts/app-extras-too-late-fixture.mjs",
    artifact: "app-extras-too-late",
    marker: "APP_EXTRAS_TOO_LATE_VERIFICATION",
    electronArgs: ["--ozone-platform=x11"],
    expectedExitCode: 1,
    requireReport: false,
    stderrPatterns: [
      /App\.run was called after Electron was ready, so its declarations cannot apply/,
      // Task 1 (fully-on-sewed wave 1), ruling 2's queued item: App.run's own failure print names
      // the SewedError's code before the pretty cause, so stderr says what failed even where no
      // error box can show.
      /^Startup: App\.run was called after Electron was ready/m,
    ],
  });
  console.log(
    "PASS App.run called from an entry that let Electron become ready first exits 1 with the readiness message on stderr",
  );

  // Task 1 (fully-on-sewed wave 1), ruling 2: App.showErrorBox prints to stderr and returns at
  // once before readiness, with or without a display -- the pre-readiness print is the
  // process-observed fact this checks, not a claim the fixture makes about itself.
  await verifyNative({
    fixture: "scripts/app-error-box-fixture.mjs",
    artifact: "app-error-box",
    marker: "APP_ERROR_BOX_VERIFICATION",
    electronArgs: ["--ozone-platform=x11"],
    expectedExitCode: 0,
    stderrPatterns: [/Sewed error box/, /before readiness/],
  });
  console.log("PASS App.showErrorBox prints its title and content to stderr before readiness");
} finally {
  await rm(logsRoot, { recursive: true, force: true });
}

// Task 2 (fully-on-sewed wave 1), ruling 4: App.terminate ends the process at once, consulting no
// finalizer -- unlike App.exit, whose own verify-app.mjs check proves the opposite (a finalizer
// runs and is awaited). The fixture's finalizer would write this marker and then hang forever; its
// absence, together with the verifier's own bound (exitCode 3, not a timeout), is the proof.
const terminateRoot = await mkdtemp(path.join(os.tmpdir(), "sewed-app-terminate-"));
const terminateMarker = path.join(terminateRoot, "finalizer-started");
try {
  await verifyNative({
    fixture: "scripts/app-terminate-fixture.mjs",
    artifact: "app-terminate",
    marker: "APP_TERMINATE_VERIFICATION",
    electronArgs: ["--ozone-platform=x11", `--sewed-app-terminate-marker=${terminateMarker}`],
    expectedExitCode: 3,
    requireReport: false,
  });
  assert.equal(
    existsSync(terminateMarker),
    false,
    "App.terminate must not run the program's finalizer",
  );
  console.log(
    "PASS App.terminate(3) ends the process at once, without running the program's own finalizer",
  );
} finally {
  await rm(terminateRoot, { recursive: true, force: true });
}
