import { verifyNative } from "./verify-native.mjs";

await verifyNative({
  fixture: "scripts/responsiveness-fixture.mjs",
  artifact: "responsiveness",
  marker: "RESPONSIVENESS_VERIFICATION",
  electronArgs: ["--no-sandbox"],
});
