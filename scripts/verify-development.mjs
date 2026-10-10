import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { writeFileSync as writeFileSyncDirect } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { sewed } from "@sewed/vite";
import { sewedDevTools } from "@sewed/devtools/vite";

const inspect = process.argv.includes("--devtools");
const originalDevtoolsFlag = process.env.SEWED_DEVTOOLS;
const originalReportFlag = process.env.SEWED_DEVELOPMENT_RUNTIME_REPORT;

const playgroundRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = join(
  playgroundRoot,
  ".artifacts",
  inspect ? "development-devtools" : "development",
);
const fixtureRoot = join(artifactRoot, "fixture");
const rendererRoot = join(fixtureRoot, "src", "renderer");
const runtimeReportPath = join(fixtureRoot, "runtime.json");
const verificationPath = join(artifactRoot, "development-verification.json");
const checks = [];
const events = [];
const eventViolations = [];
let eventActivePid;
let lastStoppedPid;
let server;
let page;
let failure;
let cleanupFailure;

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function until(test, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await test();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw new Error(`Timed out: ${description}${lastError ? ` (${lastError.message})` : ""}`);
}

function pass(name, evidence = {}) {
  checks.push({ name, evidence });
  console.log(`PASS ${name}`);
}

function recordEvent(event) {
  if (event.type === "started") {
    if (eventActivePid !== undefined)
      eventViolations.push(`started ${event.pid} while ${eventActivePid} was active`);
    if (lastStoppedPid !== undefined && pidIsAlive(lastStoppedPid))
      eventViolations.push(
        `started ${event.pid} while stopped pid ${lastStoppedPid} was still alive`,
      );
    eventActivePid = event.pid;
  } else if (event.type === "stopped") {
    if (event.signal !== null && event.signal !== "SIGTERM" && event.signal !== "SIGKILL") {
      eventViolations.push(`Electron ${event.pid} crashed during shutdown: ${event.signal}`);
    }
    if (eventActivePid !== event.pid)
      eventViolations.push(`stopped ${event.pid} while ${eventActivePid ?? "none"} was active`);
    eventActivePid = undefined;
    lastStoppedPid = event.pid;
  }
  events.push(event);
  persistArtifact();
}

