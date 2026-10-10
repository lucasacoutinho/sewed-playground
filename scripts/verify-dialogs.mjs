import { build } from "vite";
import { verifyNative } from "./verify-native.mjs";

await build({
  configFile: false,
  root: "scripts/dialog-renderer",
  base: "./",
  build: { outDir: "../../.artifacts/dialog-renderer", emptyOutDir: true },
});
await verifyNative({
  fixture: "scripts/dialog-fixture.mjs",
  artifact: "dialogs",
  marker: "DIALOG_VERIFICATION",
  electronArgs: ["--ozone-platform=x11"],
});
