import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { app, BrowserWindow as NativeBrowserWindow, MessageChannelMain } from "electron";
import { Cause, Effect, Fiber, Stream } from "effect";
import { Binding, Decidables, Decision, Diagnostics, Renderer } from "sewed";
import { App, BrowserWindow, Utility, Worker, host } from "sewed/main";
import {
  ConsumerBinding,
  MainBinding,
  NegativeDelta,
  Protocol,
  UtilityBinding,
  WorkerBinding,
} from "./utility-contract.mjs";

const marker = "UTILITY_PROCESS_VERIFICATION";
const argumentValue = (prefix) =>
  process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
const root = path.resolve(
  process.env.SEWED_UTILITY_ROOT ??
    argumentValue("--sewed-utility-root=") ??
    path.join(process.cwd(), ".artifacts", "utility-process-native"),
);
const finalizerMarker = path.join(root, "utility-finalizers.jsonl");
const streamMarker = path.join(root, "utility-stream-finalizers.jsonl");
const unaryMarker = path.join(root, "utility-unary-finalizers.jsonl");
const reportPath = path.join(root, "utility-process-report.json");

mkdirSync(root, { recursive: true });
process.env.SEWED_UTILITY_FINALIZER_MARKER = finalizerMarker;
process.env.SEWED_UTILITY_STREAM_MARKER = streamMarker;
process.env.SEWED_UTILITY_UNARY_MARKER = unaryMarker;

const state = {
  checks: [],
  success: false,
  error: undefined,
  reportEmitted: false,
};

const writeJsonSync = (file, value) => {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

process.on("exit", (exitCode) => {
  if (state.reportEmitted) return;
  state.reportEmitted = true;
  const success = state.success && state.error === undefined && exitCode === 0;
  const report = {
    success,
    mode: "utility-processes",
    checks: state.checks,
    error:
      state.error ?? (success ? undefined : `Utility process acceptance failed (exit=${exitCode})`),
    evidence: {
      pid: process.pid,
      processType: process.type ?? "browser",
      root,
      finalizerMarker,
      streamMarker,
      unaryMarker,
      nativeWindows: NativeBrowserWindow.getAllWindows().length,
    },
  };
  try {
    writeJsonSync(reportPath, report);
  } catch {
    // The native harness still receives the marker below if the evidence path vanished.
  }
  console.log(`${marker} ${JSON.stringify(report)}`);
});

const record = (name, evidence = {}) => {
  state.checks.push({ name, evidence: structuredClone(evidence) });
  console.log(`PASS ${name}`);
};

const waitUntil = (read, description, timeout = 10_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const value = read();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      yield* Effect.sleep(10);
    }
    throw new Error(
      `Timed out: ${description}${lastError ? ` (${lastError.message || lastError})` : ""}`,
    );
  });

const readLines = (file) => {
  try {
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

const waitForLine = (file, predicate, description, timeout = 10_000) =>
  waitUntil(() => readLines(file).find(predicate), description, timeout);

const waitDiagnostics = (collector, predicate, description, timeout = 10_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const snapshot = yield* collector.snapshot;
      const match = predicate(snapshot);
      if (match) return match;
      yield* Effect.sleep(10);
    }
    throw new Error(`Timed out: ${description}`);
  });

const metricPid = (metric) => metric.pid ?? metric.processId;
const utilityMetrics = () =>
  app.getAppMetrics().filter((metric) => metric.name === "Sewed Utility");
const utilityPids = () =>
  utilityMetrics()
    .map(metricPid)
    .filter((pid) => typeof pid === "number");

const waitForUtilityPid = (pid, description) =>
  waitUntil(() => utilityMetrics().find((metric) => metricPid(metric) === pid), description);

const waitForUtilityGone = (pid, description) =>
  waitUntil(() => !utilityPids().includes(pid), description);

const waitForNoExtraUtilities = (knownPids, description) =>
  waitUntil(() => utilityPids().every((pid) => knownPids.includes(pid)), description);

const errorFromExit = (exit) => {
  assert.equal(exit._tag, "Failure", Cause.pretty(exit.cause));
  const option = Cause.findErrorOption(exit.cause);
  assert.equal(option._tag, "Some", Cause.pretty(exit.cause));
  return option.value;
};

