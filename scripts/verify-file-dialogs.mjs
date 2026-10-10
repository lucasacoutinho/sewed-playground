import { build } from "vite";
import { verifyNative } from "./verify-native.mjs";

await build({
  configFile: false,
  root: "scripts/file-dialog-renderer",
  base: "./",
  build: { outDir: "../../.artifacts/file-dialog-renderer", emptyOutDir: true },
});
await verifyNative({
  fixture: "scripts/file-dialog-fixture.mjs",
  artifact: "file-dialogs",
  marker: "FILE_DIALOG_VERIFICATION",
  electronArgs: ["--ozone-platform=x11", "--xdg-portal-required-version=999", "--lang=en-US"],
  // Electron 44 opens the portal chooser whenever a session bus answers, regardless of the
  // required-version switch; an unreachable bus keeps the in-process GTK chooser the fixture drives.
  env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/sewed-bus" },
});