function persistArtifact() {
  writeFileSyncDirect(verificationPath, `${JSON.stringify({ checks, events }, null, 2)}\n`, "utf8");
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function writeFixture() {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(rendererRoot, { recursive: true });
  await mkdir(join(fixtureRoot, "src", "main"), { recursive: true });
  await mkdir(join(fixtureRoot, "src", "worker"), { recursive: true });
  await mkdir(join(fixtureRoot, "src", "shared"), { recursive: true });
  await mkdir(artifactRoot, { recursive: true });

  const packageJson = {
    name: "sewed-development-loop-fixture",
    private: true,
    type: "module",
  };
  await writeFile(join(fixtureRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(
    join(fixtureRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          lib: ["ES2023", "DOM"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          rootDir: "src",
          strict: true,
          noUncheckedIndexedAccess: true,
          verbatimModuleSyntax: true,
          skipLibCheck: true,
          types: ["node"],
        },
        files: ["src/main/index.ts", "src/worker/index.ts"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(fixtureRoot, "src", "shared", "protocol.ts"),
    `import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Binding } from "sewed";

export const SHARED_MARKER = "shared-v1";
export const Protocol = RpcGroup.make(
  Rpc.make("info", {
    success: Schema.Struct({
      thread: Schema.Number,
      workerMarker: Schema.String,
      sharedMarker: Schema.String,
    }),
  }),
);
export const Info = Binding.slot("development/info", Protocol);
`,
  );
  await writeFile(
    join(fixtureRoot, "src", "worker", "index.ts"),
    `import { Effect } from "effect";
import * as Worker from "sewed/worker";
import { Protocol, SHARED_MARKER } from "../shared/protocol.js";

const WORKER_MARKER = "worker-v1";

export default Worker.define(
  Protocol,
  (implement) => implement({
    info: () => Effect.gen(function* () {
      return {
        thread: yield* Worker.threadId,
        workerMarker: WORKER_MARKER,
        sharedMarker: SHARED_MARKER,
      };
    }),
  }),
);
`,
  );
  await writeFile(
    join(fixtureRoot, "src", "main", "index.ts"),
    `import { writeFileSync } from "node:fs";
import { BrowserWindow as NativeWindow } from "electron";
import * as DevTools from "@sewed/devtools";
import { Effect } from "effect";
import { Binding, Decidables, Decision, Diagnostics, Renderer } from "sewed";
import { App, BrowserWindow, Worker } from "sewed/main";
import { Info, Protocol } from "../shared/protocol.js";

const MAIN_MARKER = "main-v1";
const runtimeReportPath = process.env.SEWED_DEVELOPMENT_RUNTIME_REPORT;
if (runtimeReportPath === undefined) throw new Error("Missing development runtime report path");

const application = (tools?: DevTools.Handle) =>
  Effect.gen(function* () {
    const worker = yield* Worker.spawn(
      Worker.entry(new URL("../worker/index.js", import.meta.url), Protocol),
    );
    const info = yield* Diagnostics.instrument(
      Effect.gen(function* () {
        const client = yield* Info();
        return yield* client.info();
      }).pipe(
        Effect.provide(Binding.layer([Binding.to(Info, worker)])),
        Effect.withSpan("development fixture info"),
      ),
    );
    const generation = Number(process.env.SEWED_GENERATION ?? "0");
    const window = yield* BrowserWindow.make({
      title: "Sewed development loop",
      width: 640,
      height: 420,
      show: false,
    });
    const url = new URL(process.env.SEWED_RENDERER_URL ?? "../renderer/index.html", import.meta.url);
    for (const [key, value] of Object.entries({
      generation: String(generation),
      main: MAIN_MARKER,
      worker: info.workerMarker,
      shared: info.sharedMarker,
    })) url.searchParams.set(key, value);
    yield* window.webContents.load(Renderer.entry(url, { bindings: [] }), { bindings: [] });
    const snapshot = tools === undefined ? undefined : yield* tools.snapshot;
    const diagnosticEvents = snapshot?.diagnostics.events ?? [];
    const report = {
      generation,
      pid: process.pid,
      devtoolsEnabled: process.env.SEWED_DEVTOOLS === "1",
      applicationWindows: NativeWindow.getAllWindows().length,
      diagnostics:
        snapshot === undefined
          ? undefined
          : {
              eventCount: diagnosticEvents.length,
              traceSpanCount: diagnosticEvents.filter(({ event }) => event._tag === "TraceSpan").length,
              spanCount: snapshot.spans.length,
              complete: snapshot.diagnostics.complete,
            },
      mainMarker: MAIN_MARKER,
      workerThread: info.thread,
      workerMarker: info.workerMarker,
      sharedMarker: info.sharedMarker,
    };
    yield* Effect.sync(() => writeFileSync(runtimeReportPath, JSON.stringify(report) + "\\n", "utf8"));
  });

const setup = Effect.gen(function* () {
  yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "quit"));
  if (process.env.SEWED_DEVTOOLS === "1") {
    const tools = yield* DevTools.make({ capacity: 64 });
    yield* Effect.gen(function* () {
      yield* application(tools);
      yield* Effect.never;
    }).pipe(Effect.provide(tools.layer));
  } else
    yield* Effect.gen(function* () {
      yield* application();
      yield* Effect.never;
    }).pipe(Effect.provide(DevTools.layer()));
});

App.run([], setup);
`,
  );
  await writeFile(
    join(rendererRoot, "index.html"),
    `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Sewed development loop</title></head>
  <body><div id="root"></div><script type="module" src="/main.tsx"></script></body>
</html>
`,
  );
  await writeFile(
    join(rendererRoot, "main.tsx"),
    `import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")).render(<App />);
`,
  );
  await writeFile(
    join(rendererRoot, "App.tsx"),
    `import { useState } from "react";

const params = new URLSearchParams(window.location.search);

export function App() {
  const [count, setCount] = useState(0);
  return (
    <main
      data-app="development-loop"
      data-generation={params.get("generation") ?? ""}
      data-main-marker={params.get("main") ?? ""}
      data-worker-marker={params.get("worker") ?? ""}
      data-shared-marker={params.get("shared") ?? ""}
      data-count={String(count)}
    >
      <h1 data-title>Renderer v1</h1>
      <p data-generation-label>Generation {params.get("generation")}</p>
      <p data-main-label>Main {params.get("main")}</p>
      <p data-worker-label>Worker {params.get("worker")}</p>
      <p data-shared-label>Shared {params.get("shared")}</p>
      <button type="button" data-counter onClick={() => setCount((value) => value + 1)}>
        Count {count}
      </button>
    </main>
  );
}
`,
  );
}

async function reserveLoopbackPort() {
  const socket = createTcpServer();
  await new Promise((resolvePromise, rejectPromise) => {
    socket.once("error", rejectPromise);
    socket.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = socket.address();
  assert.equal(typeof address, "object");
  assert.ok(address.port > 0);
  await new Promise((resolvePromise, rejectPromise) =>
    socket.close((error) => (error ? rejectPromise(error) : resolvePromise())),
  );
  return address.port;
}

async function connectPage(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const errors = [];
  let nextId = 0;
  await new Promise((resolvePromise, rejectPromise) => {
    socket.onopen = resolvePromise;
    socket.onerror = rejectPromise;
  });
  socket.onmessage = (event) => {
    const packet = JSON.parse(String(event.data));
    if (packet.id !== undefined) {
      const request = pending.get(packet.id);
      if (request === undefined) return;
      pending.delete(packet.id);
      clearTimeout(request.timer);
      if (packet.error !== undefined) request.reject(new Error(JSON.stringify(packet.error)));
      else request.resolve(packet.result);
    } else if (packet.method === "Runtime.exceptionThrown") {
      errors.push(packet.params.exceptionDetails);
    }
  };
  socket.onclose = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("CDP target closed"));
    }
    pending.clear();
  };
  const call = (method, params = {}) =>
    new Promise((resolvePromise, rejectPromise) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`CDP timeout: ${method}`));
      }, 5_000);
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const response = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails !== undefined) throw new Error(response.exceptionDetails.text);
    return response.result?.value;
  };
  const attribute = (selector, name) =>
    evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)})`,
    );
  const text = (selector) =>
    evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent`);
  const click = async (selector) => {
    const position = await until(
      () =>
        evaluate(`(async () => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element || !element.getClientRects().length) return undefined;
          element.scrollIntoView({ block: "center", inline: "center" });
          await new Promise(requestAnimationFrame);
          const rect = element.getBoundingClientRect();
          const x = rect.x + rect.width / 2;
          const y = rect.y + rect.height / 2;
          return rect.width > 0 && rect.height > 0 && element.contains(document.elementFromPoint(x, y))
            ? { x, y }
            : undefined;
        })()`),
      `stable click target ${selector}`,
    );
    await call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...position,
    });
    await call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...position,
    });
  };
  await call("Runtime.enable");
  return {
    call,
    evaluate,
    attribute,
    text,
    errors,
    click,
    close: () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        socket.close();
    },
  };
}

