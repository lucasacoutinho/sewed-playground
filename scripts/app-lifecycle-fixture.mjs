import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";

import { app, BrowserWindow as NativeBrowserWindow } from "electron";
import { Cause, Deferred, Effect, Fiber, Scope, Stream } from "effect";

const marker = "APP_LIFECYCLE_VERIFICATION";
const listenerEvents = ["activate", "before-quit", "will-quit", "window-all-closed"];
const mode = "api-quit";
const setupComplete = Deferred.makeUnsafe();

const checks = [];
const state = {
  mode,
  setupReturned: false,
  beforeQuitCount: 0,
  willQuitCount: 0,
  report: undefined,
  precheck: undefined,
  postcheck: undefined,
  shutdownObserver: undefined,
  errors: [],
  finalization: {
    rootFinalizerComplete: false,
    scopedFinalizerComplete: false,
    scopedFiberInterrupted: false,
    timeline: [],
  },
};

const baselineListeners = Object.fromEntries(
  listenerEvents.map((event) => [event, app.listenerCount(event)]),
);
const baselineWindowCount = NativeBrowserWindow.getAllWindows().length;
const { App, BrowserWindow, Declaration, Paths } = await import("sewed/main");
const { Decidables, Decision } = await import("sewed");
const pathDirectory = mkdtempSync(join(tmpdir(), "sewed-invalid-path-"));
const relativeTarget = join(pathDirectory, "unexpected");
// A relative spelling of that target where one exists; on Windows the temp directory can sit on
// another drive, where `relative` can only answer an absolute path, so a plain relative name
// stands in for it there.
const relativeSpelling = relative(process.cwd(), relativeTarget);
const pathDefinition = Declaration.definition(
  Paths.declare({
    sessionData: isAbsolute(relativeSpelling) ? "sewed-unexpected-relative" : relativeSpelling,
  }),
);
assert.ok(pathDefinition);
assert.throws(() => pathDefinition.apply(), /absolute/);
assert.equal(existsSync(relativeTarget), false);
const inertDefinitions = { activations: App.activations, quit: App.quit };
const afterDefinitionListeners = Object.fromEntries(
  listenerEvents.map((event) => [event, app.listenerCount(event)]),
);

const onBeforeQuit = () => {
  state.beforeQuitCount += 1;
};

const causeText = (cause) => {
  try {
    return Cause.pretty(cause);
  } catch {
    return String(cause);
  }
};

const errorFacts = (error) =>
  error === undefined
    ? undefined
    : {
        name: error.name,
        code: error.code,
        message: error.message,
        cause: error.cause instanceof Error ? error.cause.message : error.cause,
      };

const failureError = (exit) => {
  if (exit._tag !== "Failure") return undefined;
  const result = Cause.findErrorOption(exit.cause);
  return result._tag === "Some" ? result.value : undefined;
};

const exitFacts = (exit) => ({
  tag: exit._tag,
  error: exit._tag === "Failure" ? errorFacts(failureError(exit)) : undefined,
  cause: exit._tag === "Failure" ? causeText(exit.cause) : undefined,
});

const listenerSnapshot = () =>
  Object.fromEntries(listenerEvents.map((event) => [event, app.listenerCount(event)]));

const nativeWindowFacts = () =>
  NativeBrowserWindow.getAllWindows().map((window) => ({
    destroyed: window.isDestroyed(),
    minimized: window.isMinimized(),
    visible: window.isVisible(),
  }));

const record = (name, evidence = {}) => {
  checks.push({ name, evidence: structuredClone(evidence) });
  console.log(`PASS ${name}`);
};

const waitUntil = (read, description, timeout = 8_000) =>
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
      yield* Effect.sleep(5);
    }
    throw new Error(
      `Timed out: ${description}${lastError ? ` (${lastError.message || lastError})` : ""}`,
    );
  });

const emitActivation = (hasVisibleWindows) => {
  const emitted = app.emit("activate", {}, hasVisibleWindows);
  assert.equal(emitted, true, "Native activate event had no listener");
};

const soleNativeWindow = () => {
  const windows = NativeBrowserWindow.getAllWindows();
  assert.equal(windows.length, 1, `Expected one native test window, found ${windows.length}`);
  return windows[0];
};

