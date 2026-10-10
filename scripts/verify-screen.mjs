import { verifyNative } from "./verify-native.mjs";

await verifyNative({
  fixture: "scripts/screen-fixture.mjs",
  artifact: "screen",
  marker: "SCREEN_VERIFICATION",
  electronArgs: ["--ozone-platform=x11"],
});
