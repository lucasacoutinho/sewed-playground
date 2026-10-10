import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app, BrowserWindow as NativeWindow, dialog } from "electron";
import { Cause, Effect, Exit, Fiber, Scope } from "effect";
import { Binding, Decidables, Decision, Renderer } from "sewed";
import { App, BrowserWindow, host } from "sewed/main";
import { Prompt, PromptSlot } from "./dialog-contract.mjs";

const execFileAsync = promisify(execFile);
const checks = [];
const calls = [];
let sequence = 0;
const options = (extra = {}) => ({
  title: `Sewed dialog ${process.pid} ${++sequence}`,
  message: "Native dialog verification",
  buttons: ["Cancel", "Continue"],
  defaultId: 1,
  cancelId: 0,
  ...extra,
});
const record = (name, evidence = {}) => {
  checks.push({ name, evidence: structuredClone(evidence) });
  console.log(`PASS ${name}`);
};
const waitUntil = (read, description) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const value = yield* read;
      if (value) return value;
      yield* Effect.sleep(10);
    }
    throw new Error(`Timed out: ${description}`);
  });
const nativeDialog = (title, key) =>
  Effect.promise(async () => {
    const { stdout } = await execFileAsync(
      "python3",
      ["scripts/dialog-window.py", String(process.pid), title, ...(key ? [key] : [])],
      { timeout: 2_000 },
    );
    return JSON.parse(stdout);
  });
const visibleDialog = (call) =>
  waitUntil(
    nativeDialog(call.options.title).pipe(
      Effect.map((windows) => {
        assert.ok(windows.length <= 1);
        return windows[0];
      }),
    ),
    `native dialog ${call.options.title}`,
  );
const dismissed = (call) =>
  waitUntil(
    nativeDialog(call.options.title).pipe(
      Effect.map((windows) => call.settled && windows.length === 0),
    ),
    `native dialog dismissal ${call.options.title}`,
  );
const failure = (exit) => {
  assert.equal(exit._tag, "Failure");
  const error = Cause.findErrorOption(exit.cause);
  assert.equal(error._tag, "Some", Cause.pretty(exit.cause));
  return error.value;
};
const nextCall = (count) =>
  waitUntil(
    Effect.sync(() => calls.length > count && calls[count]),
    "native message box invocation",
  );
const start = (operation) =>
  Effect.gen(function* () {
    const count = calls.length;
    const fiber = yield* Effect.forkScoped(operation);
    const call = yield* nextCall(count);
    return { fiber, call };
  });
const respond = (request, key) =>
  Effect.gen(function* () {
    const native = yield* visibleDialog(request.call);
    assert.equal(native.parent, request.call.parent.getNativeWindowHandle().readUInt32LE(0));
    yield* nativeDialog(request.call.options.title, key);
    const result = yield* Fiber.join(request.fiber).pipe(Effect.timeout(8_000));
    yield* dismissed(request.call);
    assert.deepEqual(result, request.call.result);
    return { native, result };
  });
const makeWindow = (name) =>
  Effect.gen(function* () {
    const title = `Sewed dialog parent ${process.pid} ${name}`;
    const handle = yield* BrowserWindow.make({ title, width: 500, height: 300 });
    const native = NativeWindow.getAllWindows().find((window) => window.getTitle() === title);
    assert.ok(native);
    return { handle, native };
  });
const replaceMessageBox = (replacement, program) =>
  Effect.scoped(
    Effect.gen(function* () {
      const original = dialog.showMessageBox;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          dialog.showMessageBox = replacement;
        }),
        () =>
          Effect.sync(() => {
            dialog.showMessageBox = original;
          }),
      );
      return yield* program;
    }),
  );