const observeActivations = (gate) =>
  Effect.gen(function* () {
    const observer = { values: [], exit: undefined };
    const stream = App.activations.pipe(
      Stream.runForEach((activation) =>
        Effect.gen(function* () {
          if (gate !== undefined && observer.values.length === 0) {
            yield* Deferred.succeed(gate.started, undefined);
            yield* Deferred.await(gate.release);
          }
          observer.values.push({ ...activation });
        }),
      ),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          observer.exit = exit;
        }),
      ),
    );
    observer.fiber = yield* Effect.forkScoped(stream);
    return observer;
  });

const runActivationChecks = Effect.gen(function* () {
  record("relative application paths fail before directory creation");
  assert.deepEqual(afterDefinitionListeners, baselineListeners);
  assert.equal(NativeBrowserWindow.getAllWindows().length, baselineWindowCount);
  assert.equal(inertDefinitions.activations, App.activations);
  assert.equal(inertDefinitions.quit, App.quit);
  record("App lifecycle definitions are inert", {
    listenersBefore: baselineListeners,
    listenersAfterDefinitions: afterDefinitionListeners,
    nativeWindowCount: baselineWindowCount,
  });

  const first = yield* observeActivations();
  yield* waitUntil(
    () => app.listenerCount("activate") === baselineListeners.activate + 1,
    "first activation listener registration",
  );
  assert.equal(first.values.length, 0, "Activation stream replayed before the first native event");
  emitActivation(false);
  yield* waitUntil(() => first.values.length === 1, "first false activation");
  emitActivation(true);
  yield* waitUntil(() => first.values.length === 2, "first true activation");
  assert.deepEqual(
    first.values.map((activation) => activation.hasVisibleWindows),
    [false, true],
  );
  record("first activation observer receives native false and true flags", {
    values: first.values,
    nativeWindowFacts: nativeWindowFacts(),
  });

  const second = yield* observeActivations();
  yield* waitUntil(
    () => app.listenerCount("activate") === baselineListeners.activate + 2,
    "second activation listener registration",
  );
  assert.deepEqual(second.values, [], "Second activation observer replayed prior events");
  emitActivation(false);
  yield* waitUntil(
    () => first.values.length === 3 && second.values.length === 1,
    "shared activation",
  );
  assert.deepEqual(second.values, [{ hasVisibleWindows: false }]);
  record("second observer receives no replay and both observers receive a new event", {
    first: first.values,
    second: second.values,
    activateListeners: app.listenerCount("activate"),
  });

  yield* Fiber.interrupt(second.fiber);
  const secondExit = yield* Fiber.await(second.fiber);
  assert.equal(secondExit._tag, "Failure");
  assert.equal(app.listenerCount("activate"), baselineListeners.activate + 1);
  const firstBeforeRemainingEvent = first.values.length;
  emitActivation(true);
  yield* waitUntil(
    () => first.values.length === firstBeforeRemainingEvent + 1,
    "remaining observer after one cancellation",
  );
  assert.equal(second.values.length, 1);
  record("cancelling one observer removes only its listener", {
    cancelled: exitFacts(secondExit),
    activateListenersAfterCancellation: app.listenerCount("activate"),
    remainingObserverValues: first.values,
  });

  yield* Fiber.interrupt(first.fiber);
  const firstExit = yield* Fiber.await(first.fiber);
  assert.equal(firstExit._tag, "Failure");
  assert.equal(app.listenerCount("activate"), baselineListeners.activate);
  record("activation observer cancellation returns the listener count to baseline", {
    cancelled: exitFacts(firstExit),
    activateListeners: app.listenerCount("activate"),
  });

  const once = yield* App.activations.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
  yield* waitUntil(
    () => app.listenerCount("activate") === baselineListeners.activate + 1,
    "one-event observer listener registration",
  );
  emitActivation(true);
  const value = yield* Fiber.join(once);
  assert.deepEqual(value, [{ hasVisibleWindows: true }]);
  assert.equal(app.listenerCount("activate"), baselineListeners.activate);
  record("normal stream completion removes its activation listener", { value });
});

