import assert from "node:assert/strict";
import { BrowserWindow as NativeWindow } from "electron";
import { Cause, Effect, Stream } from "effect";
import { Binding, Decidables, Decision, Renderer } from "sewed";
import { App, BrowserWindow, host } from "sewed/main";
import { Other, Protocol, Rejected, Values } from "./dx-contract.mjs";

const mode = process.argv.includes("--dx-development") ? "development" : "production";
const url = new URL(`../.artifacts/dx-${mode}-renderer/index.html`, import.meta.url);
const checks = [];
const active = new Map();
let acquired = 0;
let released = 0;
const record = (name, evidence = {}) => checks.push({ name, evidence });
const until = (read, description) =>
  Effect.gen(function* () {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const result = yield* read;
      if (result) return result;
      yield* Effect.sleep(10);
    }
    throw new Error(`Timed out: ${description}`);
  });

const run = Effect.gen(function* () {
  yield* Effect.scoped(
    Effect.gen(function* () {
      const plain = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new NativeWindow({
              show: false,
              webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
            }),
        ),
        (window) => Effect.sync(() => window.destroy()),
      );
      yield* Effect.promise(() => plain.loadURL(url.href));
      const error = yield* until(
        Effect.promise(() => plain.webContents.executeJavaScript("window.dx?.error")),
        "missing preload diagnostic",
      );
      assert.equal(error.code, "Startup");
      assert.match(error.message, /Load this renderer with window.webContents.load/);
      record("a page without Sewed preload receives an actionable startup error", error);
    }),
  );
  yield* Effect.scoped(
    Effect.gen(function* () {
      // No `mount`, no gate: `?mode=ungated` renders through `connect` + `RuntimeProvider`
      // directly, so the page renders on the same plain `loadURL` (no Sewed preload) that left
      // `window.dx.error` as the only signal above; `useStream` itself now answers `failure`
      // with a `Closed` cause instead of the tree never mounting.
      const plain = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new NativeWindow({
              show: false,
              webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
            }),
        ),
        (window) => Effect.sync(() => window.destroy()),
      );
      const ungated = new URL(url);
      ungated.searchParams.set("mode", "ungated");
      yield* Effect.promise(() => plain.loadURL(ungated.href));
      const rendered = yield* until(
        Effect.promise(() =>
          plain.webContents.executeJavaScript(
            "Boolean(document.querySelector('[data-revision]'))",
          ),
        ),
        "ungated page render",
      );
      assert.equal(rendered, true);
      const state = yield* until(
        Effect.promise(() =>
          plain.webContents.executeJavaScript(`(() => {
            const el = document.querySelector('[data-state]');
            return el && { status: el.dataset.state, code: el.dataset.errorCode };
          })()`),
        ),
        "ungated failure state",
      );
      assert.equal(state.status, "failure");
      assert.equal(state.code, "Closed");
      record(
        "a plain page with no Sewed preload still renders; every hook is unconditional and fails Closed",
        state,
      );
    }),
  );
  const owner = yield* host(
    Protocol,
    Protocol.toLayer({
      values: ({ key }) =>
        key === "reject"
          ? Stream.fail(new Rejected({ message: "typed stream failure" }))
          : Stream.scoped(
              Stream.unwrap(
                Effect.gen(function* () {
                  const subscription = yield* Effect.acquireRelease(
                    Effect.sync(() => {
                      const id = ++acquired;
                      active.set(id, key);
                      return id;
                    }),
                    (id) =>
                      Effect.sync(() => {
                        active.delete(id);
                        released++;
                      }),
                  );
                  return Stream.concat(Stream.make({ key, subscription }), Stream.never);
                }),
              ),
            ),
    }),
  );
  const window = yield* BrowserWindow.make({ show: false, title: "Sewed DX" });
  const native = NativeWindow.getAllWindows().find(
    (candidate) => candidate.getTitle() === "Sewed DX",
  );
  assert.ok(native);
  const evaluate = (source) => Effect.promise(() => native.webContents.executeJavaScript(source));
  const update = (change) => evaluate(`window.dx.update(${JSON.stringify(change)})`);
  const status = evaluate("document.querySelector('[data-state]')?.dataset.state");
  const content = evaluate("document.querySelector('[data-state]')?.textContent");
  const value = (key) =>
    until(
      Effect.gen(function* () {
        if ((yield* status) !== "value") return false;
        const result = JSON.parse(yield* content);
        return result.key === key && result;
      }),
      `stream value ${key}`,
    );
  const settled = () =>
    until(
      Effect.sync(() => active.size === 1 && acquired - released === 1),
      "one active subscription",
    );

  for (const [declared, bindings, messages] of [
    [
      [Values],
      [Binding.to(Other, owner)],
      ["Missing bindings: sewed/binding/dx-values", "Unexpected bindings: sewed/binding/dx-other"],
    ],
    [
      [Values, Values],
      [Binding.to(Values, owner), Binding.to(Values, owner)],
      [
        "Duplicate declarations: sewed/binding/dx-values",
        "Duplicate bindings: sewed/binding/dx-values",
      ],
    ],
  ]) {
    const error = yield* window.webContents
      .load(Renderer.entry(url, { bindings: declared }), { bindings })
      .pipe(Effect.flip);
    assert.equal(error.code, "Protocol");
    for (const message of messages) assert.ok(error.message.includes(message), error.message);
    assert.equal(native.webContents.getURL(), "");
  }
  record("main reports missing, unexpected and duplicate bindings before loading a document");

  const mismatch = new URL(url);
  mismatch.searchParams.set("mode", "mismatch");
  yield* window.webContents.load(Renderer.entry(mismatch, { bindings: [Values] }), {
    bindings: [Binding.to(Values, owner)],
  });
  const mismatchError = yield* until(evaluate("window.dx?.error"), "renderer mismatch diagnostic");
  assert.equal(mismatchError.code, "Protocol");
  assert.match(mismatchError.message, /Missing bindings: sewed\/binding\/dx-other/);
  assert.match(mismatchError.message, /Unexpected bindings: sewed\/binding\/dx-values/);
  assert.equal(acquired, 0);
  record(
    "renderer handshake reports the mismatched keys without starting component work",
    mismatchError,
  );

  const unbound = new URL(url);
  unbound.searchParams.set("mode", "unbound");
  yield* Effect.promise(() => native.webContents.loadURL(unbound.href));
  const rejectedHandshake = yield* until(
    evaluate("window.dx?.error"),
    "unbound document diagnostic",
  );
  assert.equal(rejectedHandshake.code, "Startup");
  assert.match(rejectedHandshake.message, /Renderer could not bind to main/);
  record(
    "native navigation to an unbound document retains the handshake Startup error",
    rejectedHandshake,
  );

  yield* window.webContents.load(Renderer.entry(url, { bindings: [Values] }), {
    bindings: [Binding.to(Values, owner)],
  });
  const first = yield* value("first");
  yield* settled();
  record("React subscribes through the sandboxed bridge", { mode, acquired });

  const beforeRenders = acquired;
  const beforeFactories = yield* evaluate("window.dx.factories.length");
  for (let revision = 1; revision <= 5; revision++) {
    yield* update({ revision });
    yield* until(
      evaluate(`document.querySelector('[data-revision]')?.dataset.revision === '${revision}'`),
      "committed rerender",
    );
  }
  assert.deepEqual(yield* value("first"), first);
  assert.equal(acquired, beforeRenders);
  assert.equal(yield* evaluate("window.dx.factories.length"), beforeFactories);
  record("inline factories preserve the subscription across ordinary rerenders");

  yield* update({ key: "second" });
  const second = yield* value("second");
  yield* settled();
  assert.notEqual(first.subscription, second.subscription);
  assert.deepEqual([...active.values()], ["second"]);
  record("changed dependencies replace the subscription and release the previous request");

  yield* update({ abandon: true });
  yield* until(evaluate("Boolean(document.querySelector('[data-suspended]'))"), "suspended render");
  assert.equal(yield* evaluate("window.dx.factories.includes('abandoned')"), false);
  yield* update({ abandon: false });
  assert.deepEqual(yield* value("second"), second);
  record("a render discarded by Suspense never invokes its stream factory");

  yield* update({ key: "stale", slow: true });
  yield* until(evaluate("window.dx.factories.includes('stale')"), "slow stream starts");
  yield* update({ key: "third", slow: false });
  const third = yield* value("third");
  yield* Effect.sleep(200);
  assert.deepEqual(yield* value("third"), third);
  record("late completion from a replaced stream cannot publish stale state");

  yield* update({ throws: true });
  yield* until(
    Effect.map(status, (value) => value === "failure"),
    "factory failure",
  );
  assert.match(yield* content, /stream factory failed/);
  yield* until(
    Effect.sync(() => active.size === 0),
    "failed replacement closes previous request",
  );
  record("factory exceptions become stream failure state without crashing React");

  yield* update({ throws: false, key: "reject" });
  yield* until(
    Effect.map(content, (value) => value?.includes("typed stream failure")),
    "typed failure",
  );
  assert.equal(yield* status, "failure");
  yield* update({ key: "recovered" });
  yield* value("recovered");
  yield* settled();
  record("typed failures retain their message and a dependency change starts a fresh request");

  yield* update({ mounted: false });
  yield* until(
    evaluate("Boolean(document.querySelector('[data-unmounted]'))"),
    "component unmounted",
  );
  yield* until(
    Effect.sync(() => active.size === 0),
    "unmount cleanup",
  );
  assert.equal(acquired, released);
  yield* update({ mounted: true });
  yield* value("recovered");
  yield* settled();
  record("unmount releases every request and remount subscribes again");

  yield* window.webContents.reload;
  yield* value("first");
  yield* settled();
  assert.deepEqual([...active.values()], ["first"]);
  yield* evaluate("window.dx.stop()");
  yield* until(
    Effect.sync(() => active.size === 0),
    "renderer scope cleanup",
  );
  yield* until(
    evaluate("document.getElementById('root').childElementCount === 0"),
    "React root unmounted",
  );
  assert.equal(acquired, released);
  record("document reload and renderer interruption close subscriptions and the React root", {
    acquired,
    released,
  });

  for (const { channel, response, code, message } of [
    {
      channel: "sewed:open",
      response: () => {
        throw new Error("injected open rejection");
      },
      code: "Closed",
      message: "Binding owner is unavailable",
    },
    {
      channel: "sewed:open",
      response: () => 42,
      code: "Protocol",
      message: "Could not open binding",
    },
    {
      channel: "sewed:hello",
      response: () => ({ session: 42, slots: [] }),
      code: "Protocol",
      message: "Invalid renderer handshake",
    },
  ]) {
    native.webContents.ipc.removeHandler(channel);
    native.webContents.ipc.handle(channel, response);
    yield* window.webContents.reload;
    if (channel === "sewed:hello") {
      const error = yield* until(evaluate("window.dx?.error"), "injected handshake response");
      assert.equal(error.code, code);
      assert.equal(error.message, message);
    } else {
      yield* until(
        Effect.map(status, (state) => state === "failure"),
        "injected open response",
      );
      assert.equal(
        yield* evaluate("document.querySelector('[data-state]').dataset.errorCode"),
        code,
      );
      assert.ok((yield* content).includes(message));
    }
    assert.equal(active.size, 0);
    record(`injected ${channel} failure retains ${code}: ${message}`);
  }
});

App.run(
  [],
  Effect.gen(function* () {
    yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
    const exit = yield* Effect.exit(run);
    console.log(
      `DX_VERIFICATION ${JSON.stringify({ success: exit._tag === "Success", mode, checks, error: exit._tag === "Failure" ? Cause.pretty(exit.cause) : undefined })}`,
    );
    if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause);
    yield* App.quit;
  }),
);
