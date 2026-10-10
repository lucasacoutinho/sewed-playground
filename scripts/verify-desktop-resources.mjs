import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { build } from "vite";
import { verifyNative } from "./verify-native.mjs";

const artifactDirectory = resolve(".artifacts");
await mkdir(artifactDirectory, { recursive: true });
if (!process.env.DBUS_SESSION_BUS_ADDRESS) {
  throw new Error("Run desktop resources acceptance under dbus-run-session");
}
if (!process.env.DISPLAY) {
  throw new Error("Run desktop resources acceptance through scripts/with-xvfb.py");
}
await build({
  configFile: false,
  root: resolve("scripts/desktop-resources-renderer"),
  base: "./",
  build: {
    outDir: resolve(".artifacts/desktop-resources-renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: [
        resolve("scripts/desktop-resources-renderer/index.html"),
        resolve("scripts/desktop-resources-renderer/unbound.html"),
      ],
    },
  },
});
const fixtureRoot = await mkdtemp(`${artifactDirectory}/desktop-resources-native-`);
const profileDirectory = `${fixtureRoot}/user-data`;
const artifact = `desktop-resources-${basename(fixtureRoot)}`;

try {
  const report = await verifyNative({
    fixture: resolve("scripts/desktop-resources-fixture.mjs"),
    artifact,
    marker: "DESKTOP_RESOURCES_VERIFICATION",
    electronArgs: [
      "--ozone-platform=x11",
      `--user-data-dir=${profileDirectory}`,
      `--sewed-desktop-root=${fixtureRoot}`,
    ],
  });
  await writeFile(
    `${fixtureRoot}/verification-summary.json`,
    `${JSON.stringify({ success: true, artifact, fixtureRoot, report }, null, 2)}\n`,
  );
} catch (error) {
  await writeFile(
    `${fixtureRoot}/verification-summary.json`,
    `${JSON.stringify({ success: false, artifact, fixtureRoot, error: error.stack ?? String(error) }, null, 2)}\n`,
  );
  throw error;
} finally {
  // Keep the task-local report/log directory. Remove only Electron's owned profile.
  await rm(profileDirectory, { recursive: true, force: true });
}
