import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BrowserWindow as NativeWindow, Menu as NativeMenu } from "electron";
import { Cause, Effect, Exit, Fiber, Scope } from "effect";
import { Binding, Decidables, Decision, Renderer } from "sewed";
import { App, BrowserWindow, host } from "sewed/main";
import { ContextMenu, ContextMenuSlot } from "./menu-contract.mjs";

const execFileAsync = promisify(execFile);
const checks = [];
const calls = [];
const options = () => ({
  items: [{ kind: "command", id: "inspect", label: "Inspect" }],
  position: { x: 24, y: 24 },
});
const record = (name, evidence = {}) => {
  checks.push({ name, evidence: structuredClone(evidence) });
  console.log(`PASS ${name}`);
};
const waitUntil = (read, description) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      const value = yield* read;
      if (value) return value;
      yield* Effect.sleep(10);
    }
    throw new Error(`Timed out: ${description}`);
  });
const nativeMenu = (parentId, key) =>
  Effect.promise(async () => {
    const { stdout } = await execFileAsync(
      "python3",
      ["scripts/menu-window.py", String(process.pid), String(parentId), ...(key ? [key] : [])],
      { timeout: 2_000 },
    );
    return JSON.parse(stdout);
  });
const visible = (call) =>
  waitUntil(
    nativeMenu(call.parentId).pipe(
      Effect.map((windows) => {
        if (windows.length === 0) return false;
        call.windows = windows.map(({ window }) => window);
        return windows;
      }),
    ),
    "native popup visibility",
  );
const dismissed = (call) =>
  waitUntil(
    nativeMenu(call.parentId).pipe(
      Effect.map(
        (windows) => call.closed && !windows.some(({ window }) => call.windows.includes(window)),
      ),
    ),
    "native popup dismissal",
  );
const failure = (exit) => {
  assert.equal(exit._tag, "Failure");
  const error = Cause.findErrorOption(exit.cause);
  assert.equal(error._tag, "Some", Cause.pretty(exit.cause));
  return error.value;
};
const nextCall = (count) =>
  waitUntil(
    Effect.sync(() => calls[count]),
    "native popup invocation",
  );
const focusParent = (parent) =>
  Effect.gen(function* () {
    yield* parent.handle.show;
    yield* parent.handle.focus;
    yield* waitUntil(
      nativeMenu(parent.nativeId, "focus").pipe(
        Effect.as(true),
        Effect.catchCause(() => Effect.succeed(false)),
      ),
      "native parent visibility",
    );
    yield* Effect.sleep(50);
  });
const start = (operation, parent, focus = true) =>
  Effect.gen(function* () {
    if (focus) yield* focusParent(parent);
    const count = calls.length;
    const fiber = yield* Effect.forkScoped(operation);
    const call = yield* nextCall(count);
    assert.equal(call.parent, parent.native);
    yield* visible(call);
    return { fiber, call };
  });
const keys = (call, sequence) =>
  Effect.forEach(sequence, (key) =>
    nativeMenu(call.parentId, key).pipe(Effect.andThen(Effect.sleep(30))),
  );
const respond = (request, sequence = ["Home", "Return"]) =>
  Effect.gen(function* () {
    yield* keys(request.call, sequence);
    const result = yield* Fiber.join(request.fiber).pipe(Effect.timeout(6_000));
    yield* dismissed(request.call);
    return result;
  });
const makeWindow = (name) =>
  Effect.gen(function* () {
    const title = `Sewed menu parent ${process.pid} ${name}`;
    const handle = yield* BrowserWindow.make({ title, width: 500, height: 320, show: false });
    const native = NativeWindow.getAllWindows().find((window) => window.getTitle() === title);
    assert.ok(native);
    const nativeId = native.getNativeWindowHandle().readUInt32LE(0);
    return { handle, native, nativeId, closedListeners: native.listeners("closed") };
  });
const replace = (target, key, replacement, program) =>
  Effect.scoped(
    Effect.gen(function* () {
      const original = target[key];
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          target[key] = replacement;
        }),
        () =>
          Effect.sync(() => {
            target[key] = original;
          }),
      );
      return yield* program;
    }),
  );

