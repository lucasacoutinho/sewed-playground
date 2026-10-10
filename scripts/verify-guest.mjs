import { verifyNative } from "./verify-native.mjs";

await verifyNative({
  fixture: "scripts/guest-fixture.mjs",
  artifact: "guest",
  marker: "GUEST_VERIFICATION",
  electronArgs: ["--ozone-platform=x11"],
  timeout: 120_000,
});
