import { build } from "vite";
import { verifyNative } from "./verify-native.mjs";

await build({
  configFile: false,
  root: "scripts/remote-renderer",
  base: "./",
  build: {
    outDir: "../../.artifacts/remote-renderer",
    emptyOutDir: true,
  },
});

await verifyNative({
  fixture: "scripts/remote-fixture.mjs",
  artifact: "remote",
  marker: "REMOTE_VERIFICATION",
  electronArgs: ["--ozone-platform=x11"],
});