const runChecks = Effect.gen(function* () {
  const popup = NativeMenu.prototype.popup;
  const closePopup = NativeMenu.prototype.closePopup;
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      NativeMenu.prototype.closePopup = function (...args) {
        const call = calls.findLast((call) => call.native === this);
        call?.events.push("closePopup");
        return closePopup.apply(this, args);
      };
      NativeMenu.prototype.popup = function (settings) {
        const call = {
          native: this,
          parent: settings.window,
          parentId: settings.window.getNativeWindowHandle().readUInt32LE(0),
          options: settings,
          windows: [],
          closed: false,
          events: [],
        };
        calls.push(call);
        this.once("menu-will-show", () => call.events.push("show"));
        this.once("menu-will-close", () => call.events.push("will-close"));
        return popup.call(this, {
          ...settings,
          callback: () => {
            call.events.push("callback");
            call.closed = true;
            settings.callback();
          },
        });
      };
    }),
    () =>
      Effect.sync(() => {
        NativeMenu.prototype.popup = popup;
        NativeMenu.prototype.closePopup = closePopup;
      }),
  );
  const first = yield* makeWindow("first");
  const second = yield* makeWindow("second");
  const initial = options();
  const definition = first.handle.menu.popup(initial);
  assert.equal(calls.length, 0);
  record("menu Effects are inert until run in main");

  const command = yield* start(definition, first);
  initial.items[0].label = "Changed after invocation";
  assert.equal(command.call.native.getMenuItemById("inspect").label, "Inspect");
  assert.equal(command.call.options.x, 24);
  assert.equal(command.call.options.y, 24);
  const selected = yield* respond(command);
  assert.deepEqual(selected, { kind: "command", id: "inspect" });
  record(
    "real keyboard selection returns a command from the exact parent and copied template",
    selected,
  );

  const escaped = yield* start(first.handle.menu.popup({ items: options().items }), first);
  assert.equal(escaped.call.options.x, undefined);
  assert.equal(escaped.call.options.y, undefined);
  assert.deepEqual(yield* respond(escaped, ["Escape"]), { kind: "dismissed" });
  record("Escape returns dismissal and omitted coordinates retain native cursor placement");

  for (const checked of [false, true]) {
    const checkbox = yield* start(
      first.handle.menu.popup({
        items: [{ kind: "checkbox", id: "details", label: "Details", checked }],
      }),
      first,
    );
    assert.deepEqual(yield* respond(checkbox), {
      kind: "checkbox",
      id: "details",
      checked: !checked,
    });
  }
  record("native checkbox selection reports both checked and unchecked results");

  const nested = yield* start(
    first.handle.menu.popup({
      items: [
        { kind: "command", id: "disabled", label: "Unavailable", enabled: false },
        { kind: "separator" },
        {
          kind: "submenu",
          label: "Mode",
          items: [
            { kind: "radio", id: "one", label: "One", checked: true },
            { kind: "radio", id: "two", label: "Two", checked: false },
          ],
        },
      ],
    }),
    first,
  );
  assert.deepEqual(yield* respond(nested, ["Home", "Right", "Home", "Down", "Return"]), {
    kind: "radio",
    id: "two",
  });
  assert.equal(nested.call.native.getMenuItemById("one").checked, false);
  assert.equal(nested.call.native.getMenuItemById("two").checked, true);
  record("keyboard navigation skips disabled items and selects a radio item in a native submenu");

  const interrupted = yield* start(first.handle.menu.popup(options()), first);
  yield* Fiber.interrupt(interrupted.fiber);
  const interruptedExit = yield* Fiber.await(interrupted.fiber);
  assert.equal(interruptedExit._tag, "Failure");
  assert.equal(Cause.hasInterruptsOnly(interruptedExit.cause), true);
  yield* dismissed(interrupted.call);
  assert.equal(first.native.isDestroyed(), false);
  record("interruption dismisses the native popup while preserving its parent");

  const requestScope = yield* Scope.fork(yield* Effect.scope);
  yield* focusParent(first);
  let count = calls.length;
  yield* first.handle.menu.popup(options()).pipe(Effect.forkScoped, Scope.provide(requestScope));
  const scoped = yield* nextCall(count);
  yield* visible(scoped);
  yield* Scope.close(requestScope, Exit.void);
  yield* dismissed(scoped);
  record("closing the caller scope dismisses its popup");

  const previous = yield* start(first.handle.menu.popup(options()), first);
  count = calls.length;
  assert.equal(failure(yield* Effect.exit(second.handle.menu.popup(options()))).code, "Limit");
  assert.equal(calls.length, count);
  assert.deepEqual(yield* respond(previous), { kind: "command", id: "inspect" });
  const next = yield* start(second.handle.menu.popup(options()), second);
  assert.notEqual(previous.call.native, next.call.native);
  assert.deepEqual(yield* respond(next), { kind: "command", id: "inspect" });
  record(
    "competing popups fail with Limit and another parent can open a fresh menu after dismissal",
  );

  const observedPopup = NativeMenu.prototype.popup;
  let completeNative;
  yield* replace(
    NativeMenu.prototype,
    "popup",
    function (settings) {
      return observedPopup.call(this, {
        ...settings,
        callback: () => {
          completeNative = settings.callback;
        },
      });
    },
    Effect.gen(function* () {
      const delayed = yield* start(first.handle.menu.popup(options()), first);
      yield* Fiber.interrupt(delayed.fiber);
      yield* dismissed(delayed.call);
      count = calls.length;
      assert.equal(failure(yield* Effect.exit(second.handle.menu.popup(options()))).code, "Limit");
      assert.equal(calls.length, count);
      assert.equal(typeof completeNative, "function");
      completeNative();
    }),
  );
  const afterDelay = yield* start(second.handle.menu.popup(options()), second);
  assert.deepEqual(yield* respond(afterDelay), { kind: "command", id: "inspect" });
  record("interruption retains popup admission until the native close callback arrives", {
    callbackDelayInjected: true,
  });

  const closing = yield* makeWindow("native-close");
  const pending = yield* start(closing.handle.menu.popup(options()), closing);
  closing.native.destroy();
  assert.equal(failure(yield* Fiber.await(pending.fiber)).code, "Closed");
  yield* dismissed(pending.call);
  count = calls.length;
  assert.equal(failure(yield* Effect.exit(closing.handle.menu.popup(options()))).code, "Closed");
  assert.equal(calls.length, count);
  record("parent destruction closes pending and subsequent requests without recreating a window");

  const windowScope = yield* Scope.fork(yield* Effect.scope);
  const owned = yield* makeWindow("scope-close").pipe(Scope.provide(windowScope));
  const ownedRequest = yield* start(owned.handle.menu.popup(options()), owned);
  yield* Scope.close(windowScope, Exit.void);
  assert.equal(failure(yield* Fiber.await(ownedRequest.fiber)).code, "Closed");
  yield* dismissed(ownedRequest.call);
  record("closing the parent window scope also ends an externally scoped popup request");

  const invalid = [
    { items: [] },
    { items: [{ kind: "separator" }] },
    { items: [{ kind: "command", id: "", label: "Empty" }] },
    { items: [{ kind: "checkbox", id: "toggle", label: "Toggle" }] },
    { items: [{ kind: "submenu", label: "Empty", items: [] }] },
    { items: [{ kind: "submenu", label: "Empty", items: [{ kind: "separator" }] }] },
    { items: [...options().items, { kind: "submenu", label: "Nested", items: options().items }] },
    { ...options(), position: { x: 10 } },
    { ...options(), position: { x: -1, y: 0 } },
    { ...options(), position: { x: 1.5, y: 0 } },
    { ...options(), position: { x: 2 ** 31, y: 0 } },
    { items: [{ kind: "role", role: "quit" }] },
  ];
  count = calls.length;
  for (const options of invalid) {
    const error = failure(yield* Effect.exit(first.handle.menu.popup(options)));
    assert.equal(error.code, "Native");
    assert.equal(error.cause._tag, "SchemaError");
  }
  assert.equal(calls.length, count);
  record("invalid trees, duplicate IDs and malformed positions fail before native popup", {
    cases: invalid.length,
  });

  let injected = false;
  const extras = yield* start(
    first.handle.menu.popup({
      ...options(),
      window: second.native,
      callback: () => {
        injected = true;
      },
      items: [
        {
          ...options().items[0],
          role: "quit",
          click: () => {
            injected = true;
          },
        },
      ],
    }),
    first,
  );
  assert.equal(
    extras.call.native.getMenuItemById("inspect").role,
    command.call.native.getMenuItemById("inspect").role,
  );
  assert.deepEqual(yield* respond(extras), { kind: "command", id: "inspect" });
  assert.equal(injected, false);
  record("untyped native parents, roles and callbacks cannot cross the options boundary");

  const nativeError = new Error("fixture menu failure");
  for (const [target, key] of [
    [NativeMenu, "buildFromTemplate"],
    [NativeMenu.prototype, "popup"],
  ]) {
    const exit = yield* replace(
      target,
      key,
      () => {
        throw nativeError;
      },
      Effect.exit(first.handle.menu.popup(options())),
    );
    const error = failure(exit);
    assert.equal(error.code, "Native");
    assert.equal(error.cause, nativeError);
  }
  record("native construction and popup throws retain their original cause", { injected: true });

  const beforePopup = yield* makeWindow("closed-during-construction");
  const buildMenu = NativeMenu.buildFromTemplate;
  count = calls.length;
  const constructionRace = yield* replace(
    NativeMenu,
    "buildFromTemplate",
    function (template) {
      const menu = buildMenu.call(this, template);
      beforePopup.native.destroy();
      return menu;
    },
    Effect.exit(beforePopup.handle.menu.popup(options())),
  );
  assert.equal(failure(constructionRace).code, "Closed");
  assert.equal(calls.length, count);
  record("a parent lost during construction cannot fall back to another native window", {
    closureInjected: true,
  });

  const deferredParent = yield* makeWindow("deferred-popup");
  let lateCallback;
  yield* replace(
    NativeMenu.prototype,
    "popup",
    function (settings) {
      lateCallback = settings.callback;
    },
    Effect.gen(function* () {
      const deferred = yield* Effect.forkScoped(deferredParent.handle.menu.popup(options()));
      yield* waitUntil(
        Effect.sync(() => lateCallback),
        "deferred native popup registration",
      );
      yield* Fiber.interrupt(deferred);
      assert.equal(failure(yield* Effect.exit(second.handle.menu.popup(options()))).code, "Limit");
      deferredParent.native.destroy();
    }),
  );
  const afterClose = yield* start(second.handle.menu.popup(options()), second);
  lateCallback();
  assert.equal(failure(yield* Effect.exit(first.handle.menu.popup(options()))).code, "Limit");
  assert.deepEqual(yield* respond(afterClose), { kind: "command", id: "inspect" });
  record(
    "parent closure releases an undisplayed popup and a late callback cannot release a newer request",
    { nativeStartDeferred: true },
  );

  const ownerScope = yield* Scope.fork(yield* Effect.scope);
  const owner = yield* host(
    ContextMenu,
    ContextMenu.toLayer({ choose: () => first.handle.menu.popup(options()) }),
  ).pipe(Scope.provide(ownerScope));
  yield* Effect.gen(function* () {
    const client = yield* ContextMenuSlot();
    const bound = yield* start(client.choose(), first);
    assert.deepEqual(yield* respond(bound), { kind: "command", id: "inspect" });
    record(
      "an explicit binding returns a real native menu selection through the public result schema",
    );

    const cancelled = yield* start(client.choose(), first);
    yield* Fiber.interrupt(cancelled.fiber);
    yield* dismissed(cancelled.call);
    record("RPC cancellation dismisses the request's native menu");

    const pending = yield* start(client.choose(), first);
    yield* Scope.close(ownerScope, Exit.void);
    const error = failure(yield* Fiber.await(pending.fiber));
    assert.equal(error._tag, "SewedError");
    assert.equal(error.code, "Unknown");
    yield* dismissed(pending.call);
    assert.equal(first.native.isDestroyed(), false);
    assert.equal(failure(yield* Effect.exit(client.choose())).code, "Closed");
    record("host scope closure closes pending and future bound calls while preserving the parent");
  }).pipe(Effect.provide(Binding.layer([Binding.to(ContextMenuSlot, owner)])));

  const rendererOwner = yield* host(
    ContextMenu,
    ContextMenu.toLayer({ choose: () => second.handle.menu.popup(options()) }),
  );
  const entry = Renderer.entry(new URL("../.artifacts/menu-renderer/index.html", import.meta.url), {
    bindings: [ContextMenuSlot],
  });
  yield* second.handle.webContents.load(entry, {
    bindings: [Binding.to(ContextMenuSlot, rendererOwner)],
  });
  const evaluate = (source) =>
    Effect.promise(() => second.native.webContents.executeJavaScript(source));
  yield* waitUntil(evaluate("Boolean(window.menuFixture)"), "renderer menu client");
  const rendererStart = Effect.gen(function* () {
    yield* focusParent(second);
    const count = calls.length;
    yield* evaluate("window.menuFixture.start()");
    const call = yield* nextCall(count);
    assert.equal(call.parent, second.native);
    yield* visible(call);
    return call;
  });
  const fromRenderer = yield* rendererStart;
  yield* keys(fromRenderer, ["Home", "Return"]);
  const rendererResult = yield* waitUntil(
    evaluate("window.menuFixture.results[0]"),
    "renderer selection",
  );
  assert.deepEqual(rendererResult, {
    status: "success",
    value: { kind: "command", id: "inspect" },
  });
  yield* dismissed(fromRenderer);
  record(
    "a real renderer receives the selection from its explicitly chosen parent",
    rendererResult,
  );

  const rendererCancelled = yield* rendererStart;
  yield* evaluate("window.menuFixture.cancel()");
  yield* dismissed(rendererCancelled);
  const rendererExit = yield* waitUntil(
    evaluate("window.menuFixture.results[1]"),
    "renderer cancellation",
  );
  assert.deepEqual(rendererExit, { status: "failure", interrupted: true });
  record("renderer cancellation dismisses its native popup and remains interruption");

  const reloaded = yield* rendererStart;
  yield* second.handle.webContents.reload;
  yield* dismissed(reloaded);
  yield* waitUntil(
    evaluate("Boolean(window.menuFixture) && window.menuFixture.results.length === 0"),
    "fresh renderer document",
  );
  const fresh = yield* rendererStart;
  yield* keys(fresh, ["Escape"]);
  const freshResult = yield* waitUntil(
    evaluate("window.menuFixture.results[0]"),
    "fresh renderer dismissal",
  );
  assert.deepEqual(freshResult, { status: "success", value: { kind: "dismissed" } });
  yield* dismissed(fresh);
  assert.equal(second.native.isDestroyed(), false);
  record("renderer reload dismisses the old popup and the new document retains the same owner");
  assert.ok(calls.every((call) => call.closed));
  assert.deepEqual(first.native.listeners("closed"), first.closedListeners);
  assert.deepEqual(second.native.listeners("closed"), second.closedListeners);
  record("completed and interrupted popups release their parent close listeners");
});

App.run(
  [],
  Effect.gen(function* () {
    yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
    const result = yield* Effect.exit(runChecks);
    console.log(
      `MENU_VERIFICATION ${JSON.stringify({
        success: result._tag === "Success",
        checks,
        error: result._tag === "Failure" ? Cause.pretty(result.cause) : undefined,
        platform: {
          os: process.platform,
          ozone: "x11",
          nativeResponses: "X11 keyboard selection and dismissal",
        },
        popupEvents: calls.map((call) => call.events),
        nativeInvocations: calls.length,
        closedInvocations: calls.filter((call) => call.closed).length,
      })}`,
    );
    if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
    yield* App.quit;
  }),
);
