import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const electron = createRequire(import.meta.url)("electron");

export async function verifyNative({
  fixture,
  artifact,
  marker,
  electronArgs = [],
  expectedExitCode = 0,
  timeout = 55_000,
  env: extraEnvironment = {},
  // `requireReport: false` is for a fixture that is expected to fail before it can ever print its
  // own marker line (e.g. a startup refusal) -- success then rests on exitCode/stderrPatterns
  // alone. `stderrPatterns` are RegExps the raw captured stderr must all match; this is a
  // process-observed check (the verifier reads the child's own stderr stream), not a claim the
  // fixture makes about itself.
  requireReport = true,
  stderrPatterns = [],
}) {
  await mkdir(".artifacts", { recursive: true });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let exitCode = null;
  let signal = null;
  let launchError;
  let timeoutTimer;
  let killTimer;

  try {
    const child = spawn(electron, [...electronArgs, fixture], {
      cwd: process.cwd(),
      env: {
        ...inheritedEnvironment(),
        DISPLAY: process.env.DISPLAY || ":0",
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/mnt/wslg/runtime-dir",
        ...extraEnvironment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.once("error", (error) => {
      launchError = error;
    });

    await new Promise((resolve) => {
      let closed = false;
      child.once("close", (code, childSignal) => {
        closed = true;
        exitCode = code;
        signal = childSignal;
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        resolve();
      });
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!closed) child.kill("SIGKILL");
        }, 5_000);
        killTimer.unref();
      }, timeout);
      timeoutTimer.unref();
    });
  } catch (error) {
    launchError = error;
  } finally {
    clearTimeout(timeoutTimer);
    clearTimeout(killTimer);
  }

  let report;
  const prefix = `${marker} `;
  const line = stdout.split(/\r?\n/).findLast((line) => line.startsWith(prefix));
  if (line !== undefined) {
    try {
      report = JSON.parse(line.slice(prefix.length));
    } catch (error) {
      launchError = error;
    }
  }
  const stderrMismatches = stderrPatterns.filter((pattern) => !pattern.test(stderr));
  const success =
    !timedOut &&
    !launchError &&
    exitCode === expectedExitCode &&
    (!requireReport || report?.success === true) &&
    stderrMismatches.length === 0;
  await writeFile(
    `.artifacts/${artifact}-verification.json`,
    `${JSON.stringify(
      {
        success,
        exitCode,
        expectedExitCode,
        signal,
        timedOut,
        report: report ?? null,
        stderrMismatches: stderrMismatches.map((pattern) => pattern.source),
        error: launchError?.stack,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    `.artifacts/${artifact}-electron.log`,
    `--- stdout ---\n${stdout}--- stderr ---\n${stderr}`,
  );
  for (const check of report?.checks ?? []) console.log(`PASS ${check.name}`);
  if (!success) {
    throw new Error(
      timedOut
        ? `${artifact} verification timed out after ${timeout} ms`
        : stderrMismatches.length > 0
          ? `${artifact} stderr did not match ${stderrMismatches.map((pattern) => pattern.source).join(", ")}; stderr was: ${stderr}`
          : report?.error ||
              launchError?.message ||
              `Electron exited with code ${exitCode ?? "unknown"}`,
    );
  }
  return report;
}

export function inheritedEnvironment() {
  const { FORCE_COLOR: _force, CLICOLOR_FORCE: _clicolor, ...environment } = process.env;
  return { ...environment, NO_COLOR: "1" };
}
