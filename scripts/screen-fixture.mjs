import assert from "node:assert/strict";
import { app, screen } from "electron";
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Scope, Stream } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Binding, Decidables, Decision, Screen as ScreenData, SewedError } from "sewed";

async function verifyScreen() {
  await app.whenReady();

  const events = ["display-added", "display-removed", "display-metrics-changed"];
  const listeners = () =>
    Object.fromEntries(events.map((event) => [event, screen.listeners(event)]));
  const baseline = listeners();
  const counts = () =>
    Object.fromEntries(events.map((event) => [event, screen.listenerCount(event)]));
  const checks = [];
  const record = (name, evidence = {}) => {
    checks.push({ name, evidence: structuredClone(evidence) });
    console.log(`PASS ${name}`);
  };

  const queryMethods = [
    "getAllDisplays",
    "getPrimaryDisplay",
    "getCursorScreenPoint",
    "getDisplayNearestPoint",
    "getDisplayMatching",
  ];
  const originalQueries = Object.fromEntries(queryMethods.map((name) => [name, screen[name]]));
  let constructionQueries = 0;
  for (const name of queryMethods) {
    screen[name] = (...args) => {
      constructionQueries += 1;
      return originalQueries[name].apply(screen, args);
    };
  }
  let main;
  try {
    main = await import("sewed/main");
    const { Screen } = main;
    const definitions = [
      Screen.displays,
      Screen.primary,
      Screen.cursor,
      Screen.changes,
      Screen.nearest({ x: 0, y: 0 }),
      Screen.matching({ x: 0, y: 0, width: 1, height: 1 }),
    ];
    assert.equal(definitions.length, 6);
    assert.equal(constructionQueries, 0);
    assert.deepEqual(listeners(), baseline);
  } finally {
    for (const name of queryMethods) screen[name] = originalQueries[name];
  }
  const { App, Screen, host } = main;

  const DisplayInfo = RpcGroup.make(
    Rpc.make("all", { success: Schema.Array(ScreenData.Display), error: SewedError }),
    Rpc.make("primary", { success: ScreenData.Display, error: SewedError }),
    Rpc.make("nearest", {
      payload: ScreenData.Point,
      success: ScreenData.Display,
      error: SewedError,
    }),
    Rpc.make("matching", {
      payload: ScreenData.Bounds,
      success: ScreenData.Display,
      error: SewedError,
    }),
    Rpc.make("changes", { success: ScreenData.Change, stream: true, error: SewedError }),
  );
  const Displays = Binding.slot("displays", DisplayInfo);

  const project = (value) => ({
    id: value.id,
    label: value.label,
    bounds: { ...value.bounds },
    workArea: { ...value.workArea },
    scaleFactor: value.scaleFactor,
    rotation: value.rotation,
    internal: value.internal,
  });
  const waitUntil = (read, description) =>
    Effect.gen(function* () {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const value = read();
        if (value) return value;
        yield* Effect.sleep(5);
      }
      throw new Error(`Timed out: ${description}`);
    });
  const waitListeners = (additional) =>
    waitUntil(
      () =>
        events.every(
          (event) => screen.listenerCount(event) === baseline[event].length + additional,
        ),
      `${additional} screen subscribers`,
    );
  const failure = (exit) => {
    assert.equal(exit._tag, "Failure");
    const error = Cause.findErrorOption(exit.cause);
    assert.equal(error._tag, "Some", Cause.pretty(exit.cause));
    return error.value;
  };

  const observe = (stream, gate) =>
    Effect.gen(function* () {
      const observer = { values: [], exit: undefined };
      observer.fiber = yield* stream.pipe(
        Stream.runForEach((value) =>
          Effect.gen(function* () {
            if (gate !== undefined && observer.values.length === 0) {
              yield* Deferred.succeed(gate.started, undefined);
              yield* Deferred.await(gate.release);
            }
            observer.values.push(value);
          }),
        ),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            observer.exit = exit;
          }),
        ),
        Effect.forkScoped,
      );
      return observer;
    });

  const nativeQuery = (name, operation, args, convert = project) =>
    Effect.scoped(
      Effect.gen(function* () {
        const original = screen[name];
        const calls = [];
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            screen[name] = (...input) => {
              const result = original.apply(screen, input);
              calls.push({ input: structuredClone(input), result });
              return result;
            };
          }),
          () =>
            Effect.sync(() => {
              screen[name] = original;
            }),
        );
        const value = yield* operation;
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].input, args);
        assert.deepEqual(value, convert(calls[0].result));
        return { value, native: calls[0].result };
      }),
    );

  const runChecks = Effect.gen(function* () {
    record("screen definitions are inert", { constructionQueries, listeners: counts() });
    const all = yield* nativeQuery("getAllDisplays", Screen.displays, [], (values) =>
      values.map(project),
    );
    assert.ok(all.value.length > 0, "The fixture needs a display");
    record("display discovery reports native IDs, bounds, work areas and scaling", all.value);
    const primary = yield* nativeQuery("getPrimaryDisplay", Screen.primary, []);
    assert.ok(all.value.some((display) => display.id === primary.value.id));
    const captured = structuredClone(primary.value);
    primary.native.bounds.x += 1;
    primary.native.workArea.width += 1;
    assert.deepEqual(primary.value, captured);
    record("primary display snapshots do not retain mutable native rectangles", primary.value);
    const cursor = yield* nativeQuery("getCursorScreenPoint", Screen.cursor, [], (point) => ({
      ...point,
    }));
    record("cursor queries return the actual native DIP point", cursor.value);
    const nearest = yield* nativeQuery("getDisplayNearestPoint", Screen.nearest(cursor.value), [
      cursor.value,
    ]);
    record("nearest display selection forwards the exact point to Electron", nearest.value);
    const matching = yield* nativeQuery("getDisplayMatching", Screen.matching(captured.workArea), [
      captured.workArea,
    ]);
    record("display matching forwards the complete rectangle to Electron", matching.value);

    const nativeError = new Error("fixture native screen failure");
    const originalPrimary = screen.getPrimaryDisplay;
    const failed = yield* Effect.exit(
      Effect.sync(() => {
        screen.getPrimaryDisplay = () => {
          throw nativeError;
        };
      }).pipe(
        Effect.andThen(Screen.primary),
        Effect.ensuring(
          Effect.sync(() => {
            screen.getPrimaryDisplay = originalPrimary;
          }),
        ),
      ),
    );
    const error = failure(failed);
    assert.equal(error.code, "Native");
    assert.equal(error.cause, nativeError);
    record("native query failures preserve SewedError and the original cause", {
      code: error.code,
    });

    const originalNearest = screen.getDisplayNearestPoint;
    const originalMatching = screen.getDisplayMatching;
    let invalidNativeCalls = 0;
    yield* Effect.gen(function* () {
      screen.getDisplayNearestPoint = (...args) => {
        invalidNativeCalls += 1;
        return originalNearest.apply(screen, args);
      };
      screen.getDisplayMatching = (...args) => {
        invalidNativeCalls += 1;
        return originalMatching.apply(screen, args);
      };
      const invalid = [
        Screen.nearest({ x: 1.5, y: 0 }),
        Screen.nearest({ x: 2 ** 31, y: 0 }),
        Screen.nearest({ x: 0, y: Number.NaN }),
        Screen.matching({ x: 0, y: 0, width: -1, height: 10 }),
        Screen.matching({ width: 10, height: 10 }),
        Screen.matching({ x: 0, y: 0, width: 10, height: Number.POSITIVE_INFINITY }),
      ];
      for (const operation of invalid) {
        const error = failure(yield* Effect.exit(operation));
        assert.equal(error.code, "Native");
        assert.equal(error.cause._tag, "SchemaError");
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          screen.getDisplayNearestPoint = originalNearest;
          screen.getDisplayMatching = originalMatching;
        }),
      ),
    );
    assert.equal(invalidNativeCalls, 0);
    record("invalid coordinates fail before any native query", { invalidNativeCalls });

    const first = yield* observe(Screen.changes);
    const second = yield* observe(Screen.changes);
    yield* waitListeners(2);
    assert.deepEqual(first.values, []);
    assert.deepEqual(second.values, []);
    const sample = screen.getPrimaryDisplay();
    const expectedDisplay = project(sample);
    const metrics = ["bounds", "workArea", "scaleFactor", "rotation"];
    screen.emit("display-added", {}, sample);
    screen.emit("display-metrics-changed", {}, sample, metrics);
    screen.emit("display-removed", {}, sample);
    sample.bounds.x += 10;
    sample.workArea.width += 10;
    metrics.push("changed-after-emission");
    yield* waitUntil(
      () => first.values.length === 3 && second.values.length === 3,
      "display notifications",
    );
    const expected = [
      { kind: "added", display: expectedDisplay },
      {
        kind: "metrics",
        display: expectedDisplay,
        metrics: ["bounds", "workArea", "scaleFactor", "rotation"],
      },
      { kind: "removed", display: expectedDisplay },
    ];
    assert.deepEqual(first.values, expected);
    assert.deepEqual(second.values, expected);
    record("independent observers receive ordered, captured display notifications without replay", {
      injected: true,
      values: first.values,
    });

    yield* Fiber.interrupt(first.fiber);
    yield* waitListeners(1);
    screen.emit("display-added", {}, screen.getPrimaryDisplay());
    yield* waitUntil(() => second.values.length === 4, "remaining observer receives notification");
    assert.equal(first.values.length, 3);
    record("cancelling one screen observer leaves the other subscribed", {
      first: first.values.length,
      second: second.values.length,
    });
    const once = yield* observe(Screen.changes.pipe(Stream.take(1)));
    yield* waitListeners(2);
    assert.deepEqual(once.values, []);
    screen.emit("display-added", {}, screen.getPrimaryDisplay());
    assert.equal((yield* Fiber.await(once.fiber))._tag, "Success");
    yield* waitListeners(1);
    yield* Fiber.interrupt(second.fiber);
    assert.deepEqual(listeners(), baseline);
    record("normal completion and cancellation remove the exact native listeners");

    const subscriptionScope = yield* Scope.fork(yield* Effect.scope);
    const owned = yield* observe(Screen.changes).pipe(Scope.provide(subscriptionScope));
    yield* waitListeners(1);
    yield* Scope.close(subscriptionScope, Exit.void);
    assert.ok(owned.exit);
    assert.deepEqual(listeners(), baseline);
    record("owning scope closure releases screen subscriptions", { exit: owned.exit._tag });

    const originalOn = screen.on;
    const registrationError = new Error("fixture partial listener registration");
    const registration = yield* Effect.exit(
      Effect.sync(() => {
        screen.on = (event, listener) => {
          if (event === "display-removed") throw registrationError;
          return originalOn.call(screen, event, listener);
        };
      }).pipe(
        Effect.andThen(Stream.runDrain(Screen.changes).pipe(Effect.timeout(8_000))),
        Effect.ensuring(
          Effect.sync(() => {
            screen.on = originalOn;
          }),
        ),
      ),
    );
    const registrationFailure = failure(registration);
    assert.equal(registrationFailure.code, "Native");
    assert.equal(registrationFailure.cause, registrationError);
    assert.deepEqual(listeners(), baseline);
    record("partial registration failure releases listeners acquired before the failure");

    const gate = { started: yield* Deferred.make(), release: yield* Deferred.make() };
    const slow = yield* observe(Screen.changes, gate);
    const fast = yield* observe(Screen.changes);
    yield* waitListeners(2);
    const current = screen.getPrimaryDisplay();
    screen.emit("display-added", {}, current);
    yield* Deferred.await(gate.started);
    yield* waitUntil(() => fast.values.length === 1, "fast observer initial notification");
    for (let i = 0; i < 160; i += 1) {
      screen.emit("display-metrics-changed", {}, current, ["bounds"]);
      yield* waitUntil(() => fast.values.length === i + 2, "fast observer keeps up");
    }
    yield* Deferred.succeed(gate.release, undefined);
    const overflow = failure(yield* Fiber.await(slow.fiber));
    assert.equal(overflow.code, "Limit");
    assert.equal(slow.values.length, 129);
    assert.equal(fast.values.length, 161);
    assert.equal(fast.exit, undefined);
    yield* waitListeners(1);
    screen.emit("display-removed", {}, current);
    yield* waitUntil(() => fast.values.length === 162, "fast observer survives overflow");
    yield* Fiber.interrupt(fast.fiber);
    assert.deepEqual(listeners(), baseline);
    record("a slow screen observer fails at its queue limit without stopping another", {
      slowValues: slow.values.length,
      fastValues: fast.values.length,
      code: overflow.code,
    });

    const hostScope = yield* Scope.fork(yield* Effect.scope);
    const owner = yield* host(
      DisplayInfo,
      DisplayInfo.toLayer({
        all: () => Screen.displays,
        primary: () => Screen.primary,
        nearest: Screen.nearest,
        matching: Screen.matching,
        changes: () => Screen.changes,
      }),
    ).pipe(Scope.provide(hostScope));
    yield* Effect.gen(function* () {
      const client = yield* Displays();
      assert.deepEqual(yield* client.all(), screen.getAllDisplays().map(project));
      assert.deepEqual(yield* client.primary(), project(screen.getPrimaryDisplay()));
      assert.deepEqual(
        yield* client.nearest(cursor.value),
        project(screen.getDisplayNearestPoint(cursor.value)),
      );
      assert.deepEqual(
        yield* client.matching(captured.workArea),
        project(screen.getDisplayMatching(captured.workArea)),
      );
      record("explicitly hosted screen queries cross the public binding and schema boundary", {
        owner: owner.id,
      });
      const remote = yield* observe(client.changes());
      yield* waitListeners(1);
      screen.emit("display-metrics-changed", {}, current, ["scaleFactor"]);
      yield* waitUntil(() => remote.values.length === 1, "bound screen event");
      assert.deepEqual(remote.values[0], {
        kind: "metrics",
        display: project(current),
        metrics: ["scaleFactor"],
      });
      yield* Fiber.interrupt(remote.fiber);
      yield* waitListeners(0);
      record("bound screen event cancellation reaches its native listener scope", {
        event: remote.values[0],
      });
      const pending = yield* observe(client.changes());
      yield* waitListeners(1);
      yield* Scope.close(hostScope, Exit.void);
      const disconnected = failure(yield* Fiber.await(pending.fiber));
      assert.equal(disconnected._tag, "SewedError");
      assert.equal(disconnected.code, "Unknown");
      const closed = failure(yield* Effect.exit(client.primary()));
      assert.equal(closed._tag, "SewedError");
      assert.equal(closed.code, "Closed");
      assert.deepEqual(listeners(), baseline);
      assert.deepEqual(yield* Screen.displays, screen.getAllDisplays().map(project));
      record("closing a bound screen host disconnects clients without owning the system displays", {
        code: closed.code,
      });
    }).pipe(Effect.provide(Binding.layer([Binding.to(Displays, owner)])));
    assert.deepEqual(listeners(), baseline);
  });

  App.run(
    [],
    Effect.gen(function* () {
      yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
      const result = yield* Effect.exit(runChecks);
      console.log(
        `SCREEN_VERIFICATION ${JSON.stringify({
          success: result._tag === "Success",
          checks,
          error: result._tag === "Failure" ? Cause.pretty(result.cause) : undefined,
          platform: { os: process.platform, ozone: "x11", displayEvents: "injected" },
          listeners: counts(),
        })}`,
      );
      if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
      yield* App.quit;
    }),
  );
}

void verifyScreen().catch((error) => {
  console.error(error);
  app.exit(1);
});
