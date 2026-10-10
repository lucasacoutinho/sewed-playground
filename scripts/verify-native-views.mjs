import { build } from "vite";
import react from "@vitejs/plugin-react";
import { verifyNative } from "./verify-native.mjs";

await build({
  configFile: false,
  root: "scripts/dx-renderer",
  base: "./",
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "../../.artifacts/native-views-production-renderer",
    emptyOutDir: true,
  },
});

await verifyNative({
  fixture: "scripts/native-views-fixture.mjs",
  artifact: "native-views",
  marker: "NATIVE_VIEWS_VERIFICATION",
  electronArgs: ["--ozone-platform=x11"],
});
