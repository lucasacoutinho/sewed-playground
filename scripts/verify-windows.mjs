import { verifyNative } from "./verify-native.mjs";

const args = process.argv.slice(2);
const count = args.length === 0 ? 1 : Number(args[1]);
if (
  (args.length !== 0 && (args.length !== 2 || args[0] !== "--repeat")) ||
  !Number.isSafeInteger(count) ||
  count < 1 ||
  count > 100
)
  throw new Error("Usage: verify-windows.mjs [--repeat <1-100>]");

const prefix = `windows-repeat-${Date.now()}`;
for (let run = 1; run <= count; run++) {
  await verifyNative({
    fixture: "scripts/window-controls-fixture.mjs",
    artifact: count === 1 ? "windows" : `${prefix}-${run}`,
    marker: "WINDOW_CONTROLS_VERIFICATION",
    electronArgs: ["--ozone-platform=x11"],
  });
  if (count > 1)
    console.log(
      `Window verification ${run}/${count} passed; evidence: .artifacts/${prefix}-${run}-verification.json`,
    );
}