const runOverflowCheck = Effect.gen(function* () {
  const started = yield* Deferred.make();
  const release = yield* Deferred.make();
  const slow = yield* observeActivations({ started, release });
  yield* waitUntil(
    () => app.listenerCount("activate") === baselineListeners.activate + 1,
    "overflow observer listener registration",
  );

  emitActivation(false);
  yield* Deferred.await(started);

  const injectedAfterGate = 129;
  for (let index = 0; index < injectedAfterGate; index += 1) emitActivation(true);

  yield* Deferred.succeed(release, undefined);
  const slowExit = yield* Fiber.await(slow.fiber);
  assert.equal(slowExit._tag, "Failure", "Slow observer did not fail after queue overflow");
  const overflowError = failureError(slowExit);
  assert.equal(overflowError?.code, "Limit", exitFacts(slowExit));
  assert.equal(
    slow.values.length,
    129,
    "Overflow did not drain the first event plus 128 queued events",
  );
  assert.equal(app.listenerCount("activate"), baselineListeners.activate);
  record("slow activation observer fails with Limit after bounded synchronous overflow", {
    injectedAfterGate,
    deliveredBeforeFailure: slow.values.length,
    failure: exitFacts(slowExit),
    activateListenersAfterFailure: app.listenerCount("activate"),
  });
});

const runNativeFailureCheck = Effect.gen(function* () {
  const originalOn = app.on;
  const activationListeners = app.listeners("activate");
  const registrationError = new Error("fixture activation listener registration failure");
  const registration = yield* Effect.exit(
    Effect.sync(() => {
      app.on = (event, listener) => {
        if (event === "activate") throw registrationError;
        return originalOn.call(app, event, listener);
      };
    }).pipe(
      Effect.andThen(App.activations.pipe(Stream.runDrain, Effect.timeout(8_000))),
      Effect.ensuring(
        Effect.sync(() => {
          app.on = originalOn;
        }),
      ),
    ),
  );
  const registrationFailure = failureError(registration);
  assert.equal(registrationFailure?.code, "Native", exitFacts(registration));
  assert.equal(registrationFailure?.cause, registrationError);
  assert.deepEqual(app.listeners("activate"), activationListeners);
  record("activation registration failures reach the observer with the original native cause", {
    code: registrationFailure.code,
    activateListeners: app.listenerCount("activate"),
  });

  const originalQuit = app.quit;
  const nativeError = new Error("fixture native quit failure");
  let restored = false;
  const failed = yield* Effect.exit(
    Effect.sync(() => {
      app.quit = () => {
        throw nativeError;
      };
    }).pipe(
      Effect.andThen(App.quit),
      Effect.ensuring(
        Effect.sync(() => {
          app.quit = originalQuit;
          restored = true;
        }),
      ),
    ),
  );
  assert.equal(restored, true);
  assert.equal(
    failed._tag,
    "Failure",
    "App.quit unexpectedly succeeded through a throwing native quit",
  );
  const error = failureError(failed);
  assert.equal(error?.code, "Native", exitFacts(failed));
  assert.equal(error?.cause, nativeError, "App.quit did not preserve the original native cause");
  record("App.quit maps a native throw to SewedError Native with its original cause", {
    exit: exitFacts(failed),
    restored,
  });
});

const runKeepalivePreparation = Effect.gen(function* () {
  const appScope = yield* Effect.scope;
  const initial = yield* BrowserWindow.make({ show: false, title: "Sewed app lifecycle initial" });
  const initialNative = soleNativeWindow();
  const freshWindow = yield* Deferred.make();
  const current = { handle: initial, closed: false, activations: 0 };
  const handler = App.activations.pipe(
    Stream.runForEach(({ hasVisibleWindows }) =>
      Effect.gen(function* () {
        current.activations += 1;
        if (hasVisibleWindows || !current.closed) return;
        const fresh = yield* BrowserWindow.make({
          show: false,
          title: "Sewed app lifecycle fresh",
        }).pipe(Scope.provide(appScope));
        current.handle = fresh;
        current.closed = false;
        yield* Deferred.succeed(freshWindow, fresh);
      }),
    ),
  );
  const handlerFiber = yield* Effect.forkScoped(handler);
  yield* waitUntil(
    () => app.listenerCount("activate") === baselineListeners.activate + 1,
    "keepalive activation handler listener registration",
  );
  return { appScope, current, handlerFiber, initial, initialNative, freshWindow };
});

