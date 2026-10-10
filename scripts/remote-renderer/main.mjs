import { Cause, Deferred, Effect, Fiber, Queue, Stream } from "effect";
import { Remote, Renderer } from "sewed";
import {
  Definition,
  MainRemote,
  RelayRemote,
  UtilityRemote,
  WorkerRemote,
  slots,
} from "../remote-contract.mjs";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

const errorText = (cause) => {
  try {
    return Cause.pretty(cause);
  } catch {
    return String(cause);
  }
};

const route = (slot, label) =>
  Effect.gen(function* () {
    const firstSeed = `${label}:alpha`;
    const secondSeed = `${label}:beta`;
    const first = yield* Remote.acquire(Definition, slot, { seed: firstSeed });
    const second = yield* Remote.acquire(Definition, slot, { seed: secondSeed });
    const firstBefore = yield* first.client.inspect();
    const secondBefore = yield* second.client.inspect();
    check(firstBefore.seed === firstSeed, `${label}: first seed changed`);
    check(secondBefore.seed === secondSeed, `${label}: second seed changed`);
    check(firstBefore.resourceId !== secondBefore.resourceId, `${label}: resources share an id`);
    check(firstBefore.value === 0 && secondBefore.value === 0, `${label}: initial state leaked`);
    check(firstBefore.placement.runtime.length > 0, `${label}: native placement missing`);

    const firstValue = yield* first.client.add({ delta: 7 });
    check(firstValue === 7, `${label}: first add returned the wrong value`);
    check((yield* first.client.read()) === 7, `${label}: first state was not retained`);
    check((yield* second.client.read()) === 0, `${label}: state crossed resource boundary`);

    const progress = yield* first.client.progress({ hold: false }).pipe(
      Stream.runFold(
        () => [],
        (values, value) => [...values, value],
      ),
    );
    check(progress.length === 3, `${label}: progress stream length changed`);
    const progressSeed = label === "relay" ? `relay:${firstSeed}` : firstSeed;
    check(
      progress[0].seed === progressSeed && progress.at(-1).step === 2,
      `${label}: progress changed`,
    );

    const releaseStarted = performance.now();
    yield* first.release;
    const releaseElapsedMs = performance.now() - releaseStarted;
    check(releaseElapsedMs >= 20, `${label}: release did not wait for the delayed finalizer`);
    yield* first.release;
    const stale = yield* first.client.read().pipe(Effect.flip);
    check(stale?.code === "Closed", `${label}: stale client was not rejected`);

    const releasedProbe = yield* Remote.acquire(Definition, slot, { seed: `${label}:released` });
    const released = yield* releasedProbe.client.inspect();
    check(
      released.released >= firstBefore.released + 1,
      `${label}: release counter did not advance`,
    );
    check(
      released.streamsFinalized >= firstBefore.streamsFinalized + 1,
      `${label}: stream finalizer counter did not advance`,
    );
    yield* releasedProbe.release;
    yield* second.release;

    return {
      label,
      first: firstBefore,
      second: secondBefore,
      released,
      progress,
      releaseElapsedMs,
    };
  });

const stalledStream = (slot) =>
  Effect.gen(function* () {
    const handle = yield* Remote.acquire(Definition, slot, { seed: "stalled-stream" });
    const firstChunk = yield* Deferred.make();
    const releaseGate = yield* Deferred.make();
    const consumer = yield* handle.client.progress({ hold: true }).pipe(
      Stream.runForEach((value) =>
        value.step === 0
          ? Deferred.succeed(firstChunk, undefined).pipe(
              Effect.andThen(Deferred.await(releaseGate)),
            )
          : Effect.void,
      ),
      Effect.forkScoped,
    );
    yield* Deferred.await(firstChunk);
    yield* Effect.sleep(75);
    const started = performance.now();
    yield* handle.release.pipe(Effect.timeout("2 seconds"));
    const elapsedMs = performance.now() - started;
    check(elapsedMs < 2_000, "release was blocked by a stalled stream from the same client");
    yield* Deferred.succeed(releaseGate, undefined);
    yield* Fiber.interrupt(consumer);
    return { elapsedMs };
  });