async function listTargets(cdpPort) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  if (!response.ok) throw new Error(`CDP target listing failed with ${response.status}`);
  return response.json();
}

async function waitForPage(cdpPort, generation) {
  const target = await until(
    async () => {
      const targets = await listTargets(cdpPort);
      return targets.find((candidate) => {
        if (candidate.type !== "page" || !candidate.webSocketDebuggerUrl) return false;
        let url;
        try {
          url = new URL(candidate.url);
        } catch {
          return false;
        }
        if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname))
          return false;
        return (
          generation === undefined || url.searchParams.get("generation") === String(generation)
        );
      });
    },
    generation === undefined ? "initial renderer target" : `renderer generation ${generation}`,
  );
  const connected = await connectPage(target);
  await until(() => connected.attribute("[data-app]", "data-app"), "renderer application mounted");
  assert.deepEqual(connected.errors, []);
  return connected;
}

async function readRuntime() {
  return readJson(runtimeReportPath);
}

async function waitForEvent(type, startIndex, description) {
  return until(() => events.slice(startIndex).find((event) => event.type === type), description);
}

async function waitForRuntime(predicate, description) {
  return until(async () => {
    const runtime = await readRuntime();
    if (runtime === undefined || !predicate(runtime)) return undefined;
    assert.equal(runtime.devtoolsEnabled, inspect || originalDevtoolsFlag === "1");
    assert.equal(runtime.applicationWindows, 1);
    if (runtime.devtoolsEnabled) {
      assert.ok(runtime.diagnostics?.eventCount > 0, "DevTools snapshot captured diagnostics");
      assert.ok(runtime.diagnostics?.traceSpanCount > 0, "DevTools snapshot captured tracing");
      assert.ok(runtime.diagnostics?.spanCount > 0, "DevTools snapshot captured spans");
    } else assert.equal(runtime.diagnostics, undefined);
    return runtime;
  }, description);
}

