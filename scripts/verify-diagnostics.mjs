import { build } from "vite";
import react from "@vitejs/plugin-react";
import { verifyNative } from "./verify-native.mjs";

await build({
  configFile: false,
  root: "scripts/dx-renderer",
  base: "./",
  plugins: [react()],
  build: { outDir: "../../.artifacts/diagnostics-renderer", emptyOutDir: true },
});
await verifyNative({
  fixture: "scripts/diagnostics-fixture.mjs",
  artifact: "diagnostics",
  marker: "DIAGNOSTICS_VERIFICATION",
});