const causeText = (cause) => {
  try {
    return Cause.pretty(cause);
  } catch {
    return String(cause);
  }
};

const identity = (role, counter = 0, type = process.type ?? "browser") => ({
  pid: process.pid,
  type: String(type),
  role,
  counter,
});

const entry = (file, query = "") =>
  Utility.entry(new URL(`./${file}${query}`, import.meta.url), Protocol);

const baseEntry = entry("utility-entry.mjs", "?role=base");
const dependentEntry = entry("utility-entry.mjs", "?role=dependent");
const blockedEntry = entry("utility-blocked.mjs");
const pendingEntry = entry("utility-startup-pending.mjs");
const invalidEntry = entry("utility-startup-failure.mjs");
const finalizerFailureEntry = entry("utility-finalizer-failure.mjs");

const withClient = (owner, operation) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* ConsumerBinding();
      return yield* operation(client);
    }).pipe(Effect.provide(Binding.layer([Binding.to(ConsumerBinding, owner)]))),
  );

const withClientScope = (owner, operation) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* ConsumerBinding();
      return yield* operation(client);
    }).pipe(Effect.provide(Binding.layer([Binding.to(ConsumerBinding, owner)]))),
  );

const inspect = (owner) => withClient(owner, (client) => client.inspect());

const nativeWindowForTitle = (title) => {
  const native = NativeBrowserWindow.getAllWindows().find(
    (candidate) => candidate.getTitle() === title,
  );
  assert.ok(native, `Native test window ${title} was not created`);
  return native;
};

const evaluate = (native, source) =>
  Effect.promise(() => native.webContents.executeJavaScript(source));

const waitRenderer = (native, description) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const value = yield* evaluate(
        native,
        "window.utilityProcessFixture || window.utilityProcessFixtureError",
      );
      if (value !== undefined && value !== null) return value;
      yield* Effect.sleep(10);
    }
    throw new Error(`Timed out: ${description}`);
  });

const runStartupFailure = (definition, bindings, label, knownPids) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(Utility.spawn(definition, { bindings }));
    const error = errorFromExit(exit);
    assert.equal(error.code, "Startup", `${label}: ${error.message}`);
    yield* waitForNoExtraUtilities(knownPids, `${label} leaves no utility process`);
    record(label, { code: error.code, message: error.message, utilityPids: utilityPids() });
  });

