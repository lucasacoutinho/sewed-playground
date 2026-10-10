import { verifyNative } from "./verify-native.mjs";

await verifyNative({
  fixture: "scripts/forge-fixture.mjs",
  artifact: "forge",
  marker: "FORGE_VERIFICATION",
  electronArgs: ["--ozone-platform=x11"],
});