const saturatedRelease = (slot) =>
  Effect.gen(function* () {
    const handle = yield* Remote.acquire(Definition, slot, { seed: "saturation" });
    const blocked = yield* Deferred.make();
    const ready = yield* Deferred.make();
    let activeConsumers = 0;
    const consumers = yield* Effect.forEach(Array.from({ length: 62 }), () =>
      handle.client.progress({ hold: true }).pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            activeConsumers++;
            if (activeConsumers === 32) yield* Deferred.succeed(ready, undefined);
            yield* Deferred.await(blocked);
          }),
        ),
        Effect.forkScoped,
      ),
    );
    yield* Deferred.await(ready).pipe(Effect.timeout("3 seconds"));
    yield* Effect.sleep(75);
    const limit = yield* handle.client.read().pipe(Effect.flip, Effect.timeout("2 seconds"));
    check(limit.code === "Limit", "method admission did not reserve room for release");
    const started = performance.now();
    yield* handle.release.pipe(Effect.timeout("2 seconds"));
    const elapsedMs = performance.now() - started;
    check(elapsedMs >= 20, "saturated release skipped its delayed resource finalizer");
    yield* Fiber.interruptAll(consumers);
    const next = yield* Remote.acquire(Definition, slot, { seed: "after-saturation" });
    check((yield* next.client.read()) === 0, "saturation closed the resource owner");
    yield* next.release;
    return { outstanding: consumers.length, activeConsumers, limit: limit.code, elapsedMs };
  });

const afterReload = (state) =>
  Effect.gen(function* () {
    const rows = [];
    for (const [slot, label] of [
      [MainRemote, "reload-main"],
      [WorkerRemote, "reload-worker"],
      [UtilityRemote, "reload-utility"],
      [RelayRemote, "reload-relay"],
    ]) {
      const handle = yield* Remote.acquire(Definition, slot, { seed: label });
      const inspect = yield* handle.client.inspect();
      check((yield* handle.client.read()) === 0, `${label}: owner was not usable after reload`);
      yield* handle.release;
      rows.push(inspect);
    }
    state.afterReloadResult = { success: true, rows };
  });

Renderer.run(
  Renderer.entry(new URL(location.href), { bindings: slots }),
  Effect.gen(function* () {
    const commands = yield* Queue.make();
    const state = {
      ready: true,
      result: null,
      afterReloadResult: null,
      reloadReady: false,
      start: () => Queue.offerUnsafe(commands, "start"),
      afterReload: () => Queue.offerUnsafe(commands, "afterReload"),
    };
    window.remoteFixture = state;

    while (true) {
      const command = yield* Queue.take(commands);
      if (command === "afterReload") {
        const exit = yield* Effect.exit(afterReload(state));
        if (exit._tag === "Failure") {
          state.afterReloadResult = { success: false, error: errorText(exit.cause) };
        }
        continue;
      }

      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const rows = [];
          for (const [slot, label] of [
            [MainRemote, "main"],
            [WorkerRemote, "worker"],
            [UtilityRemote, "utility"],
            [RelayRemote, "relay"],
          ]) {
            rows.push(yield* route(slot, label));
          }
          const stalled = yield* stalledStream(WorkerRemote);
          const saturation = yield* saturatedRelease(WorkerRemote);
          const reloadLease = yield* Remote.acquire(Definition, MainRemote, {
            seed: "reload-leak",
          });
          const reloadInspect = yield* reloadLease.client.inspect();
          state.reloadReady = true;
          return { rows, stalled, saturation, reloadInspect };
        }),
      );
      state.result =
        exit._tag === "Success"
          ? { success: true, ...exit.value }
          : { success: false, error: errorText(exit.cause) };
    }
  }),
);