const runChecks = Effect.gen(function* () {
  const original = dialog.showMessageBox;
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      dialog.showMessageBox = (parent, settings) => {
        const call = { parent, options: settings, settled: false };
        calls.push(call);
        const pending = original.call(dialog, parent, settings);
        void pending.then(
          (result) => {
            call.result = result;
            call.settled = true;
          },
          (error) => {
            call.error = error;
            call.settled = true;
          },
        );
        return pending;
      };
    }),
    () =>
      Effect.sync(() => {
        dialog.showMessageBox = original;
      }),
  );
  const first = yield* makeWindow("first");
  const second = yield* makeWindow("second");
  const initialOptions = options({ checkbox: { label: "Remember", checked: true } });
  const definition = first.handle.dialog.message(initialOptions);
  assert.equal(calls.length, 0);
  record("window dialog definitions are inert");

  const request = yield* start(definition);
  assert.equal(request.call.parent, first.native);
  assert.notEqual(request.call.options.buttons, initialOptions.buttons);
  initialOptions.buttons[1] = "Changed after invocation";
  assert.deepEqual(request.call.options.buttons, ["Cancel", "Continue"]);
  assert.equal(request.call.options.checkboxLabel, "Remember");
  assert.equal(request.call.options.checkboxChecked, true);
  const accepted = yield* respond(request, "Return");
  assert.deepEqual(accepted.result, { response: 1, checkboxChecked: true });
  assert.equal(request.call.options.signal.aborted, false);
  record("Return selects the native default button and preserves checkbox state", accepted);

  const escaped = yield* start(first.handle.dialog.message(options()));
  const cancelledByUser = yield* respond(escaped, "Escape");
  assert.deepEqual(cancelledByUser.result, { response: 0, checkboxChecked: false });
  record(
    "Escape returns the native cancel button as an ordinary successful result",
    cancelledByUser,
  );

  const cancelled = yield* start(first.handle.dialog.message(options()));
  yield* visibleDialog(cancelled.call);
  yield* Fiber.interrupt(cancelled.fiber);
  const cancelledExit = yield* Fiber.await(cancelled.fiber);
  assert.equal(cancelledExit._tag, "Failure");
  assert.equal(Cause.hasInterruptsOnly(cancelledExit.cause), true);
  yield* dismissed(cancelled.call);
  assert.equal(cancelled.call.options.signal.aborted, true);
  assert.equal(first.native.isDestroyed(), false);
  record(
    "request interruption aborts and dismisses a real native dialog without closing its parent",
  );

  const one = yield* start(first.handle.dialog.message(options()));
  yield* visibleDialog(one.call);
  const beforeCompeting = calls.length;
  const competing = failure(yield* Effect.exit(second.handle.dialog.message(options())));
  assert.equal(competing.code, "Limit");
  assert.equal(calls.length, beforeCompeting);
  assert.equal(one.call.options.signal.aborted, false);
  yield* Fiber.interrupt(one.fiber);
  assert.equal(one.call.options.signal.aborted, true);
  yield* dismissed(one.call);
  const two = yield* start(second.handle.dialog.message(options()));
  assert.notEqual(one.call.options.signal, two.call.options.signal);
  const remaining = yield* respond(two, "Return");
  record(
    "competing requests fail with Limit and a later request selects its own parent after dismissal",
    remaining,
  );

  const realMessageBox = dialog.showMessageBox;
  let releaseCompletion;
  const completion = new Promise((resolve) => {
    releaseCompletion = resolve;
  });
  let delayedResponse;
  yield* replaceMessageBox(
    (parent, settings) => {
      delayedResponse = realMessageBox(parent, settings).then((result) =>
        completion.then(() => result),
      );
      return delayedResponse;
    },
    Effect.gen(function* () {
      const delayed = yield* start(first.handle.dialog.message(options()));
      yield* visibleDialog(delayed.call);
      yield* Fiber.interrupt(delayed.fiber);
      yield* dismissed(delayed.call);
      const beforePending = calls.length;
      const busy = failure(yield* Effect.exit(second.handle.dialog.message(options())));
      assert.equal(busy.code, "Limit");
      assert.equal(calls.length, beforePending);
      releaseCompletion();
      yield* Effect.promise(() => delayedResponse);
    }).pipe(Effect.ensuring(Effect.sync(() => releaseCompletion()))),
  );
  const afterCompletion = yield* start(second.handle.dialog.message(options()));
  yield* respond(afterCompletion, "Return");
  record("interruption retains admission until the native promise settles", {
    completionDelayInjected: true,
  });

  const requestScope = yield* Scope.fork(yield* Effect.scope);
  const scoped = yield* start(first.handle.dialog.message(options())).pipe(
    Scope.provide(requestScope),
  );
  yield* visibleDialog(scoped.call);
  yield* Scope.close(requestScope, Exit.void);
  yield* dismissed(scoped.call);
  assert.equal(scoped.call.options.signal.aborted, true);
  assert.equal(first.native.isDestroyed(), false);
  record("caller scope closure dismisses its dialog and preserves the window");

  const closing = yield* makeWindow("native close");
  const pendingClose = yield* start(closing.handle.dialog.message(options()));
  yield* visibleDialog(pendingClose.call);
  closing.native.destroy();
  const closeError = failure(yield* Fiber.await(pendingClose.fiber).pipe(Effect.timeout(8_000)));
  assert.equal(closeError.code, "Closed");
  yield* dismissed(pendingClose.call);
  record("native parent closure fails an outer request with Closed and dismisses the dialog");

  const windowScope = yield* Scope.fork(yield* Effect.scope);
  const owned = yield* makeWindow("scope close").pipe(Scope.provide(windowScope));
  const pendingOwner = yield* start(owned.handle.dialog.message(options()));
  yield* visibleDialog(pendingOwner.call);
  yield* Scope.close(windowScope, Exit.void);
  assert.equal(failure(yield* Fiber.await(pendingOwner.fiber)).code, "Closed");
  yield* dismissed(pendingOwner.call);
  const beforeClosed = calls.length;
  assert.equal(failure(yield* Effect.exit(owned.handle.dialog.message(options()))).code, "Closed");
  assert.equal(calls.length, beforeClosed);
  record(
    "window scope closure ends pending dialogs and rejects later calls without native invocation",
  );

  const invalid = [
    { message: "Invalid", buttons: [] },
    { message: 3, buttons: ["OK"] },
    { message: "Invalid", buttons: ["OK"], defaultId: 1 },
    { message: "Invalid", buttons: ["OK"], cancelId: -1 },
    { message: "Invalid", buttons: ["OK"], cancelId: 0.5 },
    { message: "Invalid", buttons: ["OK"], type: "unsupported" },
    { message: "Invalid", buttons: ["OK"], checkbox: { checked: true } },
    { message: "Invalid", buttons: ["OK"], checkbox: { label: "", checked: true } },
  ];
  const beforeInvalid = calls.length;
  for (const value of invalid) {
    const error = failure(yield* Effect.exit(first.handle.dialog.message(value)));
    assert.equal(error.code, "Protocol");
    assert.equal(error.cause._tag, "SchemaError");
  }
  assert.equal(calls.length, beforeInvalid);
  record("invalid dialog options fail before native invocation", { inputs: invalid.length });

  const controller = new AbortController();
  controller.abort();
  const override = yield* start(
    first.handle.dialog.message(
      options({
        signal: controller.signal,
        parent: second.native,
      }),
    ),
  );
  assert.equal(override.call.parent, first.native);
  assert.notEqual(override.call.options.signal, controller.signal);
  assert.equal(override.call.options.signal.aborted, false);
  yield* visibleDialog(override.call);
  yield* Fiber.interrupt(override.fiber);
  yield* dismissed(override.call);
  record("untyped extra options cannot replace the native parent or request abort signal");

  const nativeError = new Error("fixture message box failure");
  for (const nativeFailure of [
    () => {
      throw nativeError;
    },
    () => Promise.reject(nativeError),
  ]) {
    const exit = yield* replaceMessageBox(
      nativeFailure,
      Effect.exit(first.handle.dialog.message(options())),
    );
    const error = failure(exit);
    assert.equal(error.code, "Native");
    assert.equal(error.cause, nativeError);
  }
  record("native throws and rejected promises retain SewedError Native and the original cause", {
    injected: true,
  });

  const ownerScope = yield* Scope.fork(yield* Effect.scope);
  const owner = yield* host(
    Prompt,
    Prompt.toLayer({ ask: () => first.handle.dialog.message(options()) }),
  ).pipe(Scope.provide(ownerScope));
  yield* Effect.gen(function* () {
    const client = yield* PromptSlot();
    const bound = yield* start(client.ask());
    assert.equal(bound.call.parent, first.native);
    const result = yield* respond(bound, "Return");
    record(
      "an explicitly bound prompt returns a real native response through public RPC schemas",
      result,
    );

    const cancelled = yield* start(client.ask());
    yield* visibleDialog(cancelled.call);
    yield* Fiber.interrupt(cancelled.fiber);
    yield* dismissed(cancelled.call);
    assert.equal(cancelled.call.options.signal.aborted, true);
    record("RPC request cancellation reaches the native dialog abort signal");

    const pending = yield* start(client.ask());
    yield* visibleDialog(pending.call);
    yield* Scope.close(ownerScope, Exit.void);
    const error = failure(yield* Fiber.await(pending.fiber));
    assert.equal(error._tag, "SewedError");
    assert.equal(error.code, "Unknown");
    yield* dismissed(pending.call);
    assert.equal(first.native.isDestroyed(), false);
    const stale = failure(yield* Effect.exit(client.ask()));
    assert.equal(stale.code, "Closed");
    record(
      "host scope closure dismisses pending bound dialogs with Unknown and closes future calls with Closed",
    );
  }).pipe(Effect.provide(Binding.layer([Binding.to(PromptSlot, owner)])));

  const rendererOwner = yield* host(
    Prompt,
    Prompt.toLayer({ ask: () => second.handle.dialog.message(options()) }),
  );
  const entry = Renderer.entry(
    new URL("../.artifacts/dialog-renderer/index.html", import.meta.url),
    { bindings: [PromptSlot] },
  );
  yield* second.handle.webContents.load(entry, {
    bindings: [Binding.to(PromptSlot, rendererOwner)],
  });
  const evaluate = (source) =>
    Effect.promise(() => second.native.webContents.executeJavaScript(source));
  yield* waitUntil(evaluate("Boolean(window.dialogFixture)"), "renderer prompt client");
  let before = calls.length;
  yield* evaluate("window.dialogFixture.start()");
  const fromRenderer = yield* nextCall(before);
  assert.equal(fromRenderer.parent, second.native);
  yield* visibleDialog(fromRenderer);
  yield* nativeDialog(fromRenderer.options.title, "Return");
  const rendererResult = yield* waitUntil(
    evaluate("window.dialogFixture.results[0]"),
    "renderer response",
  );
  assert.deepEqual(rendererResult, {
    status: "success",
    value: { response: 1, checkboxChecked: false },
  });
  yield* dismissed(fromRenderer);
  record(
    "a real renderer receives the selected native dialog response through its binding",
    rendererResult,
  );

  before = calls.length;
  yield* evaluate("window.dialogFixture.start()");
  const rendererCancelled = yield* nextCall(before);
  yield* visibleDialog(rendererCancelled);
  yield* evaluate("window.dialogFixture.cancel()");
  yield* dismissed(rendererCancelled);
  const rendererExit = yield* waitUntil(
    evaluate("window.dialogFixture.results[1]"),
    "renderer cancellation",
  );
  assert.deepEqual(rendererExit, { status: "failure", interrupted: true });
  record(
    "renderer cancellation dismisses the native dialog and remains interruption",
    rendererExit,
  );

  before = calls.length;
  yield* evaluate("window.dialogFixture.start()");
  const reloaded = yield* nextCall(before);
  yield* visibleDialog(reloaded);
  yield* second.handle.webContents.reload;
  yield* dismissed(reloaded);
  yield* waitUntil(
    evaluate("Boolean(window.dialogFixture) && window.dialogFixture.results.length === 0"),
    "fresh renderer document",
  );
  assert.equal(second.native.isDestroyed(), false);
  before = calls.length;
  yield* evaluate("window.dialogFixture.start()");
  const fresh = yield* nextCall(before);
  assert.equal(fresh.parent, second.native);
  yield* visibleDialog(fresh);
  yield* nativeDialog(fresh.options.title, "Escape");
  const freshResult = yield* waitUntil(
    evaluate("window.dialogFixture.results[0]"),
    "fresh document prompt",
  );
  assert.deepEqual(freshResult, {
    status: "success",
    value: { response: 0, checkboxChecked: false },
  });
  yield* dismissed(fresh);
  record(
    "document reload dismisses its old prompt and the fresh document keeps the same selected parent",
  );
  assert.ok(calls.every((call) => call.settled));
});

App.run(
  [],
  Effect.gen(function* () {
    yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
    const result = yield* Effect.exit(runChecks);
    console.log(
      `DIALOG_VERIFICATION ${JSON.stringify({
        success: result._tag === "Success",
        checks,
        error: result._tag === "Failure" ? Cause.pretty(result.cause) : undefined,
        platform: {
          os: process.platform,
          ozone: "x11",
          nativeResponses: "Return/Escape through X11",
        },
        nativeInvocations: calls.length,
        settledInvocations: calls.filter((call) => call.settled).length,
      })}`,
    );
    if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
    yield* App.quit;
  }),
);
