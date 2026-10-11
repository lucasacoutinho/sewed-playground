import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { BrowserWindow as NativeWindow, ipcMain } from "electron";
import { Cause, Effect, Scope, Exit } from "effect";
import { Binding, Decidables, Decision, Renderer } from "sewed";
import { App, BrowserWindow, Utility, Worker } from "sewed/main";
import * as DevTools from "@sewed/devtools";
import { Compute, Protocol } from "./devtools-contract.mjs";

const checks = [];
let lastSnapshot;
const record = (name, evidence = {}) => checks.push({ name, evidence });
const joinedRpc = (
  snapshot,
  { procedure, callerRuntime, callerRuntimeId, serverRuntime, ownerId },
) => {
  const client = snapshot.spans.find(
    (span) =>
      span.name === `RpcClient.${procedure}` &&
      span.runtime === callerRuntime &&
      span.runtimeId === callerRuntimeId &&
      span.binding === Compute.key &&
      span.ownerId === ownerId,
  );
  if (client === undefined) return undefined;
  const server = snapshot.spans.find(
    (span) =>
      span.name === `RpcServer.${procedure}` &&
      span.runtime === serverRuntime &&
      span.ownerId === ownerId &&
      span.traceId === client.traceId &&
      span.parentId === client.spanId,
  );
  return server === undefined ? undefined : { client, server };
};
const until = (read, label) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt++) {
      const value = yield* read;
      if (value) return value;
      yield* Effect.sleep(10);
    }
    throw new Error(`Timed out: ${label}`);
  });
