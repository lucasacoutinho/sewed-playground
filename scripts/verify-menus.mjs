import { build } from "vite";
import { verifyNative } from "./verify-native.mjs";

await build({
  configFile: false,
  root: "scripts/menu-renderer",
  base: "./",
  build: { outDir: "../../.artifacts/menu-renderer", emptyOutDir: true },
});
await verifyNative({
  fixture: "scripts/menu-fixture.mjs",
  artifact: "menus",
  marker: "MENU_VERIFICATION",
  electronArgs: ["--ozone-platform=x11"],
});
