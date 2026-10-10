import { verifyNative } from "./verify-native.mjs";

await verifyNative({
  fixture: "scripts/resource-inspection-fixture.mjs",
  artifact: "resource-inspection",
  marker: "RESOURCE_INSPECTION_VERIFICATION",
  electronArgs: ["--ozone-platform=x11"],
});
