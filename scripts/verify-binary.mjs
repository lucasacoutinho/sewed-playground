import { build } from "vite";
import { verifyNative } from "./verify-native.mjs";
await build({
  configFile: false,
  root: "scripts/binary-renderer",
  base: "./",
  build: { outDir: "../../.artifacts/binary-renderer", emptyOutDir: true },
});
await verifyNative({
  fixture: "scripts/binary-fixture.mjs",
  artifact: "binary",
  marker: "BINARY_VERIFICATION",
  electronArgs: ["--ozone-platform=x11"],
});
