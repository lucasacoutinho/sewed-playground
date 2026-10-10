import { verifyNative } from "./verify-native.mjs";

await verifyNative({
  fixture: "scripts/webcontents-fixture.mjs",
  artifact: "webcontents",
  marker: "WEB_CONTENTS_VERIFICATION",
});
