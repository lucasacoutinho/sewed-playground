import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { captureInputs, writeBuildEvidence } from "./verification-state.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const metadata = join(root, "dist", ".verification-build.json");
const commands = [
  ["pnpm", ["check:architecture"]],
  ["pnpm", ["exec", "vite", "build"]],
  ["pnpm", ["typecheck"]],
  ["pnpm", ["test:architecture"]],
  ["pnpm", ["exec", "tsc", "-p", "tsconfig.electron.json"]],
];

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      // pnpm is a .cmd shim on Windows, which only a shell can run.
      shell: process.platform === "win32",
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });

await rm(metadata, { force: true });
const inputsBefore = await captureInputs(root);
let failed = false;
for (const [command, args] of commands) {
  const code = await run(command, args);
  if (code !== 0) {
    process.exitCode = code;
    failed = true;
    break;
  }
}
if (!failed) await writeBuildEvidence(inputsBefore, root);
