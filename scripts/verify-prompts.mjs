import { verifyNative } from "./verify-native.mjs";

// Dialogs, popup menus, the tray and the application menu on every platform: each is opened for
// real and closed by the program (an interruption, a closing window, a closing scope), which
// needs no desktop automation. What a person does with them is verified on Linux by the
// verifications that drive X11.
await verifyNative({
  fixture: "scripts/prompts-fixture.mjs",
  artifact: "prompts",
  marker: "PROMPTS_VERIFICATION",
  electronArgs: ["--ozone-platform=x11"],
});