async function replaceMarker(path, previous, next) {
  const source = await readFile(path, "utf8");
  const changed = source.replace(`"${previous}"`, `"${next}"`);
  assert.notEqual(changed, source, `Could not find marker ${previous} in ${path}`);
  await writeFile(path, changed);
  return changed;
}

async function restartAfterEdit({ path, previous, next, oldRuntime, oldPage, label }) {
  const startIndex = events.length;
  await replaceMarker(path, previous, next);
  const started = await until(
    () =>
      events
        .slice(startIndex)
        .find((event) => event.type === "started" && event.generation > oldRuntime.generation),
    `${label} development restart`,
  );
  const stoppedIndex = events
    .slice(startIndex)
    .findIndex((event) => event.type === "stopped" && event.pid === oldRuntime.pid);
  const startedIndex = events.slice(startIndex).indexOf(started);
  assert.ok(stoppedIndex >= 0, `${label} restart did not stop the previous Electron process`);
  assert.ok(stoppedIndex < startedIndex, `${label} restart started before stopped`);
  await until(() => !pidIsAlive(oldRuntime.pid), `${label} previous Electron process exit`);
  const runtime = await waitForRuntime(
    (value) =>
      value.generation === started.generation &&
      value.pid === started.pid &&
      value.mainMarker === (label === "main" ? next : oldRuntime.mainMarker) &&
      value.workerMarker === (label === "worker" ? next : oldRuntime.workerMarker) &&
      value.sharedMarker === (label === "shared" ? next : oldRuntime.sharedMarker),
    `${label} runtime report`,
  );
  assert.notEqual(runtime.pid, oldRuntime.pid, `${label} restart reused the Electron process`);
  oldPage.close();
  const nextPage = await waitForPage(cdpPort, runtime.generation);
  assert.equal(
    await nextPage.attribute("[data-main-marker]", "data-main-marker"),
    runtime.mainMarker,
  );
  assert.equal(
    await nextPage.attribute("[data-worker-marker]", "data-worker-marker"),
    runtime.workerMarker,
  );
  assert.equal(
    await nextPage.attribute("[data-shared-marker]", "data-shared-marker"),
    runtime.sharedMarker,
  );
  return { runtime, page: nextPage };
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function taskProcesses() {
  let output;
  try {
    output = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
  } catch {
    return [];
  }
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && line.includes(fixtureRoot));
}

async function sessionArtifacts() {
  try {
    return await readdir(join(fixtureRoot, ".sewed", "dev"));
  } catch {
    return [];
  }
}

function assertEventProcessOrdering() {
  let activePid;
  for (const event of events) {
    if (event.type === "started") {
      assert.equal(
        activePid,
        undefined,
        `Electron process ${event.pid} started while ${activePid} was active`,
      );
      activePid = event.pid;
    } else if (event.type === "stopped") {
      assert.equal(event.pid, activePid, `Electron process ${event.pid} stopped out of order`);
      activePid = undefined;
    }
  }
  assert.equal(activePid, undefined, "Electron process remained active after server shutdown");
  assert.deepEqual(eventViolations, []);
}

