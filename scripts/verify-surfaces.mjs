import { verifyNative } from "./verify-native.mjs";

await verifyNative({
  fixture: "scripts/surfaces-fixture.mjs",
  artifact: "surfaces",
  marker: "SURFACES_VERIFICATION",
  electronArgs: ["--ozone-platform=x11", "--password-store=basic"],
  // Chromium's X11 selection requests time out at 10 s when the app owns the selection it reads.
  timeout: 150_000,
});
