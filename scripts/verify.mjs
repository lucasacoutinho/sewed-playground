import assert from "node:assert/strict";
import { inheritedEnvironment } from "./verify-native.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  checkFeatureMap,
  exerciseFeatureMap,
  featureCoverage,
  featureProgress,
  featureMap,
} from "./feature-map.mjs";
import { captureVerification, compareVerification } from "./verification-state.mjs";

const require = createRequire(import.meta.url);
const development = process.argv.includes("--dev");
const applicationLifetime = process.argv.includes("--lifetime");
const mode = { development, applicationLifetime };
const startedAt = new Date().toISOString();
const artifactPrefix = `${development ? "dev-" : ""}${applicationLifetime ? "lifetime-" : ""}`;
const delay = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
const checks = [];
const sockets = [];
const probes = [];
let output = "";
let exitCode;
let child;
let childClosed;
let provenance = null;
let lastWait = null;
await mkdir(".artifacts", { recursive: true });
const launch = async () => {
  const launched = spawn(
    development ? process.execPath : require("electron"),
    development
      ? [join(dirname(require.resolve("vite/package.json")), "bin/vite.js")]
      : [".", "--remote-debugging-port=0"],
    {
      cwd: process.cwd(),
      env: {
        ...inheritedEnvironment(),
        ...(development ? { SEWED_DEBUG_PORT: "0" } : {}),
        DISPLAY: process.env.DISPLAY || ":0",
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/mnt/wslg/runtime-dir",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  launched.stdout.on("data", (data) => {
    output += data.toString();
  });
  launched.stderr.on("data", (data) => {
    output += data.toString();
  });
  launched.once("exit", (code) => {
    exitCode = code;
  });
  childClosed = new Promise((resolve) => launched.once("close", resolve));
  await new Promise((resolve, reject) => {
    launched.once("spawn", resolve);
    launched.once("error", reject);
  });
  return launched;
};

async function until(test, description, timeout = 6000) {
  lastWait = description;
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const result = await test();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await delay(40);
  }
  throw new Error(`Timed out: ${description}${last ? ` (${last.message})` : ""}`);
}

async function cdp(url) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  const pending = new Map();
  const errors = [];
  let next = 0;
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  socket.onmessage = (event) => {
    const packet = JSON.parse(event.data);
    if (packet.id) {
      const request = pending.get(packet.id);
      if (!request) return;
      pending.delete(packet.id);
      clearTimeout(request.timeout);
      if (packet.error) request.reject(new Error(JSON.stringify(packet.error)));
      else request.resolve(packet.result);
    } else if (packet.method === "Runtime.consoleAPICalled")
      output +=
        JSON.stringify(packet.params.args.map((arg) => arg.value ?? arg.description)) + "\n";
    else if (packet.method === "Runtime.exceptionThrown")
      errors.push(packet.params.exceptionDetails);
  };
  socket.onclose = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("CDP target closed"));
    }
    pending.clear();
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 5000);
      pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const text = (selector) =>
    evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent`);
  const click = async (selector) => {
    await call("Page.bringToFront");
    await until(
      () =>
        evaluate(
          `Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`,
        ),
      `visible control ${selector}`,
    );
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:"center"})`,
    );
    await call("Page.captureScreenshot", { format: "png" });
    const position = await until(
      () =>
        evaluate(`(async () => {
        const element = document.querySelector(${JSON.stringify(selector)});
        element.scrollIntoView({block:"center", behavior:"instant"});
        await new Promise(requestAnimationFrame);
        const before = element.getBoundingClientRect();
        await new Promise(requestAnimationFrame);
        const rect = element.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        return before.x === rect.x && before.y === rect.y &&
          element.contains(document.elementFromPoint(x, y)) ? { x, y } : undefined;
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
  const attribute = (selector, name) =>
    evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)})`,
    );
  const probe = { call, evaluate, text, attribute, click, errors };
  probes.push(probe);
  return probe;
}

