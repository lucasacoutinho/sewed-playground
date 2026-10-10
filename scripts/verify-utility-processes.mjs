import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { verifyNative } from "./verify-native.mjs";

const artifactDirectory = path.resolve(".artifacts");
const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const evidenceDirectory = process.env.SEWED_UTILITY_EVIDENCE_ROOT;

await mkdir(artifactDirectory, { recursive: true });
await build({
  configFile: false,
  root: path.join(fixtureDirectory, "utility-process-renderer"),
  base: "./",
  build: {
    outDir: path.join(artifactDirectory, "utility-process-renderer"),
    emptyOutDir: true,
  },
});

const fixtureRoot = await mkdtemp(path.join(artifactDirectory, "utility-process-native-"));
const profileDirectory = path.join(fixtureRoot, "user-data");
const artifact = `utility-processes-${path.basename(fixtureRoot)}`;
const fixture = path.join(fixtureDirectory, "utility-process-fixture.mjs");

try {
  const report = await verifyNative({
    fixture,
    artifact,
    marker: "UTILITY_PROCESS_VERIFICATION",
    electronArgs: [
      "--ozone-platform=x11",
      `--user-data-dir=${profileDirectory}`,
      `--sewed-utility-root=${fixtureRoot}`,
    ],
  });
  assert.equal(report.success, true);
  const summary = { success: true, artifact, fixtureRoot, report };
  await writeFile(
    path.join(fixtureRoot, "verification-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  if (evidenceDirectory !== undefined) {
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(
      path.join(evidenceDirectory, "verification-summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    await copyFile(
      path.join(artifactDirectory, `${artifact}-verification.json`),
      path.join(evidenceDirectory, "utility-processes-verification.json"),
    );
    await copyFile(
      path.join(artifactDirectory, `${artifact}-electron.log`),
      path.join(evidenceDirectory, "utility-processes-electron.log"),
    );
  }
  console.log(`Utility process report: ${path.join(fixtureRoot, "verification-summary.json")}`);
} catch (error) {
  const failure = {
    success: false,
    artifact,
    fixtureRoot,
    error: error.stack ?? String(error),
  };
  await writeFile(
    path.join(fixtureRoot, "verification-summary.json"),
    `${JSON.stringify(failure, null, 2)}\n`,
  );
  if (evidenceDirectory !== undefined) {
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(
      path.join(evidenceDirectory, "verification-summary.json"),
      `${JSON.stringify(failure, null, 2)}\n`,
    );
  }
  throw error;
} finally {
  await rm(profileDirectory, { recursive: true, force: true });
}