const runKeepaliveAfterSetupReturn = (keepalive) =>
  Effect.gen(function* () {
    yield* Deferred.await(setupComplete);
    assert.equal(state.setupReturned, true);

    emitActivation(false);
    yield* waitUntil(
      () => keepalive.current.activations === 1,
      "activation with an owned hidden window",
    );
    assert.equal(soleNativeWindow(), keepalive.initialNative);
    assert.equal(keepalive.initialNative.isVisible(), false);
    record("application policy distinguishes a hidden window from a closed owner", {
      owner: keepalive.current.handle.id,
      nativeWindowFacts: nativeWindowFacts(),
    });

    keepalive.initialNative.close();
    yield* keepalive.initial.awaitClosed;
    keepalive.current.closed = true;
    yield* waitUntil(
      () => NativeBrowserWindow.getAllWindows().length === baselineWindowCount,
      "initial hidden native window close",
    );
    const oldHandleExit = yield* Effect.exit(keepalive.initial.close);
    assert.equal(oldHandleExit._tag, "Failure");
    assert.equal(failureError(oldHandleExit)?.code, "Closed", exitFacts(oldHandleExit));
    assert.equal(NativeBrowserWindow.getAllWindows().length, baselineWindowCount);
    record("setup keepalive leaves a closed native window closed until explicit activation", {
      setupReturned: state.setupReturned,
      oldHandle: exitFacts(oldHandleExit),
      nativeWindowFacts: nativeWindowFacts(),
    });

    emitActivation(false);
    const fresh = yield* Effect.timeout(8_000)(Deferred.await(keepalive.freshWindow));
    const freshNative = soleNativeWindow();
    assert.notEqual(fresh.id, keepalive.initial.id);
    assert.notEqual(freshNative, keepalive.initialNative);
    assert.equal(keepalive.initialNative.isDestroyed(), true);
    assert.equal(freshNative.isDestroyed(), false);
    const staleOwnerExit = yield* Effect.exit(keepalive.initial.close);
    assert.equal(failureError(staleOwnerExit)?.code, "Closed", exitFacts(staleOwnerExit));
    record("activation handler creates a fresh BrowserWindow owner", {
      oldOwner: keepalive.initial.id,
      freshOwner: fresh.id,
      staleOwner: exitFacts(staleOwnerExit),
      nativeWindowFacts: nativeWindowFacts(),
    });

    yield* Fiber.interrupt(keepalive.handlerFiber);
    const handlerExit = yield* Fiber.await(keepalive.handlerFiber);
    assert.equal(handlerExit._tag, "Failure");
    assert.equal(app.listenerCount("activate"), baselineListeners.activate);
    assert.equal(freshNative.isDestroyed(), false);
    assert.equal(NativeBrowserWindow.getAllWindows().length, baselineWindowCount + 1);
    record("cancelling activation handler preserves a window acquired in application scope", {
      handler: exitFacts(handlerExit),
      activateListeners: app.listenerCount("activate"),
      freshNativeDestroyed: freshNative.isDestroyed(),
      nativeWindowFacts: nativeWindowFacts(),
    });
  });