const cdpPort = await reserveLoopbackPort();
const mainPath = join(fixtureRoot, "src", "main", "index.ts");
const workerPath = join(fixtureRoot, "src", "worker", "index.ts");
const sharedPath = join(fixtureRoot, "src", "shared", "protocol.ts");
const rendererPath = join(rendererRoot, "App.tsx");

try {
  await writeFixture();
  server = await createServer({
    configFile: false,
    root: rendererRoot,
    base: "/",
    logLevel: "silent",
    plugins: [
      react(),
      (inspect ? sewedDevTools : sewed)({
        main: "src/main/index.ts",
        env: { SEWED_DEVELOPMENT_RUNTIME_REPORT: runtimeReportPath },
        tsconfig: "tsconfig.json",
        cwd: fixtureRoot,
        electronArgs: [`--remote-debugging-port=${cdpPort}`],
        debounceMs: 150,
        onEvent: recordEvent,
      }),
    ],
    server: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  await server.listen();

  const initialStarted = await waitForEvent("started", 0, "initial Electron start");
  const initialRuntime = await waitForRuntime(
    (value) => value.generation === initialStarted.generation && value.pid === initialStarted.pid,
    "initial runtime report",
  );
  page = await waitForPage(cdpPort, initialRuntime.generation);
  assert.equal(await page.attribute("[data-app]", "data-app"), "development-loop");
  assert.equal(await page.attribute("[data-main-marker]", "data-main-marker"), "main-v1");
  assert.equal(await page.attribute("[data-worker-marker]", "data-worker-marker"), "worker-v1");
  assert.equal(await page.attribute("[data-shared-marker]", "data-shared-marker"), "shared-v1");
  assert.ok(initialRuntime.workerThread > 0);
  assert.equal(initialRuntime.devtoolsEnabled, inspect || originalDevtoolsFlag === "1");
  assert.equal(initialRuntime.applicationWindows, 1);
  assert.equal(process.env.SEWED_DEVTOOLS, originalDevtoolsFlag);
  assert.equal(process.env.SEWED_DEVELOPMENT_RUNTIME_REPORT, originalReportFlag);
  if (inspect)
    pass("the optional DevTools Vite wrapper enables headless tracing without an extra window", {
      applicationWindows: initialRuntime.applicationWindows,
      diagnosticEvents: initialRuntime.diagnostics.eventCount,
      traceSpans: initialRuntime.diagnostics.traceSpanCount,
      spans: initialRuntime.diagnostics.spanCount,
    });
  pass("initial development launch reaches a real Electron renderer and Node worker", {
    generation: initialRuntime.generation,
    pid: initialRuntime.pid,
    workerThread: initialRuntime.workerThread,
  });

  await page.click("[data-counter]");
  await until(
    async () => (await page.attribute("[data-count]", "data-count")) === "1",
    "renderer counter increment",
  );
  const rendererOriginal = await readFile(rendererPath, "utf8");
  const rendererChanged = rendererOriginal.replace("Renderer v1", "Renderer v2");
  assert.notEqual(rendererChanged, rendererOriginal);
  await writeFile(rendererPath, rendererChanged);
  await until(
    () => page.text("[data-title]").then((value) => value === "Renderer v2"),
    "React Fast Refresh update",
  );
  assert.equal(await page.attribute("[data-count]", "data-count"), "1");
  assert.equal((await readRuntime()).pid, initialRuntime.pid);
  await writeFile(rendererPath, rendererOriginal);
  await until(
    () => page.text("[data-title]").then((value) => value === "Renderer v1"),
    "React Fast Refresh restore",
  );
  assert.equal(await page.attribute("[data-count]", "data-count"), "1");
  pass("renderer Fast Refresh preserves React state without restarting Electron", {
    pid: initialRuntime.pid,
  });

  let current = { runtime: initialRuntime, page };
  current = await restartAfterEdit({
    path: mainPath,
    previous: "main-v1",
    next: "main-v2",
    oldRuntime: current.runtime,
    oldPage: current.page,
    label: "main",
  });
  pass("main source edits restart Electron with the new main marker", {
    generation: current.runtime.generation,
    pid: current.runtime.pid,
  });

  current = await restartAfterEdit({
    path: workerPath,
    previous: "worker-v1",
    next: "worker-v2",
    oldRuntime: current.runtime,
    oldPage: current.page,
    label: "worker",
  });
  pass("worker source edits restart Electron with a new worker marker", {
    generation: current.runtime.generation,
    workerThread: current.runtime.workerThread,
  });

  current = await restartAfterEdit({
    path: sharedPath,
    previous: "shared-v1",
    next: "shared-v2",
    oldRuntime: current.runtime,
    oldPage: current.page,
    label: "shared",
  });
  pass("imported shared source outside files restarts Electron with the new shared marker", {
    generation: current.runtime.generation,
    workerThread: current.runtime.workerThread,
  });

  const metadataStartIndex = events.length;
  await writeFile(
    join(fixtureRoot, "package.json"),
    '{"name":"sewed-development-loop-updated","private":true,"type":"module"}\n',
  );
  const metadataStarted = await waitForEvent(
    "started",
    metadataStartIndex,
    "package metadata restart",
  );
  const metadataRuntime = await waitForRuntime(
    (value) => value.generation === metadataStarted.generation && value.pid === metadataStarted.pid,
    "runtime after package metadata change",
  );
  await until(() => !pidIsAlive(current.runtime.pid), "previous metadata generation exit");
  const sessions = await sessionArtifacts();
  assert.equal(sessions.length, 1);
  const stagedPackage = await readJson(
    join(
      fixtureRoot,
      ".sewed",
      "dev",
      sessions[0],
      String(metadataStarted.generation),
      "package.json",
    ),
  );
  assert.equal(stagedPackage.name, "sewed-development-loop-updated");
  current.page.close();
  page = await waitForPage(cdpPort, metadataRuntime.generation);
  current = { runtime: metadataRuntime, page };
  pass("package metadata edits replace Electron with an updated staged manifest", {
    generation: metadataRuntime.generation,
    pid: metadataRuntime.pid,
    name: stagedPackage.name,
  });

  const stableRuntime = current.runtime;
  const stablePage = current.page;
  const mainSourceBeforeError = await readFile(mainPath, "utf8");
  const mainSourceWithError = `${mainSourceBeforeError}\nconst developmentTypeError: string = 1;\n`;
  const errorStartIndex = events.length;
  await writeFile(mainPath, mainSourceWithError);
  const failed = await waitForEvent(
    "build-failed",
    errorStartIndex,
    "TypeScript build failure event",
  );
  assert.ok(failed.error.includes("TypeScript") || failed.error.includes("type"));
  const failedRuntime = await waitForRuntime(
    (value) => value.pid === stableRuntime.pid && value.generation === stableRuntime.generation,
    "old runtime remains after TypeScript failure",
  );
  assert.equal(
    await stablePage.attribute("[data-generation]", "data-generation"),
    String(stableRuntime.generation),
  );
  assert.equal(await stablePage.attribute("[data-count]", "data-count"), "0");
  await stablePage.click("[data-counter]");
  await until(
    async () => (await stablePage.attribute("[data-count]", "data-count")) === "1",
    "renderer remains usable after build failure",
  );
  assert.equal(failedRuntime.pid, stableRuntime.pid);
  assert.ok(pidIsAlive(stableRuntime.pid));
  pass("TypeScript errors emit build-failed while the previous Electron UI remains usable", {
    generation: failed.generation,
    pid: stableRuntime.pid,
  });

  await writeFile(mainPath, mainSourceBeforeError);
  const recoveredStartIndex = events.length;
  const recoveredStarted = await until(
    () =>
      events
        .slice(recoveredStartIndex)
        .find((event) => event.type === "started" && event.generation > stableRuntime.generation),
    "TypeScript recovery Electron start",
  );
  assert.ok(
    events
      .slice(recoveredStartIndex)
      .some((event) => event.type === "stopped" && event.pid === stableRuntime.pid),
  );
  await until(() => !pidIsAlive(stableRuntime.pid), "failed-build Electron replacement exit");
  const recoveredRuntime = await waitForRuntime(
    (value) =>
      value.generation === recoveredStarted.generation &&
      value.pid === recoveredStarted.pid &&
      value.mainMarker === "main-v2" &&
      value.workerMarker === "worker-v2" &&
      value.sharedMarker === "shared-v2",
    "recovered runtime report",
  );
  stablePage.close();
  page = await waitForPage(cdpPort, recoveredRuntime.generation);
  current = { runtime: recoveredRuntime, page };
  pass("fixing the TypeScript error recovers the latest successful application", {
    generation: recoveredRuntime.generation,
    pid: recoveredRuntime.pid,
  });

  const rapidSource = await readFile(mainPath, "utf8");
  const rapidA = rapidSource.replace('"main-v2"', '"main-rapid-a"');
  const rapidB = rapidSource.replace('"main-v2"', '"main-rapid-b"');
  const rapidFinal = rapidSource.replace('"main-v2"', '"main-v4"');
  const rapidStartIndex = events.length;
  writeFileSyncDirect(mainPath, rapidA, "utf8");
  writeFileSyncDirect(mainPath, rapidB, "utf8");
  writeFileSyncDirect(mainPath, rapidFinal, "utf8");
  const rapidStarted = await until(
    () =>
      events
        .slice(rapidStartIndex)
        .find((event) => event.type === "started" && event.generation > current.runtime.generation),
    "rapid-save Electron start",
  );
  const rapidRuntime = await waitForRuntime(
    (value) =>
      value.generation === rapidStarted.generation &&
      value.pid === rapidStarted.pid &&
      value.mainMarker === "main-v4",
    "latest rapid-save runtime report",
  );
  await until(() => !pidIsAlive(current.runtime.pid), "rapid-save previous Electron exit");
  assert.equal(
    events.slice(rapidStartIndex).filter((event) => event.type === "build-failed").length,
    0,
  );
  const rapidStarts = events.slice(rapidStartIndex).filter((event) => event.type === "started");
  assert.equal(rapidStarts.length, 1, "rapid saves started more than one Electron replacement");
  assert.notEqual(rapidRuntime.pid, current.runtime.pid);
  page.close();
  page = await waitForPage(cdpPort, rapidRuntime.generation);
  current = { runtime: rapidRuntime, page };
  pass("rapid saves coalesce to the latest successful code", {
    generation: rapidRuntime.generation,
    pid: rapidRuntime.pid,
    starts: rapidStarts.length,
  });
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  page?.close();
  if (server !== undefined) {
    try {
      await server.close();
      await until(
        () => taskProcesses().length === 0,
        "task-owned Electron, worker, and tsc processes to stop",
        10_000,
      );
      assert.deepEqual(await sessionArtifacts(), []);
      if (failure === undefined) {
        assertEventProcessOrdering();
        pass("server.close stops owned processes and removes Sewed session artifacts");
      }
    } catch (error) {
      cleanupFailure = error;
      console.error(error);
    }
  }
  if (cleanupFailure !== undefined && failure === undefined) failure = cleanupFailure;
  const finalReport = {
    success: failure === undefined,
    fixture: fixtureRoot,
    packages: ["sewed", "@sewed/vite", "@sewed/devtools"],
    checks,
    events,
    eventViolations,
    runtime: await readRuntime(),
    taskProcesses: taskProcesses(),
    sessionArtifacts: await sessionArtifacts(),
    error: failure?.stack,
  };
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(verificationPath, `${JSON.stringify(finalReport, null, 2)}\n`);
}

if (failure !== undefined) {
  process.exitCode = 1;
  throw failure;
}
