import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const skipped = new Set(["verify", "verify:all", "verify:features", "verify:devtools-development"]);
const targets = [
  "verify",
  ...Object.keys(manifest.scripts).filter((name) => name.startsWith("verify:") && !skipped.has(name)),
];
const results = [];
for (const target of targets) {
  const started = Date.now();
  const outcome = spawnSync("pnpm", [target], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  const passes = (outcome.stdout.match(/^PASS /gm) ?? []).length;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ target, status: outcome.status, passes, seconds });
  console.log(`${outcome.status === 0 ? "ok  " : "FAIL"} ${target.padEnd(30)} ${String(passes).padStart(3)} checks ${seconds}s`);
  if (outcome.status !== 0) {
    const tail = `${outcome.stdout}${outcome.stderr}`.trim().split("\n").slice(-6).join("\n");
    console.log(tail.replace(/^/gm, "     "));
  }
}
const failed = results.filter((result) => result.status !== 0);
console.log(`${results.length - failed.length}/${results.length} verifications passed`);
process.exit(failed.length === 0 ? 0 : 1);