const run = Effect.gen(function* () {
  yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
  yield* Effect.promise(() => mkdir(".artifacts", { recursive: true }));
  const toolScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(toolScope, Exit.void));
  const nativeWindowsBefore = NativeWindow.getAllWindows().map((window) => window.webContents.id);
  const registeredChannels = [];
  const tools = yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      const handle = ipcMain.handle;
      ipcMain.handle = (channel, listener) => {
        registeredChannels.push(channel);
        return handle.call(ipcMain, channel, listener);
      };
      return handle;
    }),
    () => DevTools.make({ capacity: 128 }).pipe(Scope.provide(toolScope)),
    (handle) =>
      Effect.sync(() => {
        ipcMain.handle = handle;
      }),
  );
  const nativeWindowsAfter = NativeWindow.getAllWindows().map((window) => window.webContents.id);
  assert.deepEqual(nativeWindowsAfter, nativeWindowsBefore);
  assert.deepEqual(registeredChannels, []);
  const initialSnapshot = yield* tools.snapshot;
  lastSnapshot = initialSnapshot;
  assert.equal(initialSnapshot.capacity, 128);
  record("headless DevTools creates no native window or inspector IPC handler", {
    nativeWindowIds: nativeWindowsAfter,
    registeredChannels,
    capacity: initialSnapshot.capacity,
  });
  const inspectSnapshot = (test, label) =>
    until(
      Effect.map(tools.snapshot, (snapshot) => {
        lastSnapshot = snapshot;
        const result = test(snapshot);
        return result === true ? snapshot : result;
      }),
      label,
    );

  const ownersScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(ownersScope, Exit.void));
  const owners = yield* Effect.gen(function* () {
    const worker = yield* Worker.spawn(
      Worker.entry(new URL("./devtools-worker.mjs", import.meta.url), Protocol),
    );
    const utility = yield* Utility.spawn(
      Utility.entry(new URL("./devtools-utility.mjs", import.meta.url), Protocol),
    );
    const utilityPlacement = yield* Effect.gen(function* () {
      const compute = yield* Compute();
      return yield* compute.placement();
    }).pipe(Effect.provide(Binding.layer([Binding.to(Compute, utility)])));
    assert.equal(utilityPlacement, utility.processId);
    assert.notEqual(utilityPlacement, process.pid);
    const window = yield* BrowserWindow.make({
      title: "DevTools inspected renderer",
      width: 640,
      height: 400,
    });
    yield* window.webContents.load(
      Renderer.entry(new URL("../.artifacts/devtools-renderer/index.html", import.meta.url), {
        bindings: [Compute],
      }),
      { bindings: [Binding.to(Compute, worker)] },
    );
    const placement = yield* Effect.gen(function* () {
      const compute = yield* Compute();
      return yield* compute.placement();
    }).pipe(
      Effect.withSpan("inspect worker placement"),
      Effect.provide(Binding.layer([Binding.to(Compute, worker)])),
    );
    assert.ok(placement > 0);
    return { worker, utility, window, placement, utilityPlacement };
  }).pipe(Effect.provide(tools.layer), Scope.provide(ownersScope));
  const native = NativeWindow.getAllWindows().find((window) =>
    window.webContents.getURL().includes("/devtools-renderer/"),
  );
  assert.ok(native);
  const evaluate = (source) => Effect.promise(() => native.webContents.executeJavaScript(source));
  const connected = yield* inspectSnapshot(
    (snapshot) =>
      snapshot.diagnostics.requests.some((request) => request.procedure === "ticks") &&
      snapshot.spans.some(
        (span) => span.name === "inspect worker placement" && span.outcome === "success",
      ),
    "actual worker request and Effect span",
  );
  assert.equal(
    connected.diagnostics.owners.find((owner) => owner.ownerId === owners.worker.id)?.threadId,
    owners.placement,
  );
  assert.equal(
    connected.diagnostics.owners.find((owner) => owner.ownerId === owners.utility.id)?.processId,
    owners.utility.processId,
  );
  const oldBinding = connected.diagnostics.bindings.find(
    (binding) => binding.runtime === "renderer",
  );
  assert.ok(oldBinding);
  assert.equal(oldBinding.ownerId, owners.worker.id);
  const rendererRuntimeId = oldBinding.runtimeId;
  const traced = yield* inspectSnapshot((snapshot) => {
    const mainWorker = joinedRpc(snapshot, {
      procedure: "placement",
      callerRuntime: "main",
      callerRuntimeId: "main",
      serverRuntime: "worker",
      ownerId: owners.worker.id,
    });
    const mainUtility = joinedRpc(snapshot, {
      procedure: "placement",
      callerRuntime: "main",
      callerRuntimeId: "main",
      serverRuntime: "utility",
      ownerId: owners.utility.id,
    });
    const rendererWorker = joinedRpc(snapshot, {
      procedure: "ticks",
      callerRuntime: "renderer",
      callerRuntimeId: rendererRuntimeId,
      serverRuntime: "worker",
      ownerId: owners.worker.id,
    });
    return mainWorker !== undefined && mainUtility !== undefined && rendererWorker !== undefined
      ? { snapshot, mainWorker, mainUtility, rendererWorker }
      : false;
  }, "cross-runtime RPC parent joins");
  assert.equal(traced.mainWorker.server.parentId, traced.mainWorker.client.spanId);
  assert.equal(traced.mainUtility.server.parentId, traced.mainUtility.client.spanId);
  assert.equal(traced.rendererWorker.server.parentId, traced.rendererWorker.client.spanId);
  assert.equal(traced.mainWorker.server.traceId, traced.mainWorker.client.traceId);
  assert.equal(traced.mainUtility.server.traceId, traced.mainUtility.client.traceId);
  assert.equal(traced.rendererWorker.server.traceId, traced.rendererWorker.client.traceId);
  assert.ok(
    traced.mainWorker.server.events.some((event) => event.name === "devtools-worker-placement"),
  );
  assert.ok(
    traced.mainUtility.server.events.some((event) => event.name === "devtools-utility-placement"),
  );
  record(
    "automatic RPC server spans join actual parent trace IDs across main, utility, worker, and renderer",
    {
      mainWorker: {
        client: traced.mainWorker.client.spanId,
        server: traced.mainWorker.server.spanId,
      },
      mainUtility: {
        client: traced.mainUtility.client.spanId,
        server: traced.mainUtility.server.spanId,
      },
      rendererWorker: {
        client: traced.rendererWorker.client.spanId,
        server: traced.rendererWorker.server.spanId,
      },
    },
  );
  assert.equal(yield* evaluate("typeof window.__SEWED_DEVTOOLS__"), "undefined");
  record(
    "the headless snapshot reflects the exact worker binding without granting the app an inspector bridge",
    { ownerId: owners.worker.id, bindingId: oldBinding.bindingId, threadId: owners.placement },
  );
  record(
    "the headless snapshot distinguishes a real utility process by its owner ID and native PID",
    {
      ownerId: owners.utility.id,
      processId: owners.utility.processId,
    },
  );

  const healthy = yield* inspectSnapshot((snapshot) => {
    const runtimeIds = new Set(snapshot.health.runtimes.map((sample) => sample.runtimeId));
    // The queue sample is taken on its own tick, so wait for it with the runtime samples instead
    // of hoping the first complete set of runtimes already carries it.
    return ["main", owners.worker.id, owners.utility.id, rendererRuntimeId].every((id) =>
      runtimeIds.has(id),
    ) &&
      snapshot.health.queues.some(
        (sample) =>
          sample.runtimeId === owners.worker.id &&
          sample.runtime === "worker" &&
          sample.kind === "rpc-server" &&
          (sample.activeRequests ?? 0) >= 1,
      )
      ? snapshot
      : false;
  }, "health samples for all runtime identities and the worker's server queue");
  const healthByRuntime = new Map(
    healthy.health.runtimes.map((sample) => [sample.runtimeId, sample]),
  );
  assert.equal(healthByRuntime.get("main")?.runtime, "main");
  assert.equal(healthByRuntime.get(owners.worker.id)?.runtime, "worker");
  assert.equal(healthByRuntime.get(owners.utility.id)?.runtime, "utility");
  assert.equal(healthByRuntime.get(rendererRuntimeId)?.runtime, "renderer");
  const serverQueue = healthy.health.queues.find(
    (sample) =>
      sample.runtimeId === owners.worker.id &&
      sample.runtime === "worker" &&
      sample.kind === "rpc-server" &&
      (sample.activeRequests ?? 0) >= 1,
  );
  assert.ok(serverQueue);
  record(
    "the headless snapshot retains exact runtime identities and actual server queue pressure",
    {
      runtimes: healthy.health.runtimes.map(({ runtime, runtimeId, delayMs }) => ({
        runtime,
        runtimeId,
        delayMs,
      })),
      queue: serverQueue,
    },
  );

  yield* evaluate("document.querySelector('[data-busy]').click()");
  const busy = yield* inspectSnapshot((snapshot) => {
    const workerSample = snapshot.health.runtimes.find(
      (sample) => sample.runtimeId === owners.worker.id,
    );
    const joined = joinedRpc(snapshot, {
      procedure: "busy",
      callerRuntime: "renderer",
      callerRuntimeId: rendererRuntimeId,
      serverRuntime: "worker",
      ownerId: owners.worker.id,
    });
    return workerSample !== undefined &&
      workerSample.delayMs > 100 &&
      joined !== undefined &&
      joined.client.outcome === "success" &&
      joined.server.outcome === "success"
      ? { snapshot, workerSample, joined }
      : false;
  }, "busy worker lateness and renderer-to-worker trace join");
  assert.equal(
    yield* until(
      evaluate("document.querySelector('[data-busy-status]')?.textContent.includes('Busy 750ms')"),
      "renderer remains usable after a busy worker RPC",
    ),
    true,
  );
  assert.ok(busy.joined.server.events.some((event) => event.name === "devtools-worker-busy"));
  record(
    "a bounded worker busy loop produces measured timer lateness while the renderer stays usable",
    {
      delayMs: busy.workerSample.delayMs,
      rendererSpanId: busy.joined.client.spanId,
      workerSpanId: busy.joined.server.spanId,
    },
  );

  yield* evaluate("document.querySelector('[data-stream-toggle]').click()");
  const cancelled = yield* inspectSnapshot((snapshot) => {
    const started = snapshot.diagnostics.events
      .map(({ event }) => event)
      .find(
        (event) =>
          event._tag === "RequestStarted" &&
          event.ownerId === owners.worker.id &&
          event.procedure === "ticks",
      );
    if (started === undefined || started.traceId === undefined || started.spanId === undefined)
      return false;
    const ended = snapshot.diagnostics.events.some(
      ({ event }) =>
        event._tag === "RequestEnded" &&
        event.ownerId === started.ownerId &&
        event.clientId === started.clientId &&
        event.requestId === started.requestId &&
        event.outcome === "interrupted",
    );
    const span = snapshot.spans.find(
      (candidate) => candidate.traceId === started.traceId && candidate.spanId === started.spanId,
    );
    return ended && span !== undefined ? { snapshot, started, span } : false;
  }, "renderer cancellation and correlated span");
  assert.equal(cancelled.span.name, "RpcClient.ticks");
  assert.equal(cancelled.span.traceId, cancelled.started.traceId);
  assert.equal(cancelled.span.spanId, cancelled.started.spanId);
  record("canceling an ordinary React stream is visible as an interrupted request with its trace", {
    requestId: cancelled.started.requestId,
    spanId: cancelled.span.spanId,
  });

  yield* owners.window.webContents.reload;
  const reloaded = yield* inspectSnapshot(
    (snapshot) =>
      snapshot.diagnostics.bindings.some(
        (binding) =>
          binding.runtime === "renderer" &&
          binding.bindingId !== oldBinding.bindingId &&
          binding.runtimeId !== rendererRuntimeId,
      ) &&
      snapshot.diagnostics.requests.some((request) => request.procedure === "ticks") &&
      snapshot.health.runtimes.some(
        (sample) => sample.runtime === "renderer" && sample.runtimeId !== rendererRuntimeId,
      ),
    "reloaded document binds same worker",
  );
  assert.equal(
    reloaded.diagnostics.owners.filter((owner) => owner.ownerId === owners.worker.id).length,
    1,
  );
  assert.ok(
    reloaded.diagnostics.events.some(
      ({ event }) => event._tag === "BindingClosed" && event.bindingId === oldBinding.bindingId,
    ),
  );
  assert.equal(
    reloaded.health.runtimes.some((sample) => sample.runtimeId === rendererRuntimeId),
    false,
  );
  assert.equal(
    reloaded.health.queues.some((sample) => sample.runtimeId === rendererRuntimeId),
    false,
  );
  const reloadedBinding = reloaded.diagnostics.bindings.find(
    (binding) => binding.runtime === "renderer" && binding.bindingId !== oldBinding.bindingId,
  );
  record("renderer reload replaces the document binding while retaining the same worker owner", {
    ownerId: owners.worker.id,
    oldRuntimeId: rendererRuntimeId,
    newRuntimeId: reloadedBinding?.runtimeId,
  });

  yield* owners.window.webContents.openDevTools();
  yield* until(
    Effect.sync(() => native.webContents.isDevToolsOpened()),
    "native Chromium DevTools opens",
  );
  yield* owners.window.webContents.closeDevTools;
  assert.equal(native.webContents.isDevToolsOpened(), false);
  record("the application window retains Electron's ordinary Chromium DevTools operation");

  yield* owners.worker.shutdown;
  yield* owners.worker.awaitExit;
  const stopped = yield* inspectSnapshot(
    (snapshot) =>
      snapshot.diagnostics.events.some(
        ({ event }) =>
          event._tag === "OwnerClosed" &&
          event.ownerId === owners.worker.id &&
          event.reason === "shutdown",
      ),
    "owner termination recorded",
  );
  assert.equal(
    stopped.diagnostics.owners.some((owner) => owner.ownerId === owners.worker.id),
    false,
  );
  assert.equal(
    stopped.health.runtimes.some((sample) => sample.runtimeId === owners.worker.id),
    false,
  );
  assert.equal(
    stopped.health.queues.some((sample) => sample.runtimeId === owners.worker.id),
    false,
  );
  record("worker shutdown removes its latest health and queue samples", {
    ownerId: owners.worker.id,
  });
  record("owner termination leaves a lifetime event and removes its live node");

  yield* owners.utility.shutdown;
  yield* owners.utility.awaitExit;
  const utilityStopped = yield* inspectSnapshot(
    (snapshot) =>
      snapshot.diagnostics.events.some(
        ({ event }) =>
          event._tag === "OwnerClosed" &&
          event.ownerId === owners.utility.id &&
          event.reason === "shutdown",
      )
        ? snapshot
        : false,
    "utility shutdown recorded",
  );
  assert.equal(
    utilityStopped.health.runtimes.some((sample) => sample.runtimeId === owners.utility.id),
    false,
  );
  assert.equal(
    utilityStopped.health.queues.some((sample) => sample.runtimeId === owners.utility.id),
    false,
  );
  record("utility shutdown removes its latest health and queue samples", {
    ownerId: owners.utility.id,
    processId: owners.utility.processId,
  });

  yield* Scope.close(ownersScope, Exit.void);
  const finalized = yield* tools.snapshot;
  lastSnapshot = finalized;
  assert.equal(finalized.diagnostics.owners.length, 0);
  assert.equal(finalized.diagnostics.requests.length, 0);
  yield* Scope.close(toolScope, Exit.void);
  assert.equal(NativeWindow.getAllWindows().length, 0);
  record("scoped headless collector shutdown removes observed owners without an inspector window");
});
App.run(
  [],
  run.pipe(
    Effect.onExit((exit) =>
      Effect.promise(() =>
        writeFile(".artifacts/devtools-snapshot.json", JSON.stringify(lastSnapshot, null, 2)),
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const success = exit._tag === "Success";
            console.log(
              `DEVTOOLS_VERIFICATION ${JSON.stringify({ success, checks, error: success ? undefined : Cause.pretty(exit.cause) })}`,
            );
          }),
        ),
      ),
    ),
    Effect.andThen(App.quit),
  ),
);