const pass = (id, name, evidence = {}) => {
  checks.push({ id, name, evidence });
  console.log(`PASS ${name}`);
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const capture = async (page, name) => {
  await page.evaluate("document.fonts.ready.then(() => true)");
  const shot = await page.call("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  await writeFile(`.artifacts/${artifactPrefix}${name}.png`, Buffer.from(shot.data, "base64"));
};
const state = (page) =>
  page.attribute(featureMap.features.requests.observations.status, "data-work-status");
const result = (page) => page.attribute("[data-work-result]", "data-work-result");
const native = async (page) => JSON.parse(await page.attribute("[data-native]", "data-native"));
const session = async (page) =>
  JSON.parse(await page.attribute(featureMap.features.desktop.observations.state, "data-session"));
const renderer = async (page, name) =>
  (await session(page)).windows.find((window) => window.name === name);
const background = async (page) =>
  JSON.parse(await page.attribute(featureMap.features.background.surface, "data-app-work"));
const backgroundEvents = (event) =>
  output.split(/\r?\n/).filter((line) => line.includes(`playground.background.${event}`));
const clockEvents = (event) =>
  output.split(/\r?\n/).filter((line) => line.includes(`playground.clock.${event}`));
const inspect = async (page) =>
  until(async () => {
    const value = await page.attribute("[data-info]", "data-info");
    return value ? JSON.parse(value) : undefined;
  }, "worker snapshot stream");
const runtimeLane = async (page) => ({
  id: await page.attribute("[data-runtime-lane]", "data-runtime-id"),
  renders: Number(await page.attribute("[data-runtime-lane]", "data-runtime-renders")),
  stream: await page.attribute("[data-runtime-lane]", "data-runtime-stream"),
  resource: await page.attribute("[data-runtime-lane]", "data-runtime-resource"),
  action: await page.attribute("[data-runtime-lane]", "data-runtime-action"),
});

try {
  await checkFeatureMap();
  provenance = await captureVerification();
  child = await launch();
  const meta = JSON.parse(await readFile("dist/renderer/renderer-meta.json", "utf8"));
  const nativeInputs = Object.keys(meta.inputs).filter(
    (path) =>
      /sewed\/lib\/(App|BaseWindow|BrowserWindow|WebContentsView|Host|WorkerHost|Worker|internal\/(MainBridge|NodePort|Window|WebContentsView|WebContents|WorkerBindings|worker-entry))\.js$/.test(
        path,
      ) || /src\/(main|worker)\//.test(path),
  );
  assert.deepEqual(nativeInputs, [], "Native implementations entered the renderer bundle");
  pass(
    "renderer-bundle",
    "renderer bundle contains clients and UI without native or worker implementations",
  );

  const ws = await until(
    () => output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1],
    "Electron debug endpoint",
    15000,
  );
  const endpoint = `http://${new URL(ws).host}`;
  const targets = () => fetch(`${endpoint}/json/list`).then((response) => response.json());
  const pages = await until(async () => {
    const list = (await targets()).filter(
      (target) =>
        target.type === "page" &&
        (development
          ? target.url.startsWith("http://127.0.0.1:")
          : target.url.includes("sewed-playground/dist/renderer/index.html")),
    );
    return list.length === 2 ? list : undefined;
  }, "two renderer windows");
  const first = await cdp(
    pages.find((page) => new URL(page.url).searchParams.get("window") === "first")
      .webSocketDebuggerUrl,
  );
  const second = await cdp(
    pages.find((page) => new URL(page.url).searchParams.get("window") === "second")
      .webSocketDebuggerUrl,
  );
  const runtimeLaneEarly = await runtimeLane(first);
  assert.ok(["idle", "running"].includes(runtimeLaneEarly.action), runtimeLaneEarly.action);
  assert.ok(["loading", "value"].includes(runtimeLaneEarly.stream), runtimeLaneEarly.stream);
  assert.ok(["loading", "ready"].includes(runtimeLaneEarly.resource), runtimeLaneEarly.resource);
  for (const page of [first, second]) {
    await until(
      () => page.attribute(featureMap.features.desktop.observations.identity, "data-window"),
      "React playground mounted",
    );
    assert.equal(
      await page.attribute(featureMap.features.desktop.observations.identity, "data-window"),
      page === first ? "first" : "second",
    );
    await until(
      async () => Number(await page.text(featureMap.features.requests.observations.thread)) > 0,
      "worker client connected",
    );
  }
  const thread = Number(await first.text(featureMap.features.requests.observations.thread));
  assert.equal(
    await first.attribute(featureMap.features.requests.navigation, "aria-current"),
    "page",
  );
  assert.equal(Number(await second.text(featureMap.features.requests.observations.thread)), thread);
  assert.equal(await first.evaluate("typeof require"), "undefined");
  const owner = (await session(first)).worker.id;
  assert.equal((await session(second)).worker.id, owner);
  assert.equal((await session(first)).windows.length, 2);
  pass("shared-worker", "two windows share one worker instance", { thread, owner });

  for (const page of [first, second]) {
    await until(
      async () => (await background(page)).status === "running",
      "main-owned stream observed",
    );
    assert.equal((await background(page)).thread, thread);
  }
  assert.equal(backgroundEvents("acquired").length, 1);
  assert.equal(backgroundEvents("started").length, 1);
  assert.match(backgroundEvents("started")[0], /\bwindows:\s*0\b/);
  pass("background-start", "main starts one bound worker stream before creating any window", {
    thread,
  });

  const sourceThread = (await background(first)).sourceThread;
  const clockOwner = (await session(first)).clock.id;
  assert.ok(sourceThread > 0);
  assert.notEqual(sourceThread, thread);
  assert.notEqual(clockOwner, owner);
  for (const page of [first, second]) {
    assert.equal((await background(page)).sourceThread, sourceThread);
    assert.deepEqual((await session(page)).clock, { id: clockOwner, status: "running" });
  }
  assert.equal(clockEvents("acquired").length, 1);
  assert.equal(clockEvents("released").length, 0);
  pass("worker-dependency", "compute reads a stream from its explicitly bound clock worker", {
    thread,
    sourceThread,
    clockOwner,
  });

  const mappedFeatures = await exerciseFeatureMap(first, until);
  pass(
    "feature-map",
    "the feature map locates every feature and its controls through keyboard navigation",
    {
      features: mappedFeatures,
    },
  );

  await until(async () => (await runtimeLane(first)).stream === "value", "runtime lane ready");
  const runtimeLaneReady = await runtimeLane(first);
  assert.equal(runtimeLaneReady.id, runtimeLaneEarly.id);
  assert.equal(runtimeLaneReady.stream, "value");
  assert.equal(runtimeLaneReady.resource, "ready");
  assert.equal(runtimeLaneReady.action, "idle");
  assert.ok(runtimeLaneReady.renders >= runtimeLaneEarly.renders, runtimeLaneReady.renders);
  await delay(50);
  const runtimeLaneSettled = await runtimeLane(first);
  assert.equal(runtimeLaneSettled.id, runtimeLaneEarly.id);
  assert.ok(runtimeLaneSettled.renders >= runtimeLaneReady.renders, runtimeLaneSettled.renders);
  pass(
    "runtime-ungated",
    "every hook runs unconditionally from first render; the runtime lane never remounts as the store connects and becomes ready",
    { early: runtimeLaneEarly, ready: runtimeLaneReady },
  );

  if (development) {
    const sourcePath = "src/renderer/features/renderer/RendererLane.tsx";
    const original = await readFile(sourcePath, "utf8");
    const sourceHash = sha256(original);
    const changed = original.replace("Click while the worker is busy", "Renderer hot update");
    assert.notEqual(changed, original);
    await first.click(featureMap.features.renderer.controls.increment);
    try {
      await writeFile(sourcePath, changed);
      for (const page of [first, second]) {
        await until(
          async () =>
            (await page.text(featureMap.features.renderer.observations.count)).includes(
              "Renderer hot update",
            ),
          "React Fast Refresh",
          15000,
        );
      }
      assert.equal(
        await first.attribute(featureMap.features.renderer.observations.count, "data-count"),
        "1",
      );
      assert.equal(
        await second.attribute(featureMap.features.renderer.observations.count, "data-count"),
        "0",
      );
      assert.equal((await session(first)).worker.id, owner);
    } finally {
      // Chokidar throttles changes to the same file for 50 ms.
      await delay(100);
      assert.equal(
        await readFile(sourcePath, "utf8"),
        changed,
        "Concurrent source edit detected; refusing to overwrite it",
      );
      await writeFile(sourcePath, original);
    }
    for (const page of [first, second]) {
      await until(
        async () =>
          (await page.text(featureMap.features.renderer.observations.count)).includes(
            "Click while the worker is busy",
          ),
        "source restored after Fast Refresh",
      );
    }
    assert.equal(
      sha256(await readFile(sourcePath, "utf8")),
      sourceHash,
      "Fast Refresh source was not restored exactly",
    );
    assert.equal(
      await first.attribute(featureMap.features.renderer.observations.count, "data-count"),
      "1",
    );
    assert.equal(
      await second.attribute(featureMap.features.renderer.observations.count, "data-count"),
      "0",
    );
    await first.click(featureMap.features.desktop.controls.reload);
    await until(
      async () =>
        Number(await first.text(featureMap.features.requests.observations.thread)) === thread &&
        (await first.attribute(featureMap.features.renderer.observations.count, "data-count")) ===
          "0",
      "renderer reset after HMR probe",
    );
    pass(
      "fast-refresh",
      "Vite Fast Refresh updates React components while preserving local state and the worker owner",
      { sourcePath, sourceHash },
    );
  }

  await first.call("Page.bringToFront");
  await first.evaluate("window.scrollTo(0, 0)");
  await capture(first, "playground");
  const before = Number(await first.text(featureMap.features.renderer.observations.heartbeat));
  await first.click(featureMap.features.requests.controls.cpu);
  await until(async () => (await state(first)) === "running", "CPU request running");
  await first.click(featureMap.features.renderer.controls.increment);
  await first.click(featureMap.features.desktop.controls.maximize);
  await delay(250);
  const after = Number(await first.text(featureMap.features.renderer.observations.heartbeat));
  assert.equal(await state(first), "running");
  assert.equal(
    await first.attribute(featureMap.features.renderer.observations.count, "data-count"),
    "1",
  );
  assert.ok(after - before >= 5, `Renderer heartbeat advanced only ${after - before} ticks`);
  await until(async () => (await native(first)).maximized, "native window maximized");
  pass("cpu-responsive", "renderer and main remain responsive during synchronous worker CPU work", {
    heartbeatTicks: after - before,
  });
  await until(async () => (await result(first)) === "CPU completed", "CPU work completed");
  assert.equal((await native(second)).maximized, false);
  assert.equal(
    await second.attribute(featureMap.features.renderer.observations.count, "data-count"),
    "0",
  );
  await first.click(featureMap.features.desktop.controls.restore);
  await until(async () => !(await native(first)).maximized, "native window restored");
  pass("window-isolation", "window controls and React state belong to the calling window");

  await first.click(featureMap.features.requests.controls.reject);
  await until(
    async () =>
      (await first.text(featureMap.features.requests.observations.error)).includes(
        "The worker returned a typed error",
      ),
    "typed RPC error",
  );
  assert.equal((await session(first)).worker.status, "running");
  pass("typed-errors", "typed worker errors reach React without stopping the owner");

  await first.click(featureMap.features.scopes.navigation);
  await first.click(featureMap.features.scopes.controls.acquire);
  await until(
    async () =>
      (await first.attribute(
        featureMap.features.scopes.observations.leases,
        "data-lease-count",
      )) === "1",
    "successful action keeps its scope",
  );
  await delay(80);
  assert.equal(
    await first.attribute(featureMap.features.scopes.observations.leases, "data-lease-count"),
    "1",
  );
  await capture(first, "scopes");
  await first.click(featureMap.features.scopes.controls.acquire);
  await delay(80);
  assert.equal(
    await first.attribute(featureMap.features.scopes.observations.leases, "data-lease-count"),
    "1",
  );
  await first.click(featureMap.features.scopes.controls.release);
  await until(
    async () =>
      (await first.attribute(
        featureMap.features.scopes.observations.leases,
        "data-lease-count",
      )) === "0",
    "cancel releases successful scope",
  );
  await first.click(featureMap.features.scopes.controls.fail);
  await until(
    async () =>
      (await first.text(featureMap.features.scopes.observations.result)).includes(
        "Failure released",
      ),
    "failed action releases scope",
  );
  assert.equal(
    await first.attribute(featureMap.features.scopes.observations.leases, "data-lease-count"),
    "0",
  );
  await first.click(featureMap.features.scopes.controls.acquire);
  await until(
    async () =>
      (await first.attribute(
        featureMap.features.scopes.observations.leases,
        "data-lease-count",
      )) === "1",
    "lease acquired before unmount",
  );
  await first.click(featureMap.features.scopes.controls.unmount);
  await until(
    async () =>
      (await first.attribute(
        featureMap.features.scopes.observations.leases,
        "data-lease-count",
      )) === "0",
    "unmount releases successful scope",
  );
  pass(
    "react-scopes",
    "React action scopes close on replacement, cancellation, failure, and unmount",
  );

  {
    const surfaces = featureMap.features.surfaces;
    await first.click(surfaces.navigation);
    await until(
      async () => (await first.attribute(surfaces.observations.theme, "data-theme-source")) !== null,
      "theme state replayed",
    );
    await first.click(surfaces.controls.dark);
    await until(
      async () => (await first.attribute(surfaces.observations.theme, "data-dark")) === "true",
      "dark theme observed",
    );
    await first.click(surfaces.controls.light);
    await until(
      async () => (await first.attribute(surfaces.observations.theme, "data-dark")) === "false",
      "light theme observed",
    );
    await first.click(surfaces.controls.system);
    await until(
      async () =>
        (await first.attribute(surfaces.observations.theme, "data-theme-source")) === "system",
      "system theme restored",
    );
    pass("theme-source", "a bound theme owner switches the native theme and streams the result");

    const copied = `Sewed clipboard ${Date.now()}`;
    await first.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(surfaces.observations.clipboardInput)});
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, ${JSON.stringify(copied)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await first.click(surfaces.controls.copy);
    await delay(200);
    await first.click(surfaces.controls.read);
    await until(
      async () => (await first.text(surfaces.observations.clipboard)) === copied,
      "clipboard round trip",
      40_000,
    );
    pass("clipboard-roundtrip", "a text-only clipboard host copies and reads through the binding", {
      copied,
    });

    await first.click(surfaces.controls.power);
    await until(async () => {
      const value = await first.attribute(surfaces.observations.power, "data-power-state");
      return value !== null && ["active", "idle", "locked", "unknown"].includes(JSON.parse(value).idleState);
    }, "power snapshot");
    pass("power-snapshot", "a bound power monitor answers a validated state query");

    await first.click(surfaces.controls.zoomIn);
    await until(
      async () => (await first.attribute(surfaces.observations.zoom, "data-zoom")) === "1.25",
      "zoom applied",
    );
    assert.notEqual(await second.attribute(surfaces.observations.zoom, "data-zoom"), "1.25");
    await first.click(surfaces.controls.zoomReset);
    await until(
      async () => (await first.attribute(surfaces.observations.zoom, "data-zoom")) === "1",
      "zoom reset",
    );
    pass("window-zoom", "zoom through the window controls binding changes only the calling window");
  }

  {
    const guest = featureMap.features.guest;
    await first.click(guest.navigation);
    await until(
      async () => (await first.attribute(guest.observations.state, "data-guest-state")) === "ready",
      "guest tab ready",
    );
    const home = await first.attribute(guest.observations.state, "data-guest-url");
    pass("guest-ready", "a bound guest owner streams the guest's ready state", { home });

    const typeUrl = async (value) => {
      await first.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(guest.controls.urlInput)});
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
    };
    await typeUrl(`${home}two`);
    await first.click(guest.controls.go);
    await until(
      async () =>
        ((await first.attribute(guest.observations.state, "data-guest-url")) ?? "").endsWith("/two"),
      "guest navigated within the policy",
    );
    await first.click(guest.controls.back);
    await until(
      async () => (await first.attribute(guest.observations.state, "data-guest-url")) === home,
      "guest history moved back",
    );
    pass("guest-navigate", "navigate and back ride the guest protocol within the host policy");

    await typeUrl("https://example.com/");
    await first.click(guest.controls.go);
    await until(
      async () => ((await first.text(guest.observations.error)) ?? "").includes("Protocol"),
      "navigation outside the policy rejected",
    );
    pass("guest-policy", "a navigation outside the pattern policy fails with Protocol at the boundary");

    let bytes = 0;
    for (let attempt = 0; attempt < 5 && bytes === 0; attempt++) {
      await first.click(guest.controls.capture);
      await delay(400);
      bytes = Number((await first.attribute(guest.observations.captured, "data-guest-capture-bytes")) ?? 0);
    }
    assert.ok(bytes > 0, "guest capture returned bytes");
    pass("guest-capture", "capture through the host policy returns PNG bytes", { bytes });
  }

  await first.click(featureMap.features.desktop.navigation);
  await first.click(featureMap.features.requests.controls.slow);
  await until(async () => (await inspect(second)).active === 1, "slow request entered worker");
  await first.click(featureMap.features.requests.controls.replace);
  await until(async () => (await result(first)) === "latest", "latest result published");
  await until(async () => (await inspect(second)).active === 0, "superseded request released");
  pass(
    "request-replacement",
    "latest action interrupts the old request and publishes the new result",
  );

  await first.click(featureMap.features.requests.controls.slow);
  await until(async () => (await inspect(second)).active === 1, "request active before cancel");
  await first.click(featureMap.features.requests.controls.cancel);
  await until(async () => (await inspect(second)).active === 0, "cancel reached worker");
  assert.equal(await state(first), "interrupted");
  pass(
    "request-cancellation",
    "explicit cancellation releases the worker handler and updates both snapshots",
  );

  const beforeReload = (await inspect(second)).released;
  const backgroundBeforeReload = (await background(second)).ticks;
  await first.click(featureMap.features.requests.controls.slow);
  await until(async () => (await inspect(second)).active === 1, "request active before reload");
  await first.click(featureMap.features.desktop.controls.reload);
  await until(
    async () =>
      Number(await first.text(featureMap.features.requests.observations.thread)) === thread &&
      (await state(first)) === "idle",
    "new renderer bound",
  );
  await until(async () => {
    const info = await inspect(second);
    return info.active === 0 && info.released > beforeReload;
  }, "old document request released");
  assert.equal((await session(first)).worker.id, owner);
  assert.equal(
    await first.attribute(featureMap.features.renderer.observations.count, "data-count"),
    "0",
  );
  pass(
    "document-reload",
    "reload releases document requests and local state, then binds the same worker",
  );
  for (const page of [first, second]) {
    await until(async () => {
      const work = await background(page);
      return work.status === "running" && work.ticks > backgroundBeforeReload;
    }, "main-owned stream continues across renderer reload");
    assert.equal((await background(page)).thread, thread);
    assert.equal((await background(page)).sourceThread, sourceThread);
    assert.deepEqual((await session(page)).clock, { id: clockOwner, status: "running" });
  }
  assert.equal(backgroundEvents("acquired").length, 1);
  assert.equal(backgroundEvents("released").length, 0);
  assert.equal(clockEvents("acquired").length, 1);
  assert.equal(clockEvents("released").length, 0);
  pass("background-reload", "renderer reload preserves the application's existing worker stream");

  const firstRenderer = await renderer(second, "first");
  const secondRenderer = await renderer(second, "second");
  assert.equal(firstRenderer.contents.status, "ready");
  assert.equal(secondRenderer.contents.status, "ready");
  assert.ok(firstRenderer.contents.processId > 0);
  assert.notEqual(firstRenderer.contents.processId, secondRenderer.contents.processId);
  const releasesBeforeCrash = (await inspect(second)).released;
  const ticksBeforeCrash = (await background(second)).ticks;
  await first.click(featureMap.features.renderer.controls.increment);
  assert.equal(
    await first.attribute(featureMap.features.renderer.observations.count, "data-count"),
    "1",
  );
  await first.click(featureMap.features.requests.controls.slow);
  await until(
    async () => (await inspect(second)).active === 1,
    "request active before renderer crash",
  );
  assert.notEqual(firstRenderer.contents.processId, process.pid);
  process.kill(firstRenderer.contents.processId, "SIGKILL");
  await until(
    async () => (await renderer(second, "first")).contents.status === "gone",
    "main observes renderer process loss",
  );
  const lost = await renderer(second, "first");
  assert.equal(lost.owner, firstRenderer.owner);
  assert.ok(["crashed", "killed"].includes(lost.contents.reason));
  assert.equal(typeof lost.contents.exitCode, "number");
  assert.equal((await session(second)).windows.length, 2);
  assert.equal(
    (await renderer(second, "second")).contents.processId,
    secondRenderer.contents.processId,
  );
  await until(async () => {
    const info = await inspect(second);
    return info.active === 0 && info.released > releasesBeforeCrash;
  }, "renderer crash releases its document request");
  await until(
    async () => (await background(second)).ticks > ticksBeforeCrash,
    "main-owned work survives renderer crash",
  );
  assert.equal(backgroundEvents("acquired").length, 1);
  assert.equal(backgroundEvents("released").length, 0);
  assert.equal(clockEvents("acquired").length, 1);
  assert.equal(clockEvents("released").length, 0);
  pass(
    "renderer-loss",
    "renderer process loss releases document requests while native windows and workers survive",
    { contents: lost.contents, owner: lost.owner },
  );

  await second.click(featureMap.features.renderers.navigation);
  await second.call("Emulation.setDeviceMetricsOverride", {
    width: 1160,
    height: 1240,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await capture(second, "renderer-gone");
  await second.call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.equal(await second.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await capture(second, "renderer-narrow");
  await second.call("Emulation.clearDeviceMetricsOverride");
  await second.click(
    `:is(${featureMap.features.renderers.controls.recover})[data-recover-renderer=${JSON.stringify(firstRenderer.owner)}]`,
  );
  await until(async () => {
    const current = await renderer(second, "first");
    return (
      current.contents.status === "ready" &&
      current.contents.processId !== firstRenderer.contents.processId
    );
  }, "explicit reload starts a new renderer process");
  await until(
    async () =>
      Number(await first.text(featureMap.features.requests.observations.thread)) === thread &&
      (await state(first)) === "idle",
    "recovered renderer rebinds existing worker",
  );
  assert.equal((await renderer(second, "first")).owner, firstRenderer.owner);
  assert.equal((await session(first)).worker.id, owner);
  assert.equal((await session(first)).clock.id, clockOwner);
  assert.equal(
    await first.attribute(featureMap.features.renderer.observations.count, "data-count"),
    "0",
  );
  await first.click(featureMap.features.requests.controls.replace);
  await until(
    async () => (await result(first)) === "latest",
    "recovered renderer performs a real worker call",
  );
  await capture(second, "renderer-recovered");
  await second.click(featureMap.features.desktop.navigation);
  pass(
    "renderer-recovery",
    "another window explicitly reloads the lost renderer and keeps the same bound owners",
    {
      before: firstRenderer.contents.processId,
      after: (await renderer(second, "first")).contents.processId,
    },
  );

  await first.click(featureMap.features.desktop.navigation);
  for (const type of ["keyDown", "keyUp"])
    await first.call("Input.dispatchKeyEvent", {
      type,
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
    });
  assert.equal(
    await first.evaluate(
      `document.activeElement?.matches(${JSON.stringify(featureMap.features.scopes.navigation)}) === true`,
    ),
    true,
  );
  for (const type of ["keyDown", "keyUp"])
    await first.call("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
  await until(
    async () =>
      (await first.attribute(featureMap.features.scopes.navigation, "aria-current")) === "page",
    "keyboard route navigation",
  );
  assert.equal(await first.evaluate("location.hash"), `#${featureMap.features.scopes.route}`);
  await first.click(featureMap.features.source.navigation);
  await until(
    async () =>
      (await first.attribute(featureMap.features.source.navigation, "aria-current")) === "page",
    "source route active",
  );
  assert.equal(await first.evaluate("location.hash"), `#${featureMap.features.source.route}`);
  assert.equal((await session(first)).worker.id, owner);
  await first.evaluate("history.back()");
  await until(
    async () =>
      (await first.attribute(featureMap.features.scopes.navigation, "aria-current")) === "page",
    "back navigation",
  );
  await first.evaluate("history.forward()");
  await until(
    async () =>
      (await first.attribute(featureMap.features.source.navigation, "aria-current")) === "page",
    "forward navigation",
  );
  await first.click(featureMap.features.desktop.controls.reload);
  await until(
    async () =>
      (await first.attribute(featureMap.features.source.navigation, "aria-current")) === "page" &&
      Number(await first.text(featureMap.features.requests.observations.thread)) === thread,
    "source route survives reload",
  );
  assert.equal((await session(first)).worker.id, owner);
  await first.click(featureMap.features.source.controls.expand);
  assert.equal(
    await first.evaluate(
      `document.querySelector(${JSON.stringify(featureMap.features.source.controls.expand)})?.parentElement?.open`,
    ),
    true,
  );
  assert.ok(
    (await first.text(featureMap.features.source.surface)).includes(
      "while (performance.now() < end)",
    ),
  );
  await capture(first, "source-boundaries");
  pass(
    "router-navigation",
    "TanStack routes support keyboard links, back/forward history, and reload without changing native owners",
  );

  await first.click(featureMap.features.resources.navigation);
  await until(
    async () =>
      (await first.text(featureMap.features.resources.observations.resource)).includes(
        "Owned by worker thread",
      ),
    "remote resource acquired",
  );
  const byteAcquired = () =>
    output.split(/\r?\n/).filter((line) => line.includes("playground.byte-resource.acquired"))
      .length;
  const byteReleased = () =>
    output.split(/\r?\n/).filter((line) => line.includes("playground.byte-resource.released"))
      .length;
  await until(
    () => byteAcquired() - byteReleased() === 1,
    "committed resource hook owns one worker resource",
  );
  const acquiredBeforeReplacement = byteAcquired();
  await first.click(featureMap.features.resources.controls.acquire);
  await until(
    async () =>
      byteAcquired() > acquiredBeforeReplacement &&
      byteAcquired() - byteReleased() === 1 &&
      (await first.attribute(
        featureMap.features.resources.observations.resource,
        "data-resource-state",
      )) === "ready",
    "explicit replacement waits for old resource cleanup",
  );
  const releasesBeforeTransfer = byteReleased();
  await first.click(featureMap.features.resources.controls.read);
  await until(
    async () =>
      Number(
        await first.attribute(
          featureMap.features.resources.observations.bytes,
          "data-received-bytes",
        ),
      ) > 0,
    "binary chunks reach React",
  );
  await first.click(featureMap.features.resources.controls.cancel);
  await until(
    async () =>
      (await first.text(featureMap.features.resources.observations.transfer)).includes(
        "Transfer cancelled",
      ),
    "byte stream cancelled",
  );
  assert.equal(byteReleased(), releasesBeforeTransfer);
  await first.click(featureMap.features.resources.controls.read);
  await until(
    async () =>
      (await first.text(featureMap.features.resources.observations.transfer)).includes(
        "Received 32 MiB",
      ),
    "complete native binary stream",
    20000,
  );
  assert.equal(
    await first.attribute(featureMap.features.resources.observations.bytes, "data-received-bytes"),
    String(32 * 1024 * 1024),
  );
  await capture(first, "remote-data");
  await first.click(featureMap.features.resources.controls.release);
  await until(
    () => byteReleased() === byteAcquired(),
    "explicit release acknowledges worker finalizer",
  );
  await until(
    async () =>
      (await first.text(featureMap.features.resources.observations.resource)).includes(
        "Resource released",
      ),
    "released resource UI",
  );
  const acquisitionsBeforeReload = byteAcquired();
  await first.click(featureMap.features.resources.controls.acquire);
  await until(
    () => byteAcquired() > acquisitionsBeforeReload,
    "resource acquired again after release",
  );
  await first.click(featureMap.features.source.navigation);
  await until(() => byteReleased() === byteAcquired(), "route unmount releases remote resource");
  let liveResources = 0;
  for (const line of output.split(/\r?\n/)) {
    if (line.includes("playground.byte-resource.acquired")) liveResources += 1;
    if (line.includes("playground.byte-resource.released")) liveResources -= 1;
    assert.ok(liveResources >= 0 && liveResources <= 1, "resource lifetimes must never overlap");
  }
  pass(
    "remote-resource",
    "a StrictMode React resource hook acquires after commit, serializes replacement, streams 32 MiB, and releases on route exit",
    { acquired: byteAcquired(), released: byteReleased(), liveResources },
  );

  await first.call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await first.evaluate("window.scrollTo(0, 0)");
  await until(() => first.evaluate("window.innerWidth === 390"), "narrow viewport");
  assert.ok(
    await first.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
    "Narrow layout overflows horizontally",
  );
  await capture(first, "narrow");
  await first.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  assert.equal(
    await first.evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'),
    true,
  );
  await first.click(featureMap.features.desktop.navigation);
  await first.click(featureMap.features.requests.controls.slow);
  assert.equal(
    await first.evaluate(
      'getComputedStyle(document.querySelector(".worker-glyph span")).animationName',
    ),
    "none",
  );
  await first.click(featureMap.features.requests.controls.cancel);
  await until(async () => (await inspect(second)).active === 0, "narrow cancellation");
  await first.call("Emulation.clearDeviceMetricsOverride");
  await first.call("Emulation.setEmulatedMedia", { features: [] });
  await first.evaluate("window.scrollTo(0, 0)");
  pass(
    "accessible-layout",
    "narrow layout has no horizontal overflow and reduced motion disables activity animation",
  );

  if (!applicationLifetime) {
    await second.click(featureMap.features.requests.controls.slow);
    await until(
      async () => (await inspect(first)).active === 1,
      "request pending before worker termination",
    );
    await second.click(featureMap.features.desktop.controls.terminate);
    await until(
      async () =>
        (await session(first)).worker.status === "stopped" &&
        (await session(second)).worker.status === "stopped",
      "both windows observe owner exit",
    );
    await until(
      async () => (await state(second)) === "failure",
      "pending request fails on owner exit",
    );
    for (const page of [first, second]) {
      for (const selector of [
        featureMap.features.requests.controls.cpu,
        featureMap.features.requests.controls.slow,
        featureMap.features.requests.controls.replace,
        featureMap.features.requests.controls.reject,
        featureMap.features.desktop.controls.terminate,
      ]) {
        assert.equal(
          await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).disabled`),
          true,
        );
      }
      assert.ok((await page.text(".stopped-banner")).includes("pnpm start"));
    }
    await first.click(featureMap.features.renderer.controls.increment);
    assert.equal(
      await first.attribute(featureMap.features.renderer.observations.count, "data-count"),
      "1",
    );
    await first.click(featureMap.features.desktop.controls.maximize);
    await until(async () => (await native(first)).maximized, "native controls survive worker exit");
    await first.click(featureMap.features.desktop.controls.restore);
    await until(async () => !(await native(first)).maximized, "restore after worker exit");
    await first.evaluate("window.scrollTo(0, 0)");
    await capture(first, "worker-stopped");
    assert.equal((await session(first)).worker.id, owner);
    assert.ok(
      !output.includes("Error occurred in handler for 'sewed:open'"),
      "Playground attempted a call after owner exit",
    );
    pass(
      "worker-exit",
      "worker exit fails pending calls, disables requests in both windows, and preserves renderer and main controls",
    );

    await first.click(featureMap.features.desktop.controls.reload);
    await until(
      async () =>
        (await session(first)).worker.status === "stopped" && (await state(first)) === "idle",
      "reload after owner exit",
    );
    assert.equal(
      await first.evaluate(
        `document.querySelector(${JSON.stringify(featureMap.features.requests.controls.cpu)}).disabled`,
      ),
      true,
    );
    assert.equal((await session(first)).worker.id, owner);
    assert.ok(
      !output.includes("Error occurred in handler for 'sewed:open'"),
      "Reload attempted to reopen an exited worker",
    );
    pass(
      "stopped-owner-reload",
      "reload preserves stopped owner state without reconnecting to the dead worker",
    );
    for (const page of [first, second]) {
      await until(
        async () => (await background(page)).status === "stopped",
        "main observes stream stopped",
      );
      assert.deepEqual((await session(page)).clock, { id: clockOwner, status: "running" });
    }
    await until(
      () => clockEvents("released").length === 1,
      "consumer exit releases clock subscription",
    );
    assert.equal(clockEvents("stopped").length, 0);
    pass(
      "dependency-cleanup",
      "compute termination releases its downstream stream while the clock owner stays alive",
    );
  }

  const backgroundBeforeClose = await background(second);
  await first.click(featureMap.features.desktop.controls.close).catch((error) => {
    if (!error.message.includes("closed")) throw error;
  });
  await until(
    async () =>
      !(await targets()).some(
        (target) => new URL(target.url).searchParams.get("window") === "first",
      ),
    "first native window closed",
  );
  await until(
    async () => (await session(second)).windows.length === 1,
    "live window count updates",
  );
  await until(
    () =>
      output.split(/\r?\n/).filter((line) => line.includes("playground.contents.observer.closed"))
        .length === 1,
    "closed window completes its main-owned web contents observer",
  );
  if (applicationLifetime) {
    assert.equal(backgroundBeforeClose.status, "running");
    await until(async () => {
      const work = await background(second);
      return work.status === "running" && work.ticks > backgroundBeforeClose.ticks;
    }, "main-owned stream survives closing a window");
    assert.equal((await session(second)).worker.id, owner);
    assert.deepEqual((await session(second)).clock, { id: clockOwner, status: "running" });
    assert.equal((await background(second)).sourceThread, sourceThread);
    assert.equal(backgroundEvents("acquired").length, 1);
    assert.equal(backgroundEvents("released").length, 0);
    assert.equal(clockEvents("released").length, 0);
    pass(
      "background-window-close",
      "closing one window leaves the application-owned stream running",
    );
  }
  assert.equal(first.errors.length, 0, JSON.stringify(first.errors));
  assert.equal(second.errors.length, 0, JSON.stringify(second.errors));
  await second.click(featureMap.features.desktop.controls.close).catch((error) => {
    if (!error.message.includes("closed")) throw error;
  });
  await until(() => exitCode !== undefined, "application quit after last window closed");
  assert.equal(exitCode, 0, output);
  pass(
    "window-shutdown",
    "window ownership updates on close and application scope closes cleanly on quit",
    {
      exitCode,
    },
  );
  if (applicationLifetime) {
    assert.equal(backgroundEvents("released").length, 1, output);
    assert.equal(backgroundEvents("acquired").length, 1);
    pass(
      "background-shutdown",
      "application shutdown releases the pending worker stream and exits cleanly",
    );
  }
  assert.equal(clockEvents("acquired").length, 1);
  assert.equal(clockEvents("released").length, 1, output);
  assert.equal(clockEvents("stopped").length, 1, output);
  pass("clock-shutdown", "application shutdown releases the clock stream and closes its owner");
  assert.equal(
    output.split(/\r?\n/).filter((line) => line.includes("playground.contents.observer.closed"))
      .length,
    2,
  );
  const coverage = featureCoverage(checks, mode);
  const freshness = await compareVerification(provenance);
  assert.equal(
    freshness.status,
    "current",
    `Files changed during verification: ${freshness.changed.join(", ")}`,
  );
  await writeFile(
    `.artifacts/${artifactPrefix}verification.json`,
    JSON.stringify(
      {
        version: 1,
        success: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        checks,
        coverage,
        mode,
        provenance,
      },
      null,
      2,
    ),
  );
} catch (error) {
  for (const [index, probe] of probes.entries()) {
    try {
      await writeFile(
        `.artifacts/${artifactPrefix}failure-${index}.txt`,
        await probe.evaluate("document.body.innerText"),
      );
      const shot = await probe.call("Page.captureScreenshot", { format: "png" });
      await writeFile(
        `.artifacts/${artifactPrefix}failure-${index}.png`,
        Buffer.from(shot.data, "base64"),
      );
    } catch {}
  }
  let coverage = null;
  let coverageError = null;
  try {
    coverage = featureProgress(checks, mode);
  } catch (cause) {
    coverageError = cause.message;
  }
  await writeFile(
    `.artifacts/${artifactPrefix}verification.json`,
    JSON.stringify(
      {
        version: 1,
        success: false,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: error.message,
        checks,
        mode,
        provenance,
        coverage,
        coverageError,
        context: { lastCompletedCheck: checks.at(-1)?.id ?? null, lastWait },
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  for (const socket of sockets) socket.close();
  if (child !== undefined) {
    if (exitCode === undefined) child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
    try {
      await childClosed;
    } finally {
      clearTimeout(killTimer);
    }
  }
  await writeFile(`.artifacts/${artifactPrefix}electron.log`, output);
}
