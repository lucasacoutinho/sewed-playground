import assert from "node:assert/strict";
import { BrowserWindow as NativeWindow } from "electron";
import { Cause, Effect, Schedule } from "effect";
import { RpcClientError } from "effect/rpc/RpcClientError";
import { Binding, Decidables, Decision, Diagnostics, Remote, Renderer, SewedError } from "sewed";
import { App, BrowserWindow, Utility, Worker, host } from "sewed/main";
import {
  Definition,
  MainRemote,
  RelayRemote,
  UtilityRemote,
  WorkerRemote,
  slots,
} from "./remote-contract.mjs";
import { resourceHandlers } from "./remote-handlers.mjs";

const checks = [];
const record = (name, evidence = {}) => {
  checks.push({ name, evidence: structuredClone(evidence) });
  console.log(`PASS ${name}`);
};

const errorText = (cause) => {
  try {
    return Cause.pretty(cause);
  } catch {
    return String(cause);
  }
};

const closedFailure = (value, label) => {
  if (value instanceof RpcClientError) {
    return {
      tag: value._tag,
      reason: value.reason?._tag,
      message: value.message,
    };
  }
  // A stale client answers `Closed` when it already knows its owner is gone, and `Unknown` when
  // the request left before that news arrived, which is what macOS and Windows tend to produce
  // for a utility process. Both are the documented connection-loss answers.
  if (value instanceof SewedError && (value.code === "Closed" || value.code === "Unknown")) {
    return {
      tag: value._tag,
      reason: value.code,
      message: value.message,
    };
  }
  assert.fail(`${label} returned an unexpected error: ${errorText(value)}`);
};

const evaluate = (native, source) =>
  Effect.promise(() => native.webContents.executeJavaScript(source));

const waitRenderer = (native, source, predicate, description, timeout = 15_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = yield* evaluate(native, source);
      if (predicate(last)) return last;
      yield* Effect.sleep(10);
    }
    throw new Error(`Timed out: ${description}; last=${JSON.stringify(last)}`);
  });

const inspectOwner = (slot, owner, seed) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* Remote.acquire(Definition, slot, { seed });
      const value = yield* handle.client.inspect();
      yield* handle.release;
      return value;
    }).pipe(Effect.provide(Binding.layer([Binding.to(slot, owner)]))),
  );

const mainCounters = {
  active: 0,
  created: 0,
  released: 0,
  streamsStarted: 0,
  streamsFinalized: 0,
};

