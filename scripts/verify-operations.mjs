import { verifyNative } from "./verify-native.mjs";

await verifyNative({
  fixture: "scripts/operations-fixture.mjs",
  artifact: "operations",
  marker: "OPERATIONS_VERIFICATION",
  electronArgs: ["--ozone-platform=x11"],
});
