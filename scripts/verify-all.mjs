import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const skipped = new Set(["verify", "verify:all", "verify:features", "verify:devtools-development"]);
const targets = [
  "verify",
  ...Object.keys(manifest.scripts).filter((name) => name.startsWith("verify:") && !skipped.has(name)),
];
// Verifications that drive Linux-only tooling (X11 helpers, /proc) and so are not attempted on
// other platforms. Each skip is printed with its reason; nothing is skipped silently.
const linuxOnly = new Map([
  ["verify:terminal", "inspects process ownership through Linux /proc"],
  ["verify:dialogs", "drives the native dialog through an X11 helper"],
  ["verify:file-dialogs", "drives the native file dialog through an X11 helper"],
  ["verify:menus", "drives the native popup menu through an X11 helper"],
  ["verify:application-menus", "drives the menu bar through an X11 helper"],
  ["verify:desktop", "needs a D-Bus session and an X11 status notifier host"],
  ["verify:session-resources", "needs a D-Bus session for its notification checks"],
]);
const results = [];
const skips = [];
for (const target of targets) {
  const reason = process.platform === "linux" ? undefined : linuxOnly.get(target);
  if (reason !== undefined) {
    skips.push(target);
    console.log(`SKIP ${target.padEnd(30)} ${reason}`);
    continue;
  }
  const started = Date.now();
  const outcome = spawnSync("pnpm", [target], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    // pnpm is a .cmd shim on Windows, which only a shell can run.
    shell: process.platform === "win32",
  });
  const passes = (outcome.stdout.match(/^PASS /gm) ?? []).length;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ target, status: outcome.status, passes, seconds });
  console.log(`${outcome.status === 0 ? "ok  " : "FAIL"} ${target.padEnd(30)} ${String(passes).padStart(3)} checks ${seconds}s`);
  if (outcome.status !== 0) {
    const tail = `${outcome.stdout}${outcome.stderr}`.trim().split("\n").slice(process.env.CI ? -40 : -6).join("\n");
    console.log(tail.replace(/^/gm, "     "));
  }
}
const failed = results.filter((result) => result.status !== 0);
console.log(`${results.length - failed.length}/${results.length} verifications passed`);
if (skips.length > 0) console.log(`${skips.length} skipped on ${process.platform}: ${skips.join(", ")}`);
process.exit(failed.length === 0 ? 0 : 1);
