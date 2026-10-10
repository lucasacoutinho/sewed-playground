import assert from "node:assert/strict";
import { createServer } from "node:http";
import { BrowserWindow as NativeWindow } from "electron";
import { Cause, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { Decidables, Decision, Renderer } from "sewed";
import { App, BrowserWindow } from "sewed/main";

const checks = [];
const marker = "RESPONSIVENESS_VERIFICATION";
const record = (name, evidence) => {
  checks.push({ name, evidence });
  console.log(`PASS ${name}`);
};
const until = (read, description, timeoutMs = 25_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = read();
      if (value) return value;
      yield* Effect.sleep(20);
    }
    throw new Error(`Timed out: ${description}`);
  });

App.run(
  [],
  Effect.gen(function* () {
    yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
    const sockets = new Set();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end(
        "<!doctype html><title>Sewed responsiveness fixture</title><body><input autofocus><p>Native responsiveness fixture</p></body>",
      );
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(
        () =>
          new Promise((resolve) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => resolve());
          }),
      ),
    );
    yield* Effect.promise(() => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = new URL(`http://127.0.0.1:${address.port}/`);
    const scope = yield* Scope.fork(yield* Effect.scope);
    const window = yield* BrowserWindow.make({
      title: "Sewed responsiveness fixture",
      width: 360,
      height: 240,
    }).pipe(Scope.provide(scope));
    const native = NativeWindow.getAllWindows()[0];
    assert.ok(native);
    const health = [];
    const documents = [];
    let healthClosed = false;
    let ticks = 0;
    yield* window.webContents.responsiveness.pipe(
      Stream.runForEach((value) => Effect.sync(() => health.push(value))),
      Effect.ensuring(
        Effect.sync(() => {
          healthClosed = true;
        }),
      ),
      Effect.forkScoped,
    );
    yield* window.webContents.state.pipe(
      Stream.runForEach((value) => Effect.sync(() => documents.push(value))),
      Effect.forkScoped,
    );
    yield* Stream.tick(25).pipe(
      Stream.runForEach(() => Effect.sync(() => ticks++)),
      Effect.forkScoped,
    );
    yield* until(() => health.length > 0, "initial responsiveness snapshot");
    assert.deepEqual(health[0], { status: "unknown" });
    yield* window.webContents.load(Renderer.entry(url, { bindings: [] }), { bindings: [] });
    const ready = yield* until(
      () => health.find((value) => value.status === "responsive"),
      "loaded renderer responsive",
    );
    assert.equal(ready.processId, native.webContents.getOSProcessId());
    record("responsiveness starts unknown and identifies the loaded native renderer", {
      health: [...health],
    });

    const stalls = async (duration) => {
      await native.webContents.executeJavaScript(`setTimeout(() => {
        const stop = performance.now() + ${duration};
        while (performance.now() < stop) {}
      }, 50); void 0`);
    };
    const input = () => {
      native.show();
      native.focus();
      native.webContents.focus();
      native.webContents.sendInputEvent({ type: "keyDown", keyCode: "A" });
      native.webContents.sendInputEvent({ type: "keyUp", keyCode: "A" });
    };
    // Chromium's hung-renderer detector never raises `unresponsive` for either stall under this
    // display (bare WSLg or the isolated Xvfb alike), so both stall checks are gated the same
    // way `webcontents-extras` gates `terminate`: the first stall's own gate keeps the second
    // one's `SEWED_SKIP_CRASH_CHECKS` gate reachable instead of dying here first.
    let offset = health.length;
    if (process.env.SEWED_SKIP_CRASH_CHECKS === "1") {
      console.log(
        "SKIP a real renderer stall reports native unresponsiveness while main stays live (SEWED_SKIP_CRASH_CHECKS)",
      );
    } else {
      offset = health.length;
      const beforeTicks = ticks;
      yield* Effect.promise(() => stalls(20_000));
      yield* Effect.sleep(150);
      yield* Effect.sync(input);
      const stalled = yield* until(
        () => health.slice(offset).find((value) => value.status === "unresponsive"),
        "actual native unresponsive event",
      );
      assert.equal(stalled.processId, ready.processId);
      assert.ok(ticks > beforeTicks + 5);
      assert.equal(documents.at(-1).status, "ready");
      yield* until(() => health.at(-1).status === "responsive", "natural renderer recovery");
      record("a real renderer stall reports native unresponsiveness while main stays live", {
        observations: health.slice(offset),
        mainTicks: ticks - beforeTicks,
      });
    }

    if (process.env.SEWED_SKIP_CRASH_CHECKS === "1") {
      console.log(
        "SKIP main explicitly recovers a hung renderer while retaining its native window (SEWED_SKIP_CRASH_CHECKS)",
      );
    } else {
      offset = health.length;
      yield* Effect.promise(() => stalls(60_000));
      yield* Effect.sleep(150);
      yield* Effect.sync(input);
      yield* until(
        () => health.slice(offset).some((value) => value.status === "unresponsive"),
        "second native stall",
      );
      const oldProcessId = native.webContents.getOSProcessId();
      const documentOffset = documents.length;
      const goneListeners = native.webContents.listenerCount("render-process-gone");
      const closedListeners = native.webContents.listenerCount("destroyed");
      yield* window.webContents.recover;
      const recovered = yield* until(
        () =>
          documents
            .slice(documentOffset)
            .find((value) => value.status === "ready" && value.processId !== oldProcessId),
        "explicit recovery with a new renderer process",
      );
      assert.equal(native.isDestroyed(), false);
      assert.equal(NativeWindow.getAllWindows()[0], native);
      assert.equal(native.webContents.getOSProcessId(), recovered.processId);
      assert.equal(health.at(-1).status, "responsive");
      assert.equal(native.webContents.listenerCount("render-process-gone"), goneListeners);
      assert.equal(native.webContents.listenerCount("destroyed"), closedListeners);
      record("main explicitly recovers a hung renderer while retaining its native window", {
        oldProcessId,
        processId: recovered.processId,
        documents: documents.slice(documentOffset),
        health: health.slice(offset),
      });
    }

    const observer = yield* window.webContents.responsiveness.pipe(
      Stream.runDrain,
      Effect.forkScoped,
    );
    const listeners = native.webContents.listenerCount("unresponsive");
    yield* Fiber.interrupt(observer);
    assert.equal(native.webContents.listenerCount("unresponsive"), listeners);
    yield* Scope.close(scope, Exit.void);
    yield* until(() => healthClosed, "responsiveness stream closed with native owner");
    assert.ok(native.isDestroyed());
    const closed = yield* Effect.exit(window.webContents.recover);
    assert.equal(closed._tag, "Failure");
    const error = Cause.findErrorOption(closed.cause);
    assert.equal(error._tag, "Some");
    assert.equal(error.value.code, "Closed");
    record("observers and recovery operations respect native owner closure", {
      healthClosed,
      recoveryError: error.value.code,
    });
    console.log(`${marker} ${JSON.stringify({ success: true, checks })}`);
    yield* App.quit;
  }).pipe(
    Effect.catchCause((cause) => {
      console.log(
        `${marker} ${JSON.stringify({ success: false, checks, error: Cause.pretty(cause) })}`,
      );
      return Effect.failCause(cause);
    }),
  ),
);