const fixture = (diagnostics) =>
  Effect.gen(function* () {
    const mainOwner = yield* host(
      Definition.protocol,
      resourceHandlers({
        counters: mainCounters,
        placement: Effect.succeed({ runtime: "main", threadId: 0, processId: process.pid }),
      }),
    );
    const worker = yield* Worker.spawn(
      Worker.entry(new URL("./remote-worker.mjs", import.meta.url), Definition.protocol),
    );
    const utility = yield* Utility.spawn(
      Utility.entry(new URL("./remote-utility.mjs", import.meta.url), Definition.protocol),
    );
    const relay = yield* Worker.spawn(
      Worker.entry(new URL("./remote-relay.mjs", import.meta.url), Definition.protocol),
      { bindings: [Binding.to(UtilityRemote, utility)] },
    );
    const ownerIds = {
      worker: worker.id,
      utility: utility.id,
      relay: relay.id,
    };

    const windowHandle = yield* BrowserWindow.make({
      title: "Sewed Remote verification",
      width: 760,
      height: 460,
    });
    yield* windowHandle.webContents.load(
      Renderer.entry(new URL("../.artifacts/remote-renderer/index.html", import.meta.url), {
        bindings: slots,
      }),
      {
        bindings: [
          Binding.to(MainRemote, mainOwner),
          Binding.to(WorkerRemote, worker),
          Binding.to(UtilityRemote, utility),
          Binding.to(RelayRemote, relay),
        ],
      },
    );
    const native = NativeWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes("/remote-renderer/"),
    );
    assert.ok(native, "Remote verification window was not created");

    yield* waitRenderer(native, "window.remoteFixture?.ready", Boolean, "renderer startup");
    yield* evaluate(native, "window.remoteFixture.start()");
    const result = yield* waitRenderer(
      native,
      "window.remoteFixture?.result",
      (value) => value !== undefined && value !== null,
      "renderer remote route result",
    );
    assert.equal(result.success, true, result.error);
    assert.equal(result.rows.length, slots.length);
    for (const row of result.rows) {
      const placement = row.first.placement;
      if (row.label === "main") {
        assert.equal(placement.runtime, "main");
        assert.equal(placement.threadId, 0);
        assert.equal(placement.processId, process.pid);
      } else if (row.label === "worker") {
        assert.equal(placement.runtime, "worker");
        assert.ok(placement.threadId > 0);
        assert.equal(placement.processId, process.pid);
      } else if (row.label === "utility") {
        assert.equal(placement.runtime, "utility");
        assert.equal(placement.threadId, 0);
        assert.notEqual(placement.processId, process.pid);
      } else {
        assert.equal(row.label, "relay");
        assert.equal(placement.runtime, "relay");
        assert.ok(placement.threadId > 0);
        assert.equal(placement.processId, process.pid);
        assert.equal(row.first.downstreamRuntime, "utility");
      }
      assert.ok(row.first.created >= 2);
      assert.ok(row.released.released >= row.first.released + 1);
      record(`${row.label}: isolated resource state, progress, stale client, and awaited release`, {
        first: row.first,
        second: row.second,
        released: row.released,
        releaseElapsedMs: row.releaseElapsedMs,
        progress: row.progress,
      });
    }
    assert.ok(
      result.rows.find((row) => row.label === "relay").first.downstreamRuntime === "utility",
    );
    record("worker relay acquired a downstream utility resource through the same Remote protocol", {
      relay: result.rows.find((row) => row.label === "relay").first,
    });
    assert.ok(result.stalled.elapsedMs < 2_000);
    record("same-client stalled stream did not block explicit Remote release", result.stalled);
    assert.equal(result.saturation.outstanding, 62);
    assert.equal(result.saturation.activeConsumers, 32);
    assert.equal(result.saturation.limit, "Limit");
    record(
      "saturated method calls leave release capacity and the worker remains usable",
      result.saturation,
    );

    yield* waitRenderer(
      native,
      "window.remoteFixture?.reloadReady",
      Boolean,
      "renderer reload lease setup",
    );
    const beforeReload = yield* inspectOwner(MainRemote, mainOwner, "main:before-reload");
    const diagnosticsBeforeReload = yield* diagnostics.snapshot;
    yield* Effect.sync(() => native.webContents.reload());
    yield* waitRenderer(
      native,
      "window.remoteFixture?.reloadReady === false",
      Boolean,
      "renderer reload completion",
    );
    yield* evaluate(native, "window.remoteFixture.afterReload()");
    const afterReloadRenderer = yield* waitRenderer(
      native,
      "window.remoteFixture?.afterReloadResult",
      (value) => value !== undefined && value !== null,
      "renderer post-reload owners",
    );
    assert.equal(afterReloadRenderer.success, true, afterReloadRenderer.error);
    const afterReload = yield* inspectOwner(MainRemote, mainOwner, "main:after-reload");
    assert.ok(
      afterReload.released > beforeReload.released,
      "renderer scope close did not release its leaked main resource",
    );
    assert.equal(afterReloadRenderer.rows.length, slots.length);
    const reloadSequence = diagnosticsBeforeReload.events.at(-1)?.sequence ?? 0;
    const rendererBindingIds = diagnosticsBeforeReload.bindings
      .filter((binding) => binding.runtime === "renderer")
      .map((binding) => binding.bindingId);
    assert.equal(rendererBindingIds.length, slots.length);
    const reloadRecords = (snapshot) =>
      snapshot.events.filter(({ sequence }) => sequence > reloadSequence);
    const closedRendererBindings = (snapshot) =>
      reloadRecords(snapshot).filter(
        ({ event }) =>
          event._tag === "BindingClosed" && rendererBindingIds.includes(event.bindingId),
      );
    const newRequestRecords = (snapshot) =>
      reloadRecords(snapshot).filter(({ event }) => event._tag === "RequestEnded");
    const diagnosticsAfterReload = yield* diagnostics.snapshot.pipe(
      Effect.repeat({
        until: (snapshot) =>
          newRequestRecords(snapshot).length > 0 &&
          rendererBindingIds.every((bindingId) =>
            closedRendererBindings(snapshot).some(({ event }) => event.bindingId === bindingId),
          ),
        schedule: Schedule.spaced(10),
      }),
      Effect.timeout("3 seconds"),
    );
    assert.ok(
      diagnosticsAfterReload.events[0]?.sequence <= reloadSequence + 1,
      "diagnostics discarded part of the renderer reload interval",
    );
    const requestCount = (snapshot) =>
      snapshot.events.filter(({ event }) => event._tag === "RequestEnded").length;
    const rendererBindingClosed = closedRendererBindings(diagnosticsAfterReload).length;
    assert.ok(newRequestRecords(diagnosticsAfterReload).length > 0);
    assert.equal(rendererBindingClosed, rendererBindingIds.length);
    record("renderer scope close released an active lease and all owners stayed usable", {
      beforeReload,
      afterReload,
      rendererRows: afterReloadRenderer.rows,
      requestRecordsBefore: requestCount(diagnosticsBeforeReload),
      requestRecordsAfter: requestCount(diagnosticsAfterReload),
      reloadSequence,
      newRequestRecords: newRequestRecords(diagnosticsAfterReload).length,
      rendererBindingIds,
      rendererBindingClosed,
    });

    const diagnosticsBeforeTermination = yield* diagnostics.snapshot;
    const liveOwnerIds = new Set(diagnosticsBeforeTermination.owners.map((owner) => owner.ownerId));
    for (const ownerId of Object.values(ownerIds))
      assert.ok(liveOwnerIds.has(ownerId), `owner ${ownerId} is missing from the live snapshot`);
    const stale = yield* Effect.gen(function* () {
      const staleWorker = yield* Remote.acquire(Definition, WorkerRemote, { seed: "stale-worker" });
      const staleUtility = yield* Remote.acquire(Definition, UtilityRemote, {
        seed: "stale-utility",
      });
      assert.equal(yield* staleWorker.client.read(), 0, "worker live handle was not usable");
      assert.equal(yield* staleUtility.client.read(), 0, "utility live handle was not usable");

      yield* relay.terminate;
      const relayExit = yield* relay.awaitExit;
      yield* worker.terminate;
      const workerExit = yield* worker.awaitExit;
      yield* utility.terminate;
      const utilityExit = yield* utility.awaitExit;
      const workerFailure = yield* staleWorker.client.read().pipe(Effect.flip);
      const utilityFailure = yield* staleUtility.client.read().pipe(Effect.flip);
      const workerReleaseFailure = yield* staleWorker.release.pipe(Effect.flip);
      const utilityReleaseFailure = yield* staleUtility.release.pipe(Effect.flip);
      return {
        workerFailure: closedFailure(workerFailure, "worker stale read"),
        utilityFailure: closedFailure(utilityFailure, "utility stale read"),
        workerReleaseFailure: closedFailure(workerReleaseFailure, "worker stale release"),
        utilityReleaseFailure: closedFailure(utilityReleaseFailure, "utility stale release"),
        relayExit,
        workerExit,
        utilityExit,
      };
    }).pipe(
      Effect.provide(
        Binding.layer([Binding.to(WorkerRemote, worker), Binding.to(UtilityRemote, utility)]),
      ),
    );
    const diagnosticsAfterTermination = yield* diagnostics.snapshot;
    const baselineSequence =
      diagnosticsBeforeTermination.events.at(-1)?.sequence ?? Number.MIN_SAFE_INTEGER;
    assert.ok(
      diagnosticsAfterTermination.events[0]?.sequence <= baselineSequence + 1,
      "diagnostics discarded part of the owner termination interval",
    );
    const replacementStarts = diagnosticsAfterTermination.events.filter(
      ({ sequence, event }) => sequence > baselineSequence && event._tag === "OwnerStarted",
    );
    assert.equal(
      replacementStarts.length,
      0,
      "owner termination started an unexpected replacement",
    );
    record("terminated worker and utility owners reject stale Remote clients without replacement", {
      ownerIds,
      workerFailure: stale.workerFailure,
      utilityFailure: stale.utilityFailure,
      workerReleaseFailure: stale.workerReleaseFailure,
      utilityReleaseFailure: stale.utilityReleaseFailure,
      relayExit: stale.relayExit,
      workerExit: stale.workerExit,
      utilityExit: stale.utilityExit,
      workerProcessId: worker.id,
      utilityProcessId: utility.processId,
      replacementStarts,
    });
  });

const run = Effect.gen(function* () {
  const diagnostics = yield* Diagnostics.make({ capacity: 1024, tracing: true });
  yield* fixture(diagnostics).pipe(Effect.provide(diagnostics.layer));
});

const program = run.pipe(
  Effect.onExit((exit) =>
    Effect.sync(() => {
      const success = exit._tag === "Success";
      console.log(
        `REMOTE_VERIFICATION ${JSON.stringify({
          success,
          checks,
          error: success ? undefined : errorText(exit.cause),
        })}`,
      );
    }),
  ),
  Effect.andThen(App.quit),
);

App.run(
  [],
  Effect.andThen(App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay")), () => program),
);
