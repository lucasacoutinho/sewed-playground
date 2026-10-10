import assert from "node:assert/strict";
import { BrowserWindow as NativeWindow } from "electron";
import { Cause, Effect, Stream } from "effect";
import { Binding, Decidables, Decision, Diagnostics, Renderer } from "sewed";
import { App, BrowserWindow, host } from "sewed/main";
import { Protocol, Values } from "./dx-contract.mjs";

const checks = [];
const run = Effect.gen(function* () {
  const diagnostics = yield* Diagnostics.make({ capacity: 128 });
  const until = (predicate, description) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 500; attempt++) {
        const snapshot = yield* diagnostics.snapshot;
        if (predicate(snapshot)) return snapshot;
        yield* Effect.sleep(10);
      }
      throw new Error(`Timed out: ${description}`);
    });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const owner = yield* host(Protocol, (implement) =>
        implement({
          values: ({ key }) => Stream.concat(Stream.make({ key, subscription: 1 }), Stream.never),
        }),
      );
      const window = yield* BrowserWindow.make({ title: "Sewed diagnostics", show: false });
      const native = NativeWindow.getAllWindows().find(
        (window) => window.getTitle() === "Sewed diagnostics",
      );
      assert.ok(native);
      yield* window.webContents.load(
        Renderer.entry(new URL("../.artifacts/diagnostics-renderer/index.html", import.meta.url), {
          bindings: [Values],
        }),
        {
          bindings: [Binding.to(Values, owner)],
        },
      );
      const opened = yield* until(
        (snapshot) =>
          snapshot.requests.some(
            (request) => request.ownerId === owner.id && request.procedure === "values",
          ),
        "renderer stream request",
      );
      const binding = opened.bindings.find(
        (binding) => binding.runtime === "renderer" && binding.slot === Values.key,
      );
      assert.ok(binding);
      assert.equal(binding.ownerId, owner.id);
      const trace = yield* Effect.promise(() =>
        native.webContents.executeJavaScript("window.dx.trace()"),
      );
      assert.equal(trace["sewed.owner.id"], owner.id);
      assert.equal(trace["sewed.runtime"], "renderer");
      assert.equal(trace["sewed.binding"], Values.key);
      checks.push({
        name: "native renderer handshake records its exact binding target",
        evidence: binding,
      });

      yield* window.webContents.reload;
      const reloaded = yield* until(
        (snapshot) =>
          snapshot.bindings.some(
            (next) => next.slot === Values.key && next.bindingId !== binding.bindingId,
          ) && snapshot.requests.some((request) => request.ownerId === owner.id),
        "replacement renderer binding",
      );
      const closure = reloaded.events.find(
        ({ event }) => event._tag === "BindingClosed" && event.bindingId === binding.bindingId,
      );
      assert.ok(closure);
      assert.ok(["navigation", "replaced", "renderer-disconnected"].includes(closure.event.reason));
      checks.push({
        name: "reload closes the old binding environment and reports the reason",
        evidence: closure.event,
      });

      const rendererProcessId = native.webContents.getOSProcessId();
      assert.ok(rendererProcessId > 0, "renderer process must have a live OS PID");
      assert.notEqual(rendererProcessId, process.pid, "refusing to signal the main process");
      assert.equal(process.kill(rendererProcessId, 0), true, "renderer process must be live");
      yield* Effect.sync(() => process.kill(rendererProcessId, "SIGKILL"));
      const crashed = yield* until(
        (snapshot) =>
          snapshot.bindings.every((binding) => binding.runtime !== "renderer") &&
          snapshot.requests.length === 0,
        "renderer loss cleanup",
      );
      assert.ok(
        crashed.events.some(
          ({ event }) => event._tag === "BindingClosed" && event.reason === "renderer-gone",
        ),
      );
      assert.ok(crashed.owners.some((active) => active.ownerId === owner.id));
      checks.push({ name: "renderer loss removes active calls while the main owner survives" });
    }),
  ).pipe(Effect.provide(diagnostics.layer));
  const closed = yield* diagnostics.snapshot;
  assert.equal(closed.owners.length, 0);
  assert.equal(closed.bindings.length, 0);
  assert.equal(closed.requests.length, 0);
  assert.equal(closed.complete, true);
  checks.push({ name: "native scope closure leaves no diagnostic owners, bindings or calls" });
});

App.run(
  [],
  Effect.gen(function* () {
    yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
    const exit = yield* Effect.exit(run);
    console.log(
      `DIAGNOSTICS_VERIFICATION ${JSON.stringify({ success: exit._tag === "Success", checks, error: exit._tag === "Failure" ? Cause.pretty(exit.cause) : undefined })}`,
    );
    if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause);
    yield* App.quit;
  }),
);
