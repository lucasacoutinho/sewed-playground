import { verifyNative } from "./verify-native.mjs";

await verifyNative({
  fixture: "scripts/session-extras-fixture.mjs",
  artifact: "session-extras",
  marker: "SESSION_EXTRAS_VERIFICATION",
  electronArgs: ["--ozone-platform=x11"],
});
