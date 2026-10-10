import { build } from "vite";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { verifyNative } from "./verify-native.mjs";

await build({
  configFile: false,
  root: "scripts/application-menu-renderer",
  base: "./",
  build: { outDir: "../../.artifacts/application-menu-renderer", emptyOutDir: true },
});
const cases = [];
const execFileAsync = promisify(execFile);
await writeFile(
  ".artifacts/application-menus-verification.json",
  JSON.stringify({ success: false, cases }),
);
for (const scenario of ["full", "none", "invalid", "construction", "installation"]) {
  const result = await verifyNative({
    fixture: "scripts/application-menu-fixture.mjs",
    artifact: `application-menus-${scenario}`,
    marker: "APPLICATION_MENU_VERIFICATION",
    electronArgs: ["--ozone-platform=x11", `--sewed-menu-case=${scenario}`],
    expectedExitCode: ["invalid", "construction", "installation"].includes(scenario) ? 1 : 0,
  });
  if (scenario === "full") {
    let remaining;
    const deadline = Date.now() + 2_000;
    do {
      const { stdout } = await execFileAsync(
        "python3",
        ["scripts/menu-window.py", String(result.pid), String(result.lastWindow)],
        { timeout: 2_000 },
      );
      remaining = JSON.parse(stdout);
      if (remaining.length === 0) break;
      await setTimeout(10);
    } while (Date.now() < deadline);
    assert.deepEqual(remaining, []);
    const name = "the native submenu disappears when its owning Electron process exits";
    result.checks.push({ name, evidence: { remaining } });
    console.log(`PASS ${name}`);
  }
  cases.push(result);
}
await writeFile(
  ".artifacts/application-menus-verification.json",
  `${JSON.stringify({ success: true, report: { checks: cases.flatMap((result) => result.checks), cases } }, null, 2)}\n`,
);