const prepareApplication = Effect.gen(function* () {
  yield* App.decide(
    Decidables.App.LastWindowClosed,
    Decision.sync(() => "stay"),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sleep(90).pipe(
      Effect.andThen(
        Effect.sync(() => {
          state.finalization.timeline.push("root-finalizer-complete");
          state.finalization.rootFinalizerComplete = true;
        }),
      ),
    ),
  );
  const scopedReady = yield* Deferred.make();
  yield* Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.sleep(60).pipe(
        Effect.andThen(
          Effect.sync(() => {
            state.finalization.timeline.push("scoped-finalizer-complete");
            state.finalization.scopedFinalizerComplete = true;
          }),
        ),
      ),
    );
    yield* Deferred.succeed(scopedReady, undefined);
    yield* Effect.never;
  }).pipe(
    Effect.scoped,
    Effect.onExit((exit) =>
      Effect.sync(() => {
        state.finalization.scopedFiberInterrupted =
          exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause);
      }),
    ),
    Effect.forkScoped,
  );
  yield* Deferred.await(scopedReady);

  yield* runActivationChecks;
  yield* runOverflowCheck;
  yield* runNativeFailureCheck;
  const keepalive = yield* runKeepalivePreparation;

  const postSetup = Effect.gen(function* () {
    const result = yield* Effect.exit(runKeepaliveAfterSetupReturn(keepalive));
    state.postcheck = result;
    if (result._tag === "Failure") {
      state.errors.push(causeText(result.cause));
      return yield* App.quit;
    }
    state.shutdownObserver = yield* observeActivations();
    yield* waitUntil(
      () => app.listenerCount("activate") === baselineListeners.activate + 1,
      "active observer retained until application quit",
    );
    const quitResult = yield* Effect.exit(App.quit);
    if (quitResult._tag === "Failure" && !Cause.hasInterruptsOnly(quitResult.cause)) {
      state.errors.push(`App.quit failed: ${causeText(quitResult.cause)}`);
      return;
    }
  });

  state.precheck = { _tag: "Success" };
  yield* Effect.forkScoped(postSetup);
});

const onWillQuit = () => {
  state.willQuitCount += 1;
  state.finalization.timeline.push("will-quit");
  app.off("will-quit", onWillQuit);
  app.off("before-quit", onBeforeQuit);
  const listeners = listenerSnapshot();
  const listenerCleanup = listenerEvents.every(
    (event) => listeners[event] === baselineListeners[event],
  );
  const finalizersComplete =
    state.finalization.rootFinalizerComplete &&
    state.finalization.scopedFinalizerComplete &&
    state.finalization.scopedFiberInterrupted;
  const observerExit = state.shutdownObserver?.exit;
  const observerInterrupted =
    observerExit?._tag === "Failure" && Cause.hasInterruptsOnly(observerExit.cause);
  const checksComplete =
    state.precheck?._tag === "Success" &&
    state.postcheck?._tag === "Success" &&
    state.errors.length === 0;
  const windowsClosed = NativeBrowserWindow.getAllWindows().length === baselineWindowCount;
  const success =
    checksComplete &&
    finalizersComplete &&
    listenerCleanup &&
    observerInterrupted &&
    windowsClosed &&
    state.beforeQuitCount > 0 &&
    state.willQuitCount === 1;
  if (success) {
    record("application quit interrupts an active activation observer and removes its listener", {
      observer: exitFacts(observerExit),
      finalListeners: listeners,
    });
    record("App.quit waits for scoped fiber and asynchronous root cleanup before will-quit", {
      finalization: state.finalization,
      finalListeners: listeners,
      nativeWindowFacts: nativeWindowFacts(),
    });
  }
  state.report = {
    success,
    mode,
    checks,
    error: success
      ? undefined
      : state.errors.join("; ") ||
        `Lifecycle completion failed (checks=${checks.length}, finalizers=${finalizersComplete}, listeners=${listenerCleanup}, observerInterrupted=${observerInterrupted}, windowsClosed=${windowsClosed})`,
    evidence: {
      baselineWindowCount,
      baselineListeners,
      finalListeners: listeners,
      beforeQuitCount: state.beforeQuitCount,
      willQuitCount: state.willQuitCount,
      setupReturned: state.setupReturned,
      finalization: state.finalization,
      nativeWindowFacts: nativeWindowFacts(),
    },
  };
  console.log(`${marker} ${JSON.stringify(state.report)}`);
};

assert.equal(NativeBrowserWindow.getAllWindows().length, baselineWindowCount);
app.on("before-quit", onBeforeQuit);
app.on("will-quit", onWillQuit);

App.run(
  [],
  prepareApplication.pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        state.precheck = { _tag: "Failure", cause: causeText(cause) };
        state.errors.push(causeText(cause));
        yield* Effect.sync(() => app.quit());
      }),
    ),
    Effect.onExit((exit) =>
      Effect.sync(() => {
        state.setupReturned = exit._tag === "Success";
        Deferred.doneUnsafe(setupComplete, Effect.void);
      }),
    ),
  ),
);
