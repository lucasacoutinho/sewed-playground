import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyNative } from "./verify-native.mjs";

await mkdir(".artifacts", { recursive: true });
const root = await mkdtemp(path.resolve(".artifacts/lifecycle-foundations-"));
const profile = path.join(root, "user-data");
const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "lifecycle-foundations-fixture.mjs",
);
try {
  const report = await verifyNative({
    fixture,
    artifact: "lifecycle-foundations",
    marker: "LIFECYCLE_FOUNDATIONS_VERIFICATION",
    electronArgs: [
      "--ozone-platform=x11",
      `--user-data-dir=${profile}`,
      `--sewed-lifecycle-root=${root}`,
    ],
  });
  assert.equal(report.success, true);
  const failedFinalizer = await verifyNative({
    fixture: path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "lifecycle-finalizer-failure.mjs",
    ),
    artifact: "lifecycle-finalizer-failure",
    marker: "LIFECYCLE_FINALIZER_VERIFICATION",
    electronArgs: ["--ozone-platform=x11", `--user-data-dir=${profile}`],
    expectedExitCode: 1,
  });
  report.checks.push(...failedFinalizer.checks);
  await writeFile(
    path.join(root, "verification-summary.json"),
    `${JSON.stringify({ success: true, report }, null, 2)}\n`,
  );
  console.log(`Lifecycle foundations report: ${path.join(root, "verification-summary.json")}`);
} catch (error) {
  await writeFile(
    path.join(root, "verification-summary.json"),
    `${JSON.stringify({ success: false, error: error.stack || String(error) }, null, 2)}\n`,
  );
  throw error;
} finally {
  await rm(profile, { recursive: true, force: true });
}
