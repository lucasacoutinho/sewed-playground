import assert from "node:assert/strict";
import { cpus } from "node:os";
import { BrowserWindow as NativeWindow } from "electron";
import { Cause, Effect, Stream } from "effect";
import { Binding, Decidables, Decision, Renderer } from "sewed";
import { App, BrowserWindow, Worker } from "sewed/main";
import { Direct, Echo, Relayed } from "./transport-contract.mjs";
import { measure, measureConnections } from "./transport-measure.mjs";
import { checkLimits } from "./transport-checks.mjs";

const checks = [];
let rows = [];
let heartbeatMaxDelayMs = 0;
const record = (name, evidence) => checks.push({ name, evidence });
const waitUntil = (read) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      const value = yield* read;
      if (value) return value;
      yield* Effect.sleep(5);
    }
    throw new Error("Transport measurement timed out");
  });
const run = Effect.gen(function* () {
  const direct = yield* Worker.spawn(
    Worker.entry(new URL("./transport-worker.mjs", import.meta.url), Echo),
  );
  const relay = yield* Worker.spawn(
    Worker.entry(new URL("./transport-relay.mjs", import.meta.url), Echo),
    { bindings: [Binding.to(Direct, direct)] },
  );
  const bindings = [Binding.to(Direct, direct), Binding.to(Relayed, relay)];
  let lastTick = performance.now();
  yield* Stream.tick(10).pipe(
    Stream.runForEach(() =>
      Effect.sync(() => {
        const now = performance.now();
        heartbeatMaxDelayMs = Math.max(heartbeatMaxDelayMs, now - lastTick - 10);
        lastTick = now;
      }),
    ),
    Effect.forkScoped,
  );
  rows = yield* Effect.all(
    [
      measure("main-worker", Direct()),
      measure("main-worker-dependency", Relayed()),
      measureConnections("main-worker-deferred", Direct),
    ],
    { concurrency: 1 },
  ).pipe(
    Effect.map((groups) => groups.flat()),
    Effect.provide(Binding.layer(bindings)),
  );
  record("main measurements preserve payloads and selected worker identities", {
    rows: rows.length,
  });
  const window = yield* BrowserWindow.make({ show: false, title: "Sewed transport benchmark" });
  const native = NativeWindow.getAllWindows().find(
    (candidate) => candidate.getTitle() === "Sewed transport benchmark",
  );
  assert.ok(native);
  yield* window.webContents.load(
    Renderer.entry(new URL("../.artifacts/transport-renderer/index.html", import.meta.url), {
      bindings: [Direct, Relayed],
    }),
    { bindings },
  );
  const evaluate = (source) => Effect.promise(() => native.webContents.executeJavaScript(source));
  yield* waitUntil(evaluate("window.transportBench?.ready"));
  yield* evaluate("window.transportBench.start()");
  const renderer = yield* waitUntil(evaluate("window.transportBench.result"));
  assert.equal(renderer.success, true, JSON.stringify(renderer));
  rows.push(...renderer.rows);
  record("renderer measurements traverse the real sandboxed preload and worker dependency relay", {
    rows: renderer.rows.length,
  });
  const limits = yield* Effect.all(
    [checkLimits("main-worker", Direct()), checkLimits("main-worker-dependency", Relayed())],
    { concurrency: 1 },
  ).pipe(Effect.provide(Binding.layer(bindings)));
  for (const evidence of [...limits, ...renderer.limits]) {
    assert.equal(evidence.owner.thread, rows[0].owner.thread);
    record(
      `${evidence.path} splits batches and isolates oversized values while preserving clients and owners`,
      evidence,
    );
  }
});

App.run(
  [],
  Effect.gen(function* () {
    yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
    const result = yield* Effect.exit(run);
    console.log(
      `TRANSPORT_VERIFICATION ${JSON.stringify({ success: result._tag === "Success", checks, rows, heartbeatMaxDelayMs, versions: process.versions, environment: { platform: process.platform, architecture: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length }, error: result._tag === "Failure" ? Cause.pretty(result.cause) : undefined })}`,
    );
    if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
    yield* App.quit;
  }),
);