const run = Effect.gen(function* () {
  const diagnostics = yield* Diagnostics.make({ capacity: 512 });
  yield* Effect.scoped(
    Effect.gen(function* () {
      let mainCounter = 0;
      const mainOwner = yield* host(
        Protocol,
        Protocol.toLayer({
          inspect: () => Effect.sync(() => identity("main", mainCounter)),
          increment: ({ delta }) =>
            delta < 0
              ? Effect.fail(new NegativeDelta({ delta }))
              : Effect.sync(() => {
                  mainCounter += delta;
                  return identity("main", mainCounter);
                }),
          route: () => Effect.fail(new Error("main route is fixture-only")),
          stream: () => Stream.fromIterable([identity("main", mainCounter)]),
          wait: ({ milliseconds }) =>
            Effect.sleep(Math.max(0, milliseconds)).pipe(Effect.as(identity("main", mainCounter))),
          crash: () => Effect.fail(new Error("main cannot crash the fixture")),
        }),
      );

      const initialPids = utilityPids();
      yield* runStartupFailure(
        invalidEntry,
        [],
        "invalid default export fails startup",
        initialPids,
      );
      yield* runStartupFailure(
        dependentEntry,
        [],
        "missing declared utility dependencies fail startup",
        initialPids,
      );
      yield* runStartupFailure(
        blockedEntry,
        [Binding.to(MainBinding, mainOwner)],
        "extra utility dependencies fail startup",
        initialPids,
      );

      const pendingExit = yield* Effect.exit(Utility.spawn(pendingEntry, { bindings: [] }));
      const pendingError = errorFromExit(pendingExit);
      assert.equal(pendingError.code, "Startup", pendingError.message);
      yield* waitForNoExtraUtilities(initialPids, "timed out utility startup leaves no child");
      record("utility startup timeout leaves no native utility child", {
        code: pendingError.code,
        message: pendingError.message,
        utilityPids: utilityPids(),
      });

      const interruptedKnownPids = utilityPids();
      const pendingFiber = yield* Utility.spawn(pendingEntry, { bindings: [] }).pipe(
        Effect.forkScoped,
      );
      yield* Effect.sleep(120);
      yield* Fiber.interrupt(pendingFiber);
      const interruptedExit = yield* Fiber.await(pendingFiber);
      assert.equal(interruptedExit._tag, "Failure", "interrupted startup must fail");
      yield* waitForNoExtraUtilities(
        interruptedKnownPids,
        "interrupted utility startup leaves no child",
      );
      record("interrupted utility startup leaves no native utility child", {
        exit: interruptedExit._tag,
        utilityPids: utilityPids(),
      });

      let finalizerFailurePid;
      let finalizerFailureOwnerId;
      let primaryDependentOwnerId;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* Utility.spawn(finalizerFailureEntry, { bindings: [] });
          finalizerFailurePid = owner.processId;
          finalizerFailureOwnerId = owner.id;
          yield* owner.shutdown;
          const exitCode = yield* owner.awaitExit;
          assert.equal(exitCode, 1, "a utility finalizer defect must produce exit code 1");
          const finalized = yield* waitForLine(
            finalizerMarker,
            (line) => line.pid === finalizerFailurePid && line.phase === "finalized",
            "finalizer defect marker",
          );
          yield* waitForUtilityGone(finalizerFailurePid, "finalizer defect utility exits");
          const closed = yield* waitDiagnostics(
            diagnostics,
            (snapshot) =>
              snapshot.events.find(
                ({ event }) =>
                  event._tag === "OwnerClosed" && event.ownerId === finalizerFailureOwnerId,
              ),
            "finalizer defect OwnerClosed diagnostic",
          );
          record("a utility finalizer defect preserves its marker and exits with code 1", {
            processId: finalizerFailurePid,
            ownerId: finalizerFailureOwnerId,
            exitCode,
            finalized,
            closed,
          });
        }),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const workerService = yield* Worker.spawn(
            Worker.entry(
              new URL("./utility-consumer-worker.mjs?role=service", import.meta.url),
              Protocol,
            ),
          );
          const baseA = yield* Utility.spawn(baseEntry, { bindings: [] });
          const baseB = yield* Utility.spawn(baseEntry, { bindings: [] });
          const channel = new MessageChannelMain();
          const prototype = Object.getPrototypeOf(channel.port1);
          const start = prototype.start;
          channel.port1.close();
          channel.port2.close();
          const startFailure = new Error("fixture port start failure");
          let failedPort;
          const failedSubscription = yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              prototype.start = function () {
                prototype.start = start;
                failedPort = this;
                throw startFailure;
              };
            }),
            () => Effect.exit(withClient(baseA, (client) => client.inspect())),
            () =>
              Effect.sync(() => {
                prototype.start = start;
              }),
          );
          assert.equal(failedSubscription._tag, "Failure");
          assert.ok(failedPort, "the native main port reached start");
          assert.equal(failedPort.listenerCount("message"), 0);
          assert.equal(failedPort.listenerCount("close"), 0);
          const afterFailedSubscription = yield* inspect(baseA);
          assert.equal(afterFailedSubscription.pid, baseA.processId);
          record(
            "a refused native port subscription removes its listeners and preserves the utility owner",
            {
              processId: baseA.processId,
              messageListeners: failedPort.listenerCount("message"),
              closeListeners: failedPort.listenerCount("close"),
            },
          );
          const baseAFirst = yield* inspect(baseA);
          const baseBFirst = yield* inspect(baseB);
          assert.equal(baseAFirst.type, "utility");
          assert.equal(baseBFirst.type, "utility");
          assert.notEqual(baseA.processId, baseB.processId);
          assert.notEqual(baseA.id, baseB.id);
          yield* waitForUtilityPid(baseA.processId, "first utility appears in app metrics");
          yield* waitForUtilityPid(baseB.processId, "second utility appears in app metrics");
          const baseAAfterIncrement = yield* withClient(baseA, (client) =>
            client.increment({ delta: 2 }),
          );
          const baseBAfterIncrement = yield* withClient(baseB, (client) =>
            client.increment({ delta: 7 }),
          );
          assert.equal((yield* inspect(baseA)).counter, 2);
          assert.equal((yield* inspect(baseB)).counter, 7);
          record("two utility owners have distinct native PIDs, owner IDs, and isolated state", {
            first: { id: baseA.id, processId: baseA.processId, identity: baseAAfterIncrement },
            second: { id: baseB.id, processId: baseB.processId, identity: baseBAfterIncrement },
            metrics: utilityMetrics().map((metric) => ({
              name: metric.name,
              pid: metricPid(metric),
            })),
          });

          let invalidPayloadError;
          let negativeDeltaError;
          let recoveredAfterInvalid;
          yield* withClientScope(baseA, (client) =>
            Effect.gen(function* () {
              const invalidPayloadExit = yield* Effect.exit(client.increment({ delta: "invalid" }));
              assert.equal(invalidPayloadExit._tag, "Failure", "invalid payload must fail");
              invalidPayloadError = causeText(invalidPayloadExit.cause);
              negativeDeltaError = errorFromExit(
                yield* Effect.exit(client.increment({ delta: -1 })),
              );
              recoveredAfterInvalid = yield* client.increment({ delta: 1 });
            }),
          );
          assert.ok(invalidPayloadError, "invalid payload must fail schema validation");
          assert.equal(negativeDeltaError._tag, "NegativeDelta");
          assert.equal(negativeDeltaError.delta, -1);
          assert.equal(recoveredAfterInvalid.counter, 3);
          record("schema failures and typed RPC errors roundtrip without poisoning a later call", {
            invalidPayload: {
              cause: invalidPayloadError,
            },
            typedError: {
              tag: negativeDeltaError._tag,
              delta: negativeDeltaError.delta,
            },
            recovered: recoveredAfterInvalid,
          });

          const dependent = yield* Utility.spawn(dependentEntry, {
            bindings: [
              Binding.to(MainBinding, mainOwner),
              Binding.to(WorkerBinding, workerService),
              Binding.to(UtilityBinding, baseA),
            ],
          });
          primaryDependentOwnerId = dependent.id;
          const dependentIdentity = yield* inspect(dependent);
          assert.equal(dependentIdentity.type, "utility");
          assert.equal(dependentIdentity.pid, dependent.processId);
          yield* waitForUtilityPid(dependent.processId, "dependent utility appears in app metrics");
          const route = yield* withClient(dependent, (client) => client.route());
          assert.equal(route.main.role, "main");
          assert.equal(route.worker.role, "worker-service");
          assert.equal(route.utility.role, "base");
          assert.equal(route.main.type, String(process.type ?? "browser"));
          assert.equal(route.worker.type, "worker");
          assert.equal(route.utility.type, "utility");
          const utilityPlacement = yield* waitDiagnostics(
            diagnostics,
            (snapshot) => {
              const owner = snapshot.owners.find(
                (candidate) =>
                  candidate.ownerId === dependent.id && candidate.runtime === "utility",
              );
              const binding = snapshot.bindings.find(
                (candidate) =>
                  candidate.runtime === "utility" &&
                  candidate.runtimeId === dependent.id &&
                  candidate.slot === UtilityBinding.key,
              );
              return owner !== undefined && binding !== undefined ? { owner, binding } : undefined;
            },
            "utility owner and dependency diagnostics",
          );
          assert.equal(utilityPlacement.owner.ownerId, dependent.id);
          assert.equal(utilityPlacement.owner.runtimeId, dependent.id);
          assert.equal(utilityPlacement.owner.processId, dependent.processId);
          assert.equal(utilityPlacement.owner.threadId, 0);
          assert.equal(utilityPlacement.binding.runtimeId, dependent.id);
          assert.equal(utilityPlacement.binding.ownerId, baseA.id);
          assert.equal(utilityPlacement.binding.processId, dependent.processId);
          record("a utility handler Layer resolves main, worker, and utility dependencies", {
            dependent: { id: dependent.id, processId: dependent.processId },
            route,
            diagnostics: utilityPlacement,
          });

          const directWorker = yield* withClient(workerService, (client) => client.inspect());
          assert.equal(directWorker.role, "worker-service");
          assert.equal(directWorker.type, "worker");
          assert.notEqual(directWorker.pid, dependent.processId);
          const workerConsumer = yield* Worker.spawn(
            Worker.entry(
              new URL("./utility-consumer-worker.mjs?role=consumer", import.meta.url),
              Protocol,
            ),
            { bindings: [Binding.to(ConsumerBinding, dependent)] },
          );
          const workerClientIdentity = yield* inspect(workerConsumer);
          assert.equal(workerClientIdentity.pid, dependent.processId);
          assert.equal(workerClientIdentity.type, "utility");
          const workerRoute = yield* withClient(workerConsumer, (client) => client.route());
          assert.equal(workerRoute.utility.pid, baseA.processId);
          record(
            "main and worker clients reach the same stable utility owner through public bindings",
            {
              directWorker,
              workerClient: workerClientIdentity,
              workerRoute,
            },
          );

          let streamExit;
          let waitExit;
          yield* withClientScope(dependent, (client) =>
            Effect.gen(function* () {
              const streamFiber = yield* client
                .stream({ count: 100, delayMs: 12 })
                .pipe(Stream.runCollect, Effect.forkScoped);
              yield* Effect.sleep(45);
              yield* Fiber.interrupt(streamFiber);
              streamExit = yield* Fiber.await(streamFiber);
              assert.equal(
                streamExit._tag,
                "Failure",
                "stream cancellation must interrupt the client",
              );
              const waitFiber = yield* client.wait({ milliseconds: 1_000 }).pipe(Effect.forkScoped);
              yield* Effect.sleep(30);
              yield* Fiber.interrupt(waitFiber);
              waitExit = yield* Fiber.await(waitFiber);
              assert.equal(
                waitExit._tag,
                "Failure",
                "unary cancellation must interrupt the client",
              );
            }),
          );
          const streamFinalized = yield* waitForLine(
            streamMarker,
            (line) => line.pid === dependent.processId && line.phase === "stream-finalized",
            "cancelled utility stream finalizer",
          );
          const unaryFinalized = yield* waitForLine(
            unaryMarker,
            (line) => line.pid === dependent.processId && line.phase === "wait-finalized",
            "cancelled utility unary finalizer",
          );
          const interruptedRequest = yield* waitDiagnostics(
            diagnostics,
            (snapshot) => {
              const started = snapshot.events.find(
                ({ event }) =>
                  event._tag === "RequestStarted" &&
                  event.ownerId === dependent.id &&
                  event.procedure === "wait",
              );
              if (started === undefined) return undefined;
              const ended = snapshot.events.find(
                ({ event }) =>
                  event._tag === "RequestEnded" &&
                  event.ownerId === dependent.id &&
                  event.requestId === started.event.requestId,
              );
              return ended === undefined
                ? undefined
                : { started: started.event, ended: ended.event };
            },
            "cancelled utility unary RequestEnded diagnostic",
          );
          assert.ok(
            ["interrupted", "disconnected"].includes(interruptedRequest.ended.outcome),
            JSON.stringify(interruptedRequest),
          );
          record("stream and unary cancellation reach the utility and run downstream cleanup", {
            streamExit: streamExit._tag,
            waitExit: waitExit._tag,
            streamFinalized,
            unaryFinalized,
            interruptedRequest,
          });

          const rendererWindow = yield* BrowserWindow.make({
            title: "Sewed utility process acceptance",
            show: false,
            width: 480,
            height: 240,
          });
          const rendererNative = nativeWindowForTitle("Sewed utility process acceptance");
          const rendererEntry = Renderer.entry(
            new URL("../.artifacts/utility-process-renderer/index.html", import.meta.url),
            { bindings: [ConsumerBinding] },
          );
          const rendererBinding = [Binding.to(ConsumerBinding, dependent)];
          yield* rendererWindow.webContents.load(rendererEntry, { bindings: rendererBinding });
          const rendererFirst = yield* waitRenderer(rendererNative, "renderer utility binding");
          assert.equal(rendererFirst.error, undefined, JSON.stringify(rendererFirst));
          assert.equal(rendererFirst.pid, dependent.processId);
          assert.equal(rendererFirst.type, "utility");
          assert.equal(rendererFirst.streamValues.length, 2);
          yield* rendererWindow.webContents.reload;
          const rendererSecond = yield* waitRenderer(
            rendererNative,
            "renderer binding after reload",
          );
          assert.equal(rendererSecond.error, undefined, JSON.stringify(rendererSecond));
          assert.equal(rendererSecond.pid, dependent.processId);
          assert.deepEqual(
            { pid: rendererSecond.pid, id: dependent.id },
            { pid: rendererFirst.pid, id: dependent.id },
          );
          record(
            "renderer reload preserves the utility owner PID and ID while streams are cancelled",
            {
              first: rendererFirst,
              second: rendererSecond,
              ownerId: dependent.id,
            },
          );

          const shutdownStarted = Date.now();
          yield* baseB.shutdown;
          const shutdownCode = yield* baseB.awaitExit;
          const shutdownFinalized = yield* waitForLine(
            finalizerMarker,
            (line) => line.pid === baseB.processId && line.phase === "finalized",
            "graceful utility finalizer",
          );
          assert.equal(typeof shutdownCode, "number");
          assert.ok(Date.now() - shutdownStarted >= 50);
          yield* waitForUtilityGone(baseB.processId, "gracefully shutdown utility exits");
          record("graceful shutdown waits for the asynchronous utility finalizer and native exit", {
            processId: baseB.processId,
            exitCode: shutdownCode,
            elapsedMs: Date.now() - shutdownStarted,
            finalized: shutdownFinalized,
          });

          const crashOwner = yield* Utility.spawn(baseEntry, { bindings: [] });
          let crashError;
          let unaryExit;
          let activeStreamExit;
          yield* withClientScope(crashOwner, (client) =>
            Effect.gen(function* () {
              const activeUnary = yield* client
                .wait({ milliseconds: 5_000 })
                .pipe(Effect.forkScoped);
              const activeStream = yield* client
                .stream({ count: 100, delayMs: 20 })
                .pipe(Stream.runCollect, Effect.forkScoped);
              yield* Effect.sleep(45);
              const crashExit = yield* Effect.exit(client.crash());
              crashError = errorFromExit(crashExit);
              assert.ok(crashError, "crash must fail the active RPC");
              unaryExit = yield* Fiber.await(activeUnary);
              activeStreamExit = yield* Fiber.await(activeStream);
            }),
          );
          assert.equal(unaryExit._tag, "Failure");
          assert.equal(activeStreamExit._tag, "Failure");
          const crashCode = yield* crashOwner.awaitExit;
          assert.equal(typeof crashCode, "number");
          const lateExit = yield* Effect.exit(inspect(crashOwner));
          const lateError = errorFromExit(lateExit);
          assert.equal(lateError.code, "Closed");
          yield* waitForUtilityGone(crashOwner.processId, "crashed utility exits");
          const crashClosed = yield* waitDiagnostics(
            diagnostics,
            (snapshot) =>
              snapshot.events.find(
                ({ event }) => event._tag === "OwnerClosed" && event.ownerId === crashOwner.id,
              ),
            "crashed utility OwnerClosed diagnostic",
          );
          record(
            "a crashed utility fails active unary and stream calls, reports exit, and rejects late calls",
            {
              processId: crashOwner.processId,
              ownerId: crashOwner.id,
              crash: { code: crashError.code, message: crashError.message },
              unary: unaryExit._tag,
              stream: activeStreamExit._tag,
              exitCode: crashCode,
              late: { code: lateError.code, message: lateError.message },
              closed: crashClosed,
            },
          );

          const terminateOwner = yield* Utility.spawn(baseEntry, { bindings: [] });
          const terminateStarted = Date.now();
          yield* terminateOwner.terminate;
          const terminateCode = yield* terminateOwner.awaitExit;
          assert.equal(typeof terminateCode, "number");
          yield* waitForUtilityGone(terminateOwner.processId, "terminated utility exits");
          record("explicit terminate kills the real utility process and waits for its exit", {
            processId: terminateOwner.processId,
            exitCode: terminateCode,
            elapsedMs: Date.now() - terminateStarted,
          });

          const primaryPids = [baseA.processId, dependent.processId];
          yield* waitForUtilityPid(baseA.processId, "base utility remains live before scope close");
          assert.deepEqual(
            utilityPids()
              .filter((pid) => primaryPids.includes(pid))
              .sort(),
            primaryPids.sort(),
          );
          record("app.getAppMetrics reports each live owner as Sewed Utility", {
            metrics: utilityMetrics().map((metric) => ({
              name: metric.name,
              pid: metricPid(metric),
            })),
          });
        }),
      );

      const scopeClosed = yield* waitDiagnostics(
        diagnostics,
        (snapshot) =>
          snapshot.events.find(
            ({ event }) =>
              event._tag === "OwnerClosed" && event.ownerId === primaryDependentOwnerId,
          ),
        "scope-closed utility OwnerClosed diagnostic",
      );
      const closed = yield* waitUntil(() => {
        const lines = readLines(finalizerMarker);
        const evidence = {
          base: lines.filter((line) => line.role === "base" && line.phase === "finalized"),
          dependent: lines.filter(
            (line) => line.role === "dependent" && line.phase === "finalized",
          ),
        };
        return evidence.base.length >= 1 && evidence.dependent.length >= 1 ? evidence : undefined;
      }, "scope-close utility finalizers");
      assert.ok(closed.base.length >= 1);
      assert.ok(closed.dependent.length >= 1);
      record("scope close waits for asynchronous finalizers before utility owners disappear", {
        finalizers: closed,
        ownerClosed: scopeClosed,
      });

      const fallbackStarted = Date.now();
      let blockedPid;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const blocked = yield* Utility.spawn(blockedEntry, { bindings: [] });
          blockedPid = blocked.processId;
          yield* waitForLine(
            finalizerMarker,
            (line) => line.pid === blockedPid && line.phase === "started",
            "blocked utility startup",
          );
          yield* waitForUtilityPid(blockedPid, "blocked utility appears in app metrics");
        }),
      );
      const fallbackElapsed = Date.now() - fallbackStarted;
      assert.ok(
        fallbackElapsed >= 1_800,
        `scope fallback completed too early (${fallbackElapsed}ms)`,
      );
      assert.ok(
        fallbackElapsed < 8_000,
        `scope fallback exceeded expected bound (${fallbackElapsed}ms)`,
      );
      yield* waitForUtilityGone(blockedPid, "scope fallback utility exits");
      const blockedLines = readLines(finalizerMarker).filter((line) => line.pid === blockedPid);
      assert.equal(
        blockedLines.some((line) => line.phase === "released"),
        false,
      );
      record(
        "scope close forcefully terminates a utility whose finalizer exceeds the two second bound",
        {
          processId: blockedPid,
          elapsedMs: fallbackElapsed,
          phases: blockedLines.map((line) => line.phase),
        },
      );
      const live = yield* diagnostics.snapshot;
      assert.equal(live.requests.length, 0);
      assert.equal(live.bindings.length, 0);
      assert.equal(live.owners.filter((owner) => owner.runtime === "utility").length, 0);
      record("diagnostics has no live utility owner, binding, or request after scope closure", {
        utilityOwners: live.owners.filter((owner) => owner.runtime === "utility"),
        bindings: live.bindings,
        requests: live.requests,
      });
    }).pipe(Effect.provide(diagnostics.layer)),
  );
  const settled = yield* diagnostics.snapshot;
  assert.equal(settled.owners.length, 0);
  assert.equal(settled.bindings.length, 0);
  assert.equal(settled.requests.length, 0);
});

App.run(
  [],
  Effect.gen(function* () {
    yield* App.decide(
      Decidables.App.LastWindowClosed,
      Decision.sync(() => "stay"),
    );
    const result = yield* Effect.exit(run);
    if (result._tag === "Failure") {
      state.error = causeText(result.cause);
      return yield* Effect.failCause(result.cause);
    }
    state.success = true;
    yield* App.quit;
  }),
);
