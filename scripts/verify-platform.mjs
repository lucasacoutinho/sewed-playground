import { verifyNative } from "./verify-native.mjs";

await verifyNative({
  fixture: "scripts/platform-fixture.mjs",
  artifact: "platform",
  marker: "PLATFORM_VERIFICATION",
  electronArgs: ["--ozone-platform=x11"],
});
