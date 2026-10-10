import { verifyNative } from "./verify-native.mjs";

await verifyNative({
  fixture: "scripts/webcontents-extras-fixture.mjs",
  artifact: "webcontents-extras",
  marker: "WEB_CONTENTS_EXTRAS_VERIFICATION",
  electronArgs: ["--ozone-platform=x11", "--no-sandbox"],
});

// A second run under a forced device scale factor: the same DIP rect (32x32) captures at double
// the pixel dimensions, and `scaleFactor` reads the forced value rather than 1.
await verifyNative({
  fixture: "scripts/webcontents-extras-fixture.mjs",
  artifact: "webcontents-extras-scale2",
  marker: "WEB_CONTENTS_EXTRAS_VERIFICATION",
  electronArgs: [
    "--ozone-platform=x11",
    "--no-sandbox",
    "--force-device-scale-factor=2",
    "--sewed-expect-scale=2",
  ],
});
