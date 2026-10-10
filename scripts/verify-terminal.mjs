import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = join(projectRoot, ".artifacts", "terminal");
const maxOutputBytes = 512 * 1024;
const startupTimeoutMs = 30_000;
const shutdownTimeoutMs = 15_000;
const pollIntervalMs = 50;
const modes = [
  { name: "dev", args: ["run", "dev"] },
  { name: "inspect", args: ["run", "dev:inspect"] },
];

assert.equal(process.platform, "linux", "Terminal ownership verification requires Linux /proc");

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function until(test, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await test();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out: ${description}${lastError ? ` (${lastError.message})` : ""}`);
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address.port > 0);
  await new Promise((resolvePromise, rejectPromise) =>
    server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
  );
  return address.port;
}

async function readProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closingParenthesis = stat.lastIndexOf(") ");
    if (closingParenthesis < 0) return undefined;
    const commandName = stat.slice(stat.indexOf("(") + 1, closingParenthesis);
    const fields = stat
      .slice(closingParenthesis + 2)
      .trim()
      .split(/\s+/);
    const commandLine = (await readFile(`/proc/${pid}/cmdline`)).toString("utf8");
    return {
      pid,
      commandName,
      state: fields[0],
      ppid: Number(fields[1]),
      pgid: Number(fields[2]),
      session: Number(fields[3]),
      startTime: fields[19],
      args: commandLine.replaceAll("\0", " ").trim() || commandName,
    };
  } catch {
    return undefined;
  }
}

async function processSnapshot() {
  let entries;
  try {
    entries = await readdir("/proc");
  } catch {
    return new Map();
  }
  const records = await Promise.all(
    entries.filter((entry) => /^\d+$/.test(entry)).map((entry) => readProcess(Number(entry))),
  );
  return new Map(
    records.filter((record) => record !== undefined).map((record) => [record.pid, record]),
  );
}

function ancestry(pid, snapshot) {
  const chain = [];
  const seen = new Set();
  let current = snapshot.get(pid);
  while (current !== undefined && !seen.has(current.pid)) {
    chain.push(current);
    seen.add(current.pid);
    current = snapshot.get(current.ppid);
  }
  return chain;
}

async function recordedProcessIsAlive(record) {
  const current = await readProcess(record.pid);
  return current !== undefined && current.state !== "Z" && current.startTime === record.startTime;
}

async function recordsAreGone(records) {
  const alive = await Promise.all(records.map((record) => recordedProcessIsAlive(record)));
  return alive.every((value) => !value);
}

async function portIsOpen(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    });
    return true;
  } catch {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
      return true;
    } catch {
      return false;
    }
  }
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) throw new Error(`CDP target listing failed with ${response.status}`);
  return response.json();
}

async function connectCdp(url, label) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const errors = [];
  let nextId = 0;
  let closed = false;
  let connectTimer;
  await new Promise((resolvePromise, rejectPromise) => {
    const rejectConnection = () => {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      socket.close();
      rejectPromise(new Error(`Could not connect to ${label}`));
    };
    connectTimer = setTimeout(rejectConnection, 5_000);
    socket.onopen = resolvePromise;
    socket.onerror = rejectConnection;
  });
  if (connectTimer !== undefined) clearTimeout(connectTimer);
  socket.onmessage = (event) => {
    const packet = JSON.parse(String(event.data));
    if (packet.id === undefined) {
      if (packet.method === "Runtime.exceptionThrown") errors.push(packet.params.exceptionDetails);
      return;
    }
    const request = pending.get(packet.id);
    if (request === undefined) return;
    pending.delete(packet.id);
    clearTimeout(request.timer);
    if (packet.error !== undefined) request.reject(new Error(JSON.stringify(packet.error)));
    else request.resolve(packet.result);
  };
  socket.onclose = () => {
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`${label} CDP target closed`));
    }
    pending.clear();
  };
  const call = (method, params = {}) =>
    new Promise((resolvePromise, rejectPromise) => {
      if (closed) {
        rejectPromise(new Error(`${label} CDP target is closed`));
        return;
      }
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`CDP timeout: ${label} ${method}`));
      }, 5_000);
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.text ?? `Evaluation failed in ${label}`);
    }
    return result.result?.value;
  };
  return {
    call,
    evaluate,
    errors,
    close: () => {
      if (!closed) socket.close();
    },
  };
}

async function readBrowserProcessInfo(cdpPort) {
  const versionResponse = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
    signal: AbortSignal.timeout(1_000),
  });
  if (!versionResponse.ok)
    throw new Error(`CDP version request failed with ${versionResponse.status}`);
  const version = await versionResponse.json();
  assert.equal(typeof version.webSocketDebuggerUrl, "string");
  const browser = await connectCdp(version.webSocketDebuggerUrl, "browser");
  try {
    const response = await browser.call("SystemInfo.getProcessInfo");
    assert.ok(Array.isArray(response.processInfo));
    return { version, processInfo: response.processInfo };
  } finally {
    browser.close();
  }
}

const isGuestPage = (target) => {
  if (target.type !== "page" || typeof target.url !== "string") return false;
  try {
    return new URL(target.url).hostname === "localhost";
  } catch {
    return false;
  }
};

async function waitForRenderers(cdpPort, connections) {
  return until(
    async () => {
      const targets = await listTargets(cdpPort);
      const pageTargets = targets.filter(
        (candidate) => candidate.type === "page" && !isGuestPage(candidate),
      );
      if (pageTargets.length > 2) {
        throw new Error(
          `Unexpected custom inspector or extra page target: ${pageTargets
            .map((target) => `${target.title ?? "untitled"} ${target.url ?? ""}`)
            .join(" | ")}`,
        );
      }
      const pages = [];
      for (const windowName of ["first", "second"]) {
        const target = targets.find((candidate) => {
          if (candidate.type !== "page" || typeof candidate.webSocketDebuggerUrl !== "string")
            return false;
          try {
            const url = new URL(candidate.url);
            return (
              url.protocol === "http:" &&
              ["127.0.0.1", "localhost"].includes(url.hostname) &&
              url.searchParams.get("window") === windowName
            );
          } catch {
            return false;
          }
        });
        if (target === undefined) continue;
        let page;
        try {
          page = await connectCdp(target.webSocketDebuggerUrl, `renderer-${windowName}`);
          await page.call("Runtime.enable");
        } catch {
          page?.close();
          continue;
        }
        connections.add(page);
        try {
          const state = await page.evaluate(`({
            href: location.href,
            marker: document.body?.innerText.includes("See where the work runs") ?? false,
            sewed: typeof window.sewed === "object" && window.sewed !== null,
          })`);
          if (page.errors.length > 0) {
            throw new Error(
              `${windowName} renderer emitted an exception: ${JSON.stringify(page.errors)}`,
            );
          }
          if (state?.marker === true && state.sewed === true) {
            pages.push({ name: windowName, target, page, state });
          } else {
            page.close();
            connections.delete(page);
          }
        } catch (caughtError) {
          page.close();
          connections.delete(page);
          if (page.errors.length > 0) {
            throw new Error(
              `${windowName} renderer emitted an exception: ${JSON.stringify(page.errors)}`,
              { cause: caughtError },
            );
          }
        }
      }
      if (pages.length !== 2) {
        for (const { page } of pages) {
          page.close();
          connections.delete(page);
        }
        return undefined;
      }

      const currentTargets = await listTargets(cdpPort);
      const currentPageTargets = currentTargets.filter(
        (candidate) => candidate.type === "page" && !isGuestPage(candidate),
      );
      if (currentPageTargets.length > 2) {
        for (const { page } of pages) {
          page.close();
          connections.delete(page);
        }
        throw new Error(
          `Unexpected custom inspector or extra page target: ${currentPageTargets
            .map((target) => `${target.title ?? "untitled"} ${target.url ?? ""}`)
            .join(" | ")}`,
        );
      }
      return { targets: currentTargets, pages };
    },
    "two mounted React renderers without a custom inspector target",
    startupTimeoutMs,
  );
}

function safeError(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function appendOutput(state, chunk) {
  state.output += chunk.toString();
  if (Buffer.byteLength(state.output, "utf8") > maxOutputBytes) {
    state.output = state.output.slice(-maxOutputBytes);
  }
}

function processSummary(record) {
  return {
    pid: record.pid,
    ppid: record.ppid,
    pgid: record.pgid,
    session: record.session,
    state: record.state,
    startTime: record.startTime,
    commandName: record.commandName,
    args: record.args,
  };
}

function groupSummary(group) {
  return {
    kind: group.kind,
    leaderPid: group.leaderPid,
    pgid: group.pgid,
    memberPids: group.members.map((record) => record.pid),
    members: group.members.map(processSummary),
    ownership: group.ownership,
  };
}

function signalGroup(state, group, signal, reason) {
  if (group.pgid === state.ownProcessGroup) {
    throw new Error(`Refusing to signal the harness process group ${group.pgid}`);
  }
  process.kill(-group.pgid, signal);
  state.signalEvents.push({ signal, reason, kind: group.kind, pgid: group.pgid });
}

async function groupHasLiveMembers(group) {
  return !(await recordsAreGone(group.members));
}

async function discoverOwnedGroups(state) {
  const snapshot = await processSnapshot();
  const groups = new Map(state.groups.map((group) => [group.pgid, group]));
  for (const record of snapshot.values()) {
    const existingGroup = groups.get(record.pgid);
    if (
      existingGroup?.kind === "cli" &&
      !existingGroup.members.some((member) => member.pid === record.pid)
    ) {
      existingGroup.members.push(record);
      continue;
    }
    const appStage = record.args.includes(`${projectRoot}/.sewed/dev/`);
    const cdpArgument = record.args.includes(`--remote-debugging-port=${state.cdpPort}`);
    const privateProfile = record.args.includes(state.privateRoot);
    if (!cdpArgument || (!appStage && !privateProfile)) continue;
    if (!record.args.includes("electron")) continue;
    const existing = groups.get(record.pgid);
    if (existing === undefined) {
      groups.set(record.pgid, {
        kind: "electron",
        leaderPid: record.pgid,
        pgid: record.pgid,
        members: [record],
        ownership: "Electron command carries this run's staging/profile marker",
      });
    } else if (!existing.members.some((member) => member.pid === record.pid)) {
      existing.members.push(record);
    }
  }
  for (const group of groups.values()) {
    if (group.kind !== "electron") continue;
    for (const record of snapshot.values()) {
      if (
        record.pgid === group.pgid &&
        record.args.includes("electron") &&
        !group.members.some((member) => member.pid === record.pid)
      ) {
        group.members.push(record);
      }
    }
  }
  state.groups = [...groups.values()];
}

async function cleanupGroups(state) {
  await discoverOwnedGroups(state);
  for (const group of state.groups) {
    if (!(await groupHasLiveMembers(group))) continue;
    try {
      signalGroup(state, group, "SIGTERM", "failure cleanup");
    } catch (error) {
      state.cleanupErrors.push(safeError(error));
    }
  }
  await sleep(1_000);
  for (const group of state.groups) {
    if (!(await groupHasLiveMembers(group))) continue;
    try {
      signalGroup(state, group, "SIGKILL", "failure cleanup after SIGTERM");
    } catch (error) {
      state.cleanupErrors.push(safeError(error));
    }
  }
}

function cdpTargetSummary(target) {
  return {
    id: target.id,
    type: target.type,
    title: target.title,
    url: target.url,
  };
}

async function runMode(mode) {
  const state = {
    mode: mode.name,
    output: "",
    connections: new Set(),
    groups: [],
    signalEvents: [],
    cleanupErrors: [],
    cleanupCompleted: false,
    cdpPort: undefined,
    vitePort: undefined,
    privateRoot: undefined,
    sessionRoot: undefined,
    child: undefined,
    childExitResult: undefined,
    ownProcessGroup: (await readProcess(process.pid))?.pgid,
  };
  const startedAt = new Date().toISOString();
  const logPath = join(artifactRoot, `${mode.name}.log`);
  const reportPath = join(artifactRoot, `${mode.name}.json`);
  let error;
  try {
    state.privateRoot = await mkdtemp(join(tmpdir(), `sewed-terminal-${mode.name}-`));
    await Promise.all([
      mkdir(join(state.privateRoot, "config"), { recursive: true }),
      mkdir(join(state.privateRoot, "cache"), { recursive: true }),
      mkdir(join(state.privateRoot, "data"), { recursive: true }),
      mkdir(join(state.privateRoot, "state"), { recursive: true }),
      mkdir(join(state.privateRoot, "tmp"), { recursive: true }),
    ]);
    state.vitePort = await reserveLoopbackPort();
    do state.cdpPort = await reserveLoopbackPort();
    while (state.cdpPort === state.vitePort);
    const inherited = process.env;
    const environment = {
      ...inherited,
      SEWED_DEBUG_PORT: String(state.cdpPort),
      XDG_CONFIG_HOME: join(state.privateRoot, "config"),
      XDG_CACHE_HOME: join(state.privateRoot, "cache"),
      XDG_DATA_HOME: join(state.privateRoot, "data"),
      XDG_STATE_HOME: join(state.privateRoot, "state"),
      TMPDIR: join(state.privateRoot, "tmp"),
      TMP: join(state.privateRoot, "tmp"),
      TEMP: join(state.privateRoot, "tmp"),
      DISPLAY: inherited.DISPLAY ?? ":0",
      WAYLAND_DISPLAY: inherited.WAYLAND_DISPLAY ?? "wayland-0",
      XDG_RUNTIME_DIR: inherited.XDG_RUNTIME_DIR ?? "/mnt/wslg/runtime-dir",
      PULSE_SERVER: inherited.PULSE_SERVER ?? "unix:/mnt/wslg/PulseServer",
    };
    state.child = spawn("pnpm", [...mode.args, "--port", String(state.vitePort), "--strictPort"], {
      cwd: projectRoot,
      env: environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    state.child.stdout?.on("data", (chunk) => appendOutput(state, chunk));
    state.child.stderr?.on("data", (chunk) => appendOutput(state, chunk));
    state.child.once("error", (childError) => {
      state.childExitResult = { code: null, signal: null, error: safeError(childError) };
    });
    state.child.once("exit", (code, signal) => {
      state.childExitResult = { code, signal };
    });
    const cliRecord = await until(
      () => readProcess(state.child.pid),
      `${mode.name} CLI process group`,
      5_000,
    );
    state.groups.push({
      kind: "cli",
      leaderPid: state.child.pid,
      pgid: cliRecord.pgid,
      members: [cliRecord],
      ownership: "spawned detached pnpm group for this verification run",
    });
    const renderers = await waitForRenderers(state.cdpPort, state.connections);
    assert.equal(renderers.pages.length, 2);
    assert.equal(
      renderers.targets.filter((target) => target.type === "page" && !isGuestPage(target)).length,
      2,
      "CDP exposed only the two application renderer pages beside the guest page",
    );
    const runtime = await readBrowserProcessInfo(state.cdpPort);
    const snapshot = await processSnapshot();
    const cliGroup = state.groups.find((group) => group.kind === "cli");
    assert.ok(cliGroup);
    for (const record of snapshot.values()) {
      if (
        record.pgid === cliGroup.pgid &&
        !cliGroup.members.some((member) => member.pid === record.pid)
      ) {
        cliGroup.members.push(record);
      }
    }
    const browserInfo = runtime.processInfo.find(
      (entry) => String(entry.type).toLowerCase() === "browser",
    );
    assert.ok(browserInfo, "CDP did not report an Electron browser process");
    assert.ok(Number.isInteger(browserInfo.id));
    const browserRecord = snapshot.get(browserInfo.id);
    assert.ok(browserRecord, `CDP browser PID ${browserInfo.id} is absent from /proc`);
    assert.ok(browserRecord.args.includes(`${projectRoot}/.sewed/dev/`));
    const electronMembers = [...snapshot.values()].filter(
      (record) => record.pgid === browserRecord.pgid && record.args.includes("electron"),
    );
    assert.ok(electronMembers.length > 0, "Electron process group was not visible in /proc");
    assert.ok(
      electronMembers.some((record) => record.args.includes(state.privateRoot)),
      "Electron children did not use the task-owned profile/cache root",
    );
    const ancestryChain = ancestry(browserRecord.pid, snapshot);
    assert.ok(
      ancestryChain.some((record) => record.pid === state.child.pid),
      `Electron PID ${browserRecord.pid} is not descended from CLI PID ${state.child.pid}`,
    );
    const systemPids = runtime.processInfo.map((entry) => entry.id);
    for (const pid of systemPids) {
      const record = snapshot.get(pid);
      assert.ok(record, `CDP process PID ${pid} is absent from /proc`);
      assert.equal(record.pgid, browserRecord.pgid);
    }
    state.groups.push({
      kind: "electron",
      leaderPid: browserRecord.pid,
      pgid: browserRecord.pgid,
      members: electronMembers,
      ownership: "CDP browser PID plus /proc detached-group ancestry and task staging path",
    });
    state.sessionRoot = browserRecord.args
      .split(/\s+/)
      .find((argument) => argument.startsWith(`${projectRoot}/.sewed/dev/`));
    if (state.sessionRoot !== undefined) state.sessionRoot = dirname(state.sessionRoot);
    state.initial = {
      targets: renderers.targets.map(cdpTargetSummary),
      pageCount: renderers.pages.length,
      pages: renderers.pages.map(({ name, target, state: pageState }) => ({
        name,
        target: cdpTargetSummary(target),
        state: pageState,
      })),
      browser: {
        version: runtime.version,
        processInfo: runtime.processInfo,
      },
      ancestry: ancestryChain.map(processSummary),
    };
    for (const connection of state.connections) connection.close();
    state.connections.clear();
    const interruptedAt = performance.now();
    signalGroup(state, cliGroup, "SIGINT", "terminal foreground Ctrl+C equivalent");
    await until(() => state.childExitResult, `${mode.name} terminal CLI exit`, shutdownTimeoutMs);
    await until(
      async () => recordsAreGone(state.groups.flatMap((group) => group.members)),
      `${mode.name} owned Electron and CLI processes exit`,
      shutdownTimeoutMs,
    );
    state.shutdownElapsedMs = performance.now() - interruptedAt;
    assert.ok(
      state.shutdownElapsedMs < 5_000,
      "Cooperative shutdown must finish before Sewed's 5-second force-kill fallback",
    );
    await until(
      async () => !(await portIsOpen(state.cdpPort)),
      `${mode.name} CDP port closes`,
      shutdownTimeoutMs,
    );
    await until(
      async () => !(await portIsOpen(state.vitePort)),
      `${mode.name} Vite port closes`,
      shutdownTimeoutMs,
    );
    await until(
      () =>
        [
          "playground.background.released",
          "playground.clock.released",
          "playground.clock.stopped",
        ].every((marker) => state.output.includes(marker)),
      `${mode.name} normal scope finalizer logs`,
      5_000,
    );
    assert.equal(
      state.output.includes("No handler registered"),
      false,
      `${mode.name} teardown registered-handler error`,
    );
    const remaining = await Promise.all(
      state.groups
        .flatMap((group) => group.members)
        .map(async (record) => ({
          record,
          alive: await recordedProcessIsAlive(record),
        })),
    );
    assert.deepEqual(
      remaining.filter((entry) => entry.alive).map((entry) => entry.record.pid),
      [],
    );
    state.success = true;
  } catch (caughtError) {
    error = caughtError;
  } finally {
    for (const connection of state.connections) connection.close();
    if (!state.success && state.groups.length > 0) await cleanupGroups(state);
    state.cleanupCompleted = true;
    state.child?.stdout?.destroy();
    state.child?.stderr?.destroy();
    if (state.sessionRoot !== undefined) {
      await rm(state.sessionRoot, { recursive: true, force: true }).catch((cleanupError) =>
        state.cleanupErrors.push(safeError(cleanupError)),
      );
    }
    if (state.privateRoot !== undefined)
      await rm(state.privateRoot, { recursive: true, force: true }).catch((cleanupError) =>
        state.cleanupErrors.push(safeError(cleanupError)),
      );
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(logPath, state.output, "utf8");
    const report = {
      mode: state.mode,
      success: state.success === true && error === undefined,
      startedAt,
      finishedAt: new Date().toISOString(),
      command: ["pnpm", ...mode.args, "--port", state.vitePort, "--strictPort"],
      ports: { vite: state.vitePort, cdp: state.cdpPort },
      display: {
        display: process.env.DISPLAY ?? ":0",
        waylandDisplay: process.env.WAYLAND_DISPLAY ?? "wayland-0",
        runtimeDirectory: process.env.XDG_RUNTIME_DIR ?? "/mnt/wslg/runtime-dir",
      },
      privatePaths: state.privateRoot
        ? {
            root: state.privateRoot,
            config: join(state.privateRoot, "config"),
            cache: join(state.privateRoot, "cache"),
            data: join(state.privateRoot, "data"),
            state: join(state.privateRoot, "state"),
            tmp: join(state.privateRoot, "tmp"),
          }
        : undefined,
      initial: state.initial,
      groups: state.groups.map(groupSummary),
      terminal: {
        cliPid: state.child?.pid,
        cliExit: state.childExitResult,
        signalEvents: state.signalEvents,
        cleanupSignals: state.signalEvents.filter((event) =>
          event.reason.startsWith("failure cleanup"),
        ),
      },
      shutdown: {
        elapsedMs: state.shutdownElapsedMs,
        allRecordedProcessesGone:
          state.groups.length > 0 &&
          (await recordsAreGone(state.groups.flatMap((group) => group.members))),
        cdpPortClosed: state.cdpPort === undefined ? undefined : !(await portIsOpen(state.cdpPort)),
        vitePortClosed:
          state.vitePort === undefined ? undefined : !(await portIsOpen(state.vitePort)),
        forcedSignals: state.signalEvents.filter((event) => event.signal === "SIGKILL"),
        finalizerLogs: {
          backgroundReleased: state.output.includes("playground.background.released"),
          clockReleased: state.output.includes("playground.clock.released"),
          clockStopped: state.output.includes("playground.clock.stopped"),
          windowObserversClosed:
            state.output.match(/playground\.contents\.observer\.closed/g)?.length ?? 0,
        },
        teardownHandlerErrors: state.output.match(/No handler registered/gi) ?? [],
        nativeWindows: {
          status: process.platform === "win32" ? "not-inspected" : "unsupported-wsl-linux",
          reason:
            "This harness runs under WSL Linux and has no Windows-side native-window inspection; Electron/CDP process and renderer-target shutdown are verified.",
        },
      },
      cleanup: {
        completed: state.cleanupCompleted,
        errors: state.cleanupErrors,
        sessionRoot: state.sessionRoot,
      },
      log: logPath,
      error: error === undefined ? undefined : safeError(error),
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    state.report = report;
  }
  return state.report;
}

await mkdir(artifactRoot, { recursive: true });
const reports = [];
for (const mode of modes) {
  const report = await runMode(mode);
  reports.push(report);
  console.log(`${report.success ? "PASS" : "FAIL"} terminal ${mode.name}`);
  if (!report.success) console.error(report.error);
}
const verification = {
  success: reports.every((report) => report.success),
  platform: process.platform,
  modes: reports,
};
await writeFile(
  join(artifactRoot, "verification.json"),
  `${JSON.stringify(verification, null, 2)}\n`,
  "utf8",
);
if (!verification.success) process.exitCode = 1;
