import { build } from "vite";
import react from "@vitejs/plugin-react";
import { verifyNative } from "./verify-native.mjs";

await build({
  configFile: false,
  root: "scripts/devtools-renderer",
  base: "./",
  plugins: [react()],
  build: { outDir: "../../.artifacts/devtools-renderer", emptyOutDir: true },
});
await verifyNative({
  fixture: "scripts/devtools-fixture.mjs",
  artifact: "devtools",
  marker: "DEVTOOLS_VERIFICATION",
  electronArgs: ["--ozone-platform=x11"],
});
