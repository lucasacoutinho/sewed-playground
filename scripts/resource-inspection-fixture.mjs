import assert from "node:assert/strict";
import { BrowserWindow as NativeWindow } from "electron";
import { Cause, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { Binary, Binding, Decidables, Decision, Remote } from "sewed";
import { App, Worker } from "sewed/main";
import * as DevTools from "@sewed/devtools";
import { ByteResource, Resources } from "../dist/shared/resources.js";

const checks = [];
const record = (name, evidence) => checks.push({ name, evidence });
const until = (read, predicate, description) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const value = yield* read;
      if (predicate(value)) return value;
      yield* Effect.sleep(20);
    }
    throw new Error(`Timed out: ${description}`);
  });
const run = Effect.gen(function* () {
  yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
  const tools = yield* DevTools.make({ capacity: 1024 });
  assert.equal(NativeWindow.getAllWindows().length, 0);
  const snapshot = tools.snapshot;
  record("resource diagnostics run without a native window", {});
  const events = (value, tag) =>
    value.diagnostics.events.map((record) => record.event).filter((event) => event._tag === tag);
  const ownerScope = yield* Scope.fork(yield* Effect.scope);
  const worker = yield* Worker.spawn(
    Worker.entry(new URL("../dist/worker/resources.js", import.meta.url), ByteResource.protocol),
  ).pipe(Scope.provide(ownerScope), Effect.provide(tools.layer));
  const binding = Binding.layer([Binding.to(Resources, worker)]);
  yield* Effect.gen(function* () {
    const leaseScope = yield* Scope.fork(yield* Effect.scope);
    const resource = yield* Remote.acquire(ByteResource, Resources, { seed: 73 }).pipe(
      Scope.provide(leaseScope),
    );
    const placement = yield* resource.client.inspect();
    assert.ok(placement.thread > 0);
    const ready = yield* until(
      snapshot,
      (value) =>
        value.diagnostics.resources.some(
          (resource) => resource.ownerId === worker.id && resource.state === "ready",
        ),
      "authoritative worker resource record",
    );
    const resourceId = ready.diagnostics.resources.find(
      (resource) => resource.ownerId === worker.id,
    ).resourceId;
    record(
      "headless snapshot shows the worker-owned resource acquired through the public Remote API",
      {
        resourceId,
        ownerId: worker.id,
        thread: placement.thread,
      },
    );

    const chunks = 128;
    const bytes = yield* resource.client.read({ chunks }).pipe(
      Stream.runFold(
        () => 0,
        (total, value) => total + value.byteLength,
      ),
    );
    assert.equal(bytes, chunks * Binary.chunkBytes);
    const completed = yield* until(
      snapshot,
      (value) => {
        const requests = events(value, "RequestStarted").filter(
          (event) => event.procedure === "read" && event.ownerId === worker.id,
        );
        return requests.some((request) =>
          events(value, "TransferProgress").some(
            (progress) =>
              progress.requestId === request.requestId &&
              progress.clientId === request.clientId &&
              progress.ownerId === worker.id &&
              progress.terminal,
          ),
        );
      },
      "completed binary stream counters",
    );
    const request = events(completed, "RequestStarted").find(
      (event) => event.procedure === "read" && event.ownerId === worker.id,
    );
    const progress = events(completed, "TransferProgress").filter(
      (event) =>
        event.requestId === request.requestId &&
        event.clientId === request.clientId &&
        event.ownerId === worker.id,
    );
    const terminal = progress.at(-1);
    assert.equal(terminal.terminal, true);
    assert.ok(terminal.frames >= chunks);
    assert.ok(terminal.wireBytes > bytes, "wire totals include binary framing");
    assert.ok(progress.length < chunks / 2, "progress is sampled rather than retained per frame");
    assert.ok(
      events(completed, "RequestEnded").some(
        (event) =>
          event.requestId === request.requestId &&
          event.ownerId === worker.id &&
          event.outcome === "success",
      ),
    );
    record(
      "headless snapshot samples and joins real worker binary traffic to its completed request",
      {
        payloadBytes: bytes,
        wireBytes: terminal.wireBytes,
        frames: terminal.frames,
        samples: progress.length,
      },
    );

    const cancelled = yield* resource.client
      .read({ chunks: 1024 })
      .pipe(Stream.runDrain, Effect.forkScoped);
    const activeSnapshot = yield* until(
      snapshot,
      (value) =>
        events(value, "RequestStarted").some(
          (started) =>
            started.ownerId === worker.id &&
            started.procedure === "read" &&
            (started.clientId !== request.clientId || started.requestId !== request.requestId) &&
            value.diagnostics.transfers.some(
              (transfer) =>
                transfer.ownerId === started.ownerId &&
                transfer.clientId === started.clientId &&
                transfer.requestId === started.requestId &&
                transfer.wireBytes > 0,
            ),
        ),
      "live transfer progress",
    );
    const activeRead = events(activeSnapshot, "RequestStarted").findLast(
      (started) =>
        started.ownerId === worker.id &&
        started.procedure === "read" &&
        (started.clientId !== request.clientId || started.requestId !== request.requestId),
    );
    assert.ok(activeRead);
    yield* Fiber.interrupt(cancelled);
    yield* until(
      snapshot,
      (value) =>
        events(value, "RequestEnded").some(
          (event) =>
            event.ownerId === worker.id &&
            event.clientId === activeRead.clientId &&
            event.requestId === activeRead.requestId &&
            event.outcome === "interrupted",
        ),
      "cancelled stream terminal record",
    );
    yield* resource.release;
    const released = yield* until(
      snapshot,
      (value) => events(value, "ResourceClosed").some((event) => event.resourceId === resourceId),
      "resource cleanup observed",
    );
    const closed = events(released, "ResourceClosed").find(
      (event) => event.resourceId === resourceId,
    );
    assert.equal(closed.outcome, "success");
    assert.equal(
      released.diagnostics.resources.some((resource) => resource.resourceId === resourceId),
      false,
    );
    const serialized = JSON.stringify(released.diagnostics);
    assert.equal(serialized.includes("sewed-remote-lease"), false);
    assert.equal(serialized.includes("Uint8Array"), false);
    assert.equal(serialized.includes("payload"), false);
    record(
      "stream cancellation and acknowledged resource cleanup leave no live inspection records",
      { outcome: closed.outcome, reason: closed.reason },
    );
    yield* Scope.close(leaseScope, Exit.void);
  }).pipe(Effect.provide(binding), Effect.provide(tools.layer));
  yield* Scope.close(ownerScope, Exit.void);
  const closedOwner = yield* until(
    snapshot,
    (value) => !value.diagnostics.owners.some((owner) => owner.ownerId === worker.id),
    "closed worker owner",
  );
  assert.equal(
    closedOwner.diagnostics.resources.some((resource) => resource.ownerId === worker.id),
    false,
  );
  assert.equal(
    closedOwner.diagnostics.transfers.some((transfer) => transfer.ownerId === worker.id),
    false,
  );
  record("closing the owner clears its active resource and transfer records", {
    ownerId: worker.id,
  });
  console.log(`RESOURCE_INSPECTION_VERIFICATION ${JSON.stringify({ success: true, checks })}`);
  yield* App.quit;
});

App.run(
  [],
  run.pipe(
    Effect.catchCause((cause) => {
      console.log(
        `RESOURCE_INSPECTION_VERIFICATION ${JSON.stringify({ success: false, checks, error: Cause.pretty(cause) })}`,
      );
      return Effect.failCause(cause);
    }),
  ),
);
