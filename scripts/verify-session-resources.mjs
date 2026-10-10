import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { verifyNative } from "./verify-native.mjs";

if (!process.env.DBUS_SESSION_BUS_ADDRESS) {
  throw new Error("Run session resources acceptance under dbus-run-session");
}
if (!process.env.DISPLAY) {
  throw new Error("Run session resources acceptance through scripts/with-xvfb.py");
}

const artifactDirectory = resolve(".artifacts");
await mkdir(artifactDirectory, { recursive: true });
const fixtureRoot = await mkdtemp(join(artifactDirectory, "session-resources-native-"));
const profileDirectory = join(fixtureRoot, "user-data");
const artifact = `session-resources-${basename(fixtureRoot)}`;

try {
  const report = await verifyNative({
    fixture: resolve("scripts/session-resources-fixture.mjs"),
    artifact,
    marker: "SESSION_RESOURCES_VERIFICATION",
    electronArgs: ["--ozone-platform=x11", `--user-data-dir=${profileDirectory}`],
  });
  await writeFile(
    join(fixtureRoot, "verification-summary.json"),
    `${JSON.stringify({ success: true, artifact, fixtureRoot, report }, null, 2)}\n`,
  );
} catch (error) {
  await writeFile(
    join(fixtureRoot, "verification-summary.json"),
    `${JSON.stringify(
      { success: false, artifact, fixtureRoot, error: error.stack ?? String(error) },
      null,
      2,
    )}\n`,
  );
  throw error;
} finally {
  await rm(profileDirectory, { recursive: true, force: true });
}
