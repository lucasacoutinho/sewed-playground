import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  app,
  BrowserWindow as NativeBrowserWindow,
  webContents as nativeWebContents,
} from "electron";
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Scope, Stream } from "effect";
import { Binding, Decidables, Decision, Renderer } from "sewed";
import {
  App,
  BaseWindow,
  BrowserWindow,
  Capability,
  WebContentsView,
  WindowControls,
} from "sewed/main";

const First = Binding.slot("first-window", WindowControls.protocol);
const Second = Binding.slot("second-window", WindowControls.protocol);
const checks = [];

const record = (name, evidence) => {
  checks.push({ name, evidence: structuredClone(evidence) });
  console.log(`PASS ${name}`);
};

const nativeState = (window) => ({
  bounds: window.getBounds(),
  normalBounds: window.getNormalBounds(),
  contentBounds: window.getContentBounds(),
  visible: window.isVisible(),
  focused: window.isFocused(),
  minimized: window.isMinimized(),
  maximized: window.isMaximized(),
  fullScreen: window.isFullScreen(),
  simpleFullScreen: window.isSimpleFullScreen(),
  title: window.getTitle(),
  alwaysOnTop: window.isAlwaysOnTop(),
  opacity: window.getOpacity(),
  resizable: window.isResizable(),
  movable: window.isMovable(),
  minimizable: window.isMinimizable(),
  maximizable: window.isMaximizable(),
  closable: window.isClosable(),
  fullScreenable: window.isFullScreenable(),
  menuBarVisible: window.isMenuBarVisible(),
  kiosk: window.isKiosk(),
});

const waitUntil = (read, description) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const value = read();
      if (value) return value;
      yield* Effect.sleep(10);
    }
    throw new Error(
      `Timed out: ${typeof description === "function" ? description() : description}`,
    );
  });

const observe = (stream, gate) =>
  Effect.gen(function* () {
    const observer = { values: [], exit: undefined };
    observer.fiber = yield* stream.pipe(
      Stream.runForEach((value) =>
        Effect.gen(function* () {
          observer.values.push(value);
          if (gate !== undefined && observer.values.length === 1) yield* Deferred.await(gate);
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

const matches = (actual, expected) =>
  Object.entries(expected).every(([key, value]) =>
    value !== null && typeof value === "object"
      ? matches(actual[key], value)
      : actual[key] === value,
  );

// With SEWED_SOFT_SETTLE=1 a state that never settles is reported and the fixture carries on from
// the native state, so one run on an unfamiliar desktop lists every difference instead of the
// first. The run still fails at its end.
const softSettle = process.env.SEWED_SOFT_SETTLE === "1";
const unsettled = [];
const settled = (observer, native, expected, description) =>
  softSettle
    ? Effect.catchDefect(strictlySettled(observer, native, expected, description), (defect) =>
        Effect.sync(() => {
          const text = typeof description === "function" ? description() : description;
          unsettled.push({ description: text, expected, native: nativeState(native) });
          console.log(`UNSETTLED ${text}: expected ${JSON.stringify(expected)}; ${String(defect).slice(0, 160)}`);
          return nativeState(native);
        }),
      )
    : strictlySettled(observer, native, expected, description);
const strictlySettled = (observer, native, expected, description) =>
  waitUntil(
    () => {
      const actual = nativeState(native);
      if (!matches(actual, expected)) return false;
      if (process.platform === "linux") {
        // Electron visibility can precede the window manager's map/unmap acknowledgment.
        const desktop = execFileSync("xprop", [
          "-id",
          String(native.getNativeWindowHandle().readUInt32LE(0)),
          "WM_STATE",
        ]).toString();
        if (actual.minimized && !desktop.includes("Iconic")) return false;
        if (!actual.minimized && actual.visible !== desktop.includes("Normal")) return false;
      }
      const observed = observer.values.at(-1);
      if (observed === undefined) return false;
      // X11 frame extents can change contentBounds without another native event.
      const eventState =
        process.platform === "linux"
          ? { ...actual, contentBounds: observed.contentBounds }
          : actual;
      return isDeepStrictEqual(observed, eventState) && actual;
    },
    () =>
      `${description}; native=${JSON.stringify(nativeState(native))}; observed=${JSON.stringify(observer.values)}`,
  );

const requestBounds = (operation, observer, native, requested) =>
  Effect.scoped(
    Effect.gen(function* () {
      const before = native.getBounds();
      const original = native.setBounds;
      const calls = [];
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          native.setBounds = (bounds) => {
            calls.push(structuredClone(bounds));
            return original.call(native, bounds);
          };
        }),
        () =>
          Effect.sync(() => {
            native.setBounds = original;
          }),
      );
      yield* operation;
      assert.deepEqual(calls, [requested]);
      const actual = yield* settled(
        observer,
        native,
        {
          bounds: {
            width: requested.width ?? before.width,
            height: requested.height ?? before.height,
          },
        },
        "requested geometry observed",
      );
      return { requested, actual };
    }),
  );

const makeWindow = (title) =>
  Effect.gen(function* () {
    let constructed;
    const onCreated = (_event, native) => {
      constructed = {
        native,
        listeners: Object.fromEntries(
          ["show", "hide", "focus", "blur", "move", "resize"].map((event) => [
            event,
            native.listeners(event),
          ]),
        ),
      };
    };
    const handle = yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        app.once("browser-window-created", onCreated);
      }),
      () => BrowserWindow.make({ title, show: false, width: 480, height: 320 }),
      () =>
        Effect.sync(() => {
          app.off("browser-window-created", onCreated);
        }),
    );
    assert.ok(constructed, "Electron did not report native window construction");
    // The controls owner is served into the scope the window was acquired in, so closing that
    // scope ends the owner with the window, as the window's own host used to.
    const controls = yield* Capability.serve(WindowControls.capability).pipe(
      Effect.provide(WindowControls.native(handle)),
    );
    return { handle, controls, ...constructed };
  });

const requestFocus = (operation, observer, native, description) =>
  Effect.scoped(
    Effect.gen(function* () {
      const offset = observer.values.length;
      const events = [];
      const original = native.focus;
      let invocations = 0;
      const onFocus = () => {
        events.push(nativeState(native));
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          native.on("focus", onFocus);
          native.focus = () => {
            invocations += 1;
            return original.call(native);
          };
        }),
        () =>
          Effect.sync(() => {
            native.focus = original;
            native.off("focus", onFocus);
          }),
      );
      yield* operation;
      assert.equal(invocations, 1, "focus request did not reach the selected native window");
      const current = yield* settled(
        observer,
        native,
        { visible: true },
        `${description} current state`,
      );
      return {
        nativeInvocations: invocations,
        nativeFocusEvents: events,
        observed: observer.values.slice(offset),
        current,
      };
    }),
  );

const expectCode = (exit, code) => {
  assert.equal(exit._tag, "Failure");
  const error = Cause.findErrorOption(exit.cause);
  assert.equal(error._tag, "Some", Cause.pretty(exit.cause));
  assert.equal(error.value.code, code, error.value.message);
  return error.value;
};
const failure = (exit) => {
  assert.equal(exit._tag, "Failure");
  const error = Cause.findErrorOption(exit.cause);
  assert.equal(error._tag, "Some", Cause.pretty(exit.cause));
  return error.value;
};

// Before wave 2's dcb4cd49 ("a refused payload fails Protocol naming the operation"), the bound
// client's own schema refusal reached the caller as a bare `Cause.Die` (`Error("Schema validation
// failed")`, no `SewedError`). `Binding.ts`'s `refusal` now recovers a typed `SewedError` for
// this instead: `code: "Protocol"`, the message starting with the operation's own RPC tag, and
// the `SchemaIssue.Issue` the payload actually failed kept as `cause`.
const invalidPayload = (exit, tag) => {
  const error = failure(exit);
  assert.equal(error.code, "Protocol", error.message);
  assert.match(error.message, new RegExp(`^${tag}: `), error.message);
  assert.ok(
    error.cause !== undefined && error.cause !== null,
    "the schema issue is retained as the cause",
  );
};

const runChecks = Effect.gen(function* () {
  const ownership = yield* Scope.fork(yield* Effect.scope);
  const first = yield* makeWindow("Sewed controls A").pipe(Scope.provide(ownership));
  const second = yield* makeWindow("Sewed controls B");
  const firstState = yield* observe(first.handle.state);
  const secondState = yield* observe(second.handle.state);
  yield* settled(firstState, first.native, { visible: false, focused: false }, "initial hidden A");
  yield* settled(
    secondState,
    second.native,
    { visible: false, focused: false },
    "initial hidden B",
  );
  record("hidden windows replay actual native visibility and focus", {
    first: firstState.values[0],
    second: secondState.values[0],
  });

  const firstMediaSourceId = yield* first.handle.mediaSourceId;
  assert.equal(firstMediaSourceId, first.native.getMediaSourceId());
  record("mediaSourceId matches the native window's own media source id", {
    mediaSourceId: firstMediaSourceId,
  });

  const firstContentBounds = yield* first.handle.contentBounds;
  assert.deepEqual(firstContentBounds, first.native.getContentBounds());
  record("contentBounds reads the native content area on demand", {
    contentBounds: firstContentBounds,
  });

  yield* first.handle.webContents.load(
    Renderer.entry(
      new URL(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(
            "<!doctype html><title>Sewed controls A</title><h1>Window visibility fixture</h1>",
          ),
      ),
      { bindings: [] },
    ),
    { bindings: [] },
  );
  const document = {
    url: first.native.webContents.getURL(),
    processId: first.native.webContents.getOSProcessId(),
  };
  assert.ok(document.processId > 0);

  yield* first.handle.showInactive;
  const inactive = yield* settled(
    firstState,
    first.native,
    { visible: true, focused: false },
    "showInactive A",
  );
  record("showInactive reveals a window without focusing it on X11", inactive);

  yield* second.handle.show;
  const shown = yield* settled(secondState, second.native, { visible: true }, "show B");
  record("show reveals the existing native window and reports native focus", shown);

  const focused = yield* requestFocus(first.handle.focus, firstState, first.native, "focus A");
  record("focus invokes the native owner and reports the desktop's actual decision", focused);

  yield* first.handle.hide;
  const hidden = yield* settled(
    firstState,
    first.native,
    { visible: false, focused: false },
    "hide A",
  );
  assert.equal(first.native.isDestroyed(), false);
  assert.equal(first.native.webContents.getURL(), document.url);
  assert.equal(first.native.webContents.getOSProcessId(), document.processId);
  record("hide preserves the native owner and loaded renderer document", {
    state: hidden,
    document,
    owner: first.handle.id,
  });

  const late = yield* observe(first.handle.state);
  yield* settled(late, first.native, { visible: false }, "late hidden state replay");
  assert.equal(late.values[0].visible, false);
  const hiddenWidth = first.native.getBounds().width + 1;
  yield* first.handle.setBounds({ width: hiddenWidth });
  yield* settled(
    late,
    first.native,
    { visible: false, bounds: { width: hiddenWidth } },
    "hidden resize before cancellation",
  );
  assert.ok(late.values.length >= 2);
  yield* Fiber.interrupt(late.fiber);
  const atCancellation = structuredClone(late.values);
  assert.equal(first.native.isDestroyed(), false);
  yield* first.handle.show;
  yield* settled(firstState, first.native, { visible: true }, "show A after observer cancellation");
  assert.deepEqual(late.values, atCancellation);
  record("late observers replay hidden state and cancellation leaves the owner usable", {
    replay: late.values[0],
    updatesBeforeCancellation: atCancellation.length,
    owner: first.handle.id,
  });

  const initialSecondBounds = second.native.getBounds();
  const requested = { x: 120, y: 140, width: 620, height: 460 };
  const moved = yield* requestBounds(
    first.handle.setBounds(requested),
    firstState,
    first.native,
    requested,
  );
  assert.equal(second.native.getBounds().width, initialSecondBounds.width);
  assert.equal(second.native.getBounds().height, initialSecondBounds.height);
  assert.deepEqual(moved.actual.contentBounds, first.native.getContentBounds());
  record("setBounds sends the exact native request and reports desktop-adjusted geometry", {
    ...moved,
    contentBounds: moved.actual.contentBounds,
  });

  const resizedRequest = yield* requestBounds(
    first.handle.setBounds({ width: 680 }),
    firstState,
    first.native,
    { width: 680 },
  );
  const resized = resizedRequest.actual;
  yield* requestBounds(first.handle.setBounds({}), firstState, first.native, {});
  const lateGeometry = yield* observe(first.handle.state);
  yield* settled(
    lateGeometry,
    first.native,
    { bounds: { width: 680, height: requested.height } },
    "late geometry replay",
  );
  assert.deepEqual(lateGeometry.values.at(-1), nativeState(first.native));
  yield* Fiber.interrupt(lateGeometry.fiber);
  record("partial bounds preserve omitted fields and geometry replays to late observers", resized);

  const { width, height } = first.native.getNormalBounds();
  const normalSize = { width, height };
  yield* first.handle.setFullScreen(true);
  const fullScreen = yield* settled(
    firstState,
    first.native,
    { fullScreen: true, normalBounds: normalSize },
    "direct fullscreen entry",
  );
  assert.equal(second.native.isFullScreen(), false);
  yield* first.handle.setFullScreen(false);
  const restored = yield* settled(
    firstState,
    first.native,
    // The hosted macOS runner brings a window out of fullscreen at the size it was created with
    // rather than the one it had (Electron's own behavior there, seen with this library out of
    // the picture: the handle calls `setFullScreen(false)` and nothing else), so the size is
    // only claimed where the desktop keeps it.
    process.platform === "darwin"
      ? { fullScreen: false }
      : { fullScreen: false, bounds: normalSize, normalBounds: normalSize },
    "direct fullscreen exit",
  );
  record("fullscreen transitions retain normal bounds and restore the existing window", {
    fullScreen,
    restored,
  });
  const restoredContentBounds = yield* first.handle.contentBounds;
  assert.deepEqual(restoredContentBounds, first.native.getContentBounds());

  // Task 5 (wave 4): setSimpleFullScreen is Electron's pre-Lion fullscreen; probed on Linux, it is
  // honoured there too — both isSimpleFullScreen() and isFullScreen() answer true afterwards, even
  // though the distinguishing macOS behavior (no Space) is macOS-only.
  yield* first.handle.setSimpleFullScreen(true);
  const simpleFullScreen = yield* settled(
    firstState,
    first.native,
    // On macOS simple fullscreen is its own mode: the window fills the screen without becoming
    // natively fullscreen, which is the point of it there.
    process.platform === "darwin"
      ? { simpleFullScreen: true, fullScreen: false }
      : { simpleFullScreen: true, fullScreen: true },
    "simple fullscreen entry",
  );
  yield* first.handle.setSimpleFullScreen(false);
  const simpleFullScreenRestored = yield* settled(
    firstState,
    first.native,
    { simpleFullScreen: false, fullScreen: false },
    "simple fullscreen exit",
  );
  record(
    "simple fullscreen is honoured on Linux, entering and leaving native fullscreen alongside it",
    {
      simpleFullScreen,
      simpleFullScreenRestored,
    },
  );

  yield* first.handle.maximize;
  const maximized = yield* settled(
    firstState,
    first.native,
    { maximized: true, normalBounds: normalSize },
    "maximize retains normal geometry",
  );
  yield* first.handle.restore;
  const unmaximized = yield* settled(
    firstState,
    first.native,
    { maximized: false, bounds: normalSize, normalBounds: normalSize },
    "restore normal geometry",
  );
  record("normal bounds survive native maximization and restoration", { maximized, unmaximized });

  const gate = yield* Deferred.make();
  const slow = yield* observe(
    first.handle.state.pipe(Stream.takeUntil((state) => state.bounds.width === 663)),
    gate,
  );
  yield* waitUntil(() => slow.values.length === 1, "stalled geometry observer initial value");
  for (let width = 600; width < 664; width += 1) {
    yield* first.handle.setBounds({ width });
  }
  const latest = yield* settled(
    firstState,
    first.native,
    { bounds: { ...normalSize, width: 663 } },
    "geometry burst completed",
  );
  yield* Deferred.succeed(gate, undefined);
  yield* waitUntil(
    () => slow.exit,
    () => `stalled observer completion; observed=${JSON.stringify(slow.values)}`,
  );
  yield* Fiber.join(slow.fiber);
  assert.ok(slow.values.length <= 5, "Slow observer retained a resize backlog");
  assert.equal(slow.values.at(-1).bounds.width, latest.bounds.width);
  assert.equal(slow.values.at(-1).bounds.height, latest.bounds.height);
  record("stalled observers resume with the latest geometry instead of a resize backlog", {
    resizeRequests: 64,
    observed: slow.values,
  });

  {
    const appearance = yield* observe(first.handle.state);
    yield* first.handle.setTitle("Sewed appearance A");
    yield* first.handle.setAlwaysOnTop(true, "floating");
    yield* first.handle.setResizable(false);
    yield* first.handle.setOpacity(0.5);
    yield* first.handle.setProgress(0.5);
    yield* first.handle.flash(true);
    yield* first.handle.flash(false);
    yield* first.handle.setProgress(-1);
    yield* waitUntil(
      () =>
        appearance.values.some(
          (state) =>
            state.title === "Sewed appearance A" &&
            state.alwaysOnTop === first.native.isAlwaysOnTop() &&
            state.resizable === false,
        ),
      "appearance state",
    );
    assert.equal(first.native.getTitle(), "Sewed appearance A");
    assert.equal(first.native.isResizable(), false);
    assert.deepEqual(appearance.values.at(-1), nativeState(first.native));
    expectCode(yield* Effect.exit(first.handle.setAlwaysOnTop(true, "top")), "Protocol");
    expectCode(yield* Effect.exit(first.handle.setOpacity(2)), "Protocol");
    expectCode(yield* Effect.exit(first.handle.setIcon("/nonexistent/icon.png")), "Protocol");
    yield* first.handle.setResizable(true);
    yield* first.handle.setAlwaysOnTop(false);
    yield* Fiber.interrupt(appearance.fiber);
    yield* first.handle.setMinimumSize({ width: 200, height: 150 });
    yield* first.handle.setMaximumSize({ width: 1200, height: 900 });
    assert.deepEqual(yield* first.handle.sizeLimits, {
      minimum: { width: 200, height: 150 },
      maximum: { width: 1200, height: 900 },
    });
    assert.deepEqual(first.native.getMinimumSize(), [200, 150]);
    yield* first.handle.setMaximumSize({ width: 0, height: 0 });
    yield* first.handle.setMinimumSize({ width: 0, height: 0 });
    expectCode(yield* Effect.exit(first.handle.setMinimumSize({ width: -1, height: 1 })), "Protocol");
    yield* first.handle.setAspectRatio(16 / 9);
    yield* first.handle.setAspectRatio(0);
    expectCode(yield* Effect.exit(first.handle.setAspectRatio(-1)), "Protocol");
    assert.equal(yield* first.handle.enabled, true);
    yield* first.handle.setEnabled(false);
    assert.equal(first.native.isEnabled(), false);
    assert.equal(yield* first.handle.enabled, false);
    yield* first.handle.setEnabled(true);
    yield* first.handle.setIgnoreMouseEvents(true);
    yield* first.handle.setIgnoreMouseEvents(false);
    yield* first.handle.setAutoHideMenuBar(true);
    // A macOS window has no menu bar of its own to hide.
    if (process.platform !== "darwin") assert.equal(first.native.isMenuBarAutoHide(), true);
    yield* first.handle.setAutoHideMenuBar(false);
    yield* first.handle.setBackgroundColor("#102030");
    assert.equal((yield* first.handle.backgroundColor).toLowerCase(), "#102030");
    expectCode(yield* Effect.exit(first.handle.setBackgroundColor("")), "Protocol");
    yield* first.handle.setVisibleOnAllWorkspaces(true);
    const everywhere = yield* first.handle.visibleOnAllWorkspaces;
    assert.equal(everywhere, first.native.isVisibleOnAllWorkspaces());
    yield* first.handle.setVisibleOnAllWorkspaces(false);
    yield* first.handle.center;
    yield* first.handle.moveTop;
    record("size limits, input, color, and placement commands reach the native window", {
      everywhere,
      bounds: first.native.getBounds(),
    });
    yield* first.handle.setContentSize({ width: 420, height: 310 });
    const [contentWidth, contentHeight] = first.native.getContentSize();
    assert.deepEqual([contentWidth, contentHeight], [420, 310]);
    const content = yield* first.handle.contentBounds;
    yield* first.handle.setContentBounds({ ...content, width: 430 });
    assert.equal(first.native.getContentSize()[0], 430);
    expectCode(yield* Effect.exit(first.handle.setContentBounds({ width: 1, height: 1 })), "Protocol");
    yield* first.handle.setAccessibleTitle("Sewed accessible");
    assert.equal(yield* first.handle.accessibleTitle, "Sewed accessible");
    assert.equal(yield* first.handle.shadow, first.native.hasShadow());
    yield* first.handle.setHasShadow(first.native.hasShadow());
    assert.equal(yield* first.handle.normal, first.native.isNormal());
    if (process.platform === "darwin") {
      expectCode(yield* Effect.exit(first.handle.menuBarAutoHide), "Native");
      expectCode(yield* Effect.exit(first.handle.removeMenu), "Native");
    } else {
      assert.equal(yield* first.handle.menuBarAutoHide, first.native.isMenuBarAutoHide());
      yield* first.handle.removeMenu;
    }
    const nativeHandle = yield* first.handle.nativeHandle;
    assert.ok(nativeHandle instanceof Uint8Array && nativeHandle.byteLength > 0, "native handle bytes");
    yield* first.handle.moveAbove(yield* first.handle.mediaSourceId);
    expectCode(yield* Effect.exit(first.handle.moveAbove("")), "Protocol");
    const windowEvents = yield* first.handle.events.pipe(
      Stream.runForEach(() => Effect.void),
      Effect.forkScoped,
    );
    yield* Effect.sleep(20);
    assert.ok(first.native.listenerCount("app-command") > 0, "events listen while observed");
    yield* Fiber.interrupt(windowEvents);
    assert.equal(first.native.listenerCount("app-command"), 0, "events release with the observer");
    const persistScope = yield* Scope.fork(yield* Effect.scope);
    const persisted = yield* BrowserWindow.make({
      show: false,
      width: 300,
      height: 200,
      name: "sewed-persisted",
      windowStatePersistence: true,
    }).pipe(Scope.provide(persistScope));
    assert.equal(typeof persisted.id, "string");
    yield* Scope.close(persistScope, Exit.void);
    yield* BaseWindow.clearPersistedState("sewed-persisted");
    expectCode(
      yield* Effect.exit(
        Effect.scoped(BrowserWindow.make({ show: false, windowStatePersistence: true })),
      ),
      "Protocol",
    );
    expectCode(yield* Effect.exit(BaseWindow.clearPersistedState("")), "Protocol");
    record("content geometry, accessibility, handle, and event members reach the native window", {
      content: first.native.getContentSize(),
      handleBytes: nativeHandle.byteLength,
    });
    record("appearance commands publish native state and reject values outside Electron's ranges", {
      title: first.native.getTitle(),
      alwaysOnTop: first.native.isAlwaysOnTop(),
      opacity: first.native.getOpacity(),
    });

    const childScope = yield* Scope.fork(yield* Effect.scope);
    const nativeTitled = (title) =>
      NativeBrowserWindow.getAllWindows().find((window) => window.getTitle() === title);
    const modal = yield* BrowserWindow.make({
      parent: first.handle,
      modal: true,
      show: false,
      title: "Sewed modal child",
      frame: false,
      minWidth: 120,
      minHeight: 80,
    }).pipe(Scope.provide(childScope));
    const modalNative = nativeTitled("Sewed modal child");
    assert.ok(modalNative, "modal child exists");
    assert.equal(modalNative.getParentWindow(), first.native);
    assert.equal(modalNative.isModal(), true);
    expectCode(yield* Effect.exit(modal.setParent(null)), "Protocol");
    const child = yield* BrowserWindow.make({
      parent: first.handle,
      show: false,
      title: "Sewed child",
    }).pipe(Scope.provide(childScope));
    const childNative = nativeTitled("Sewed child");
    assert.ok(childNative, "child window exists");
    assert.equal(childNative.getParentWindow(), first.native);
    assert.equal(childNative.isModal(), false);
    yield* child.setParent(null);
    assert.equal(childNative.getParentWindow(), null);
    yield* child.setParent(second.handle);
    assert.equal(childNative.getParentWindow(), second.native);
    expectCode(yield* Effect.exit(child.setParent(child)), "Protocol");
    expectCode(yield* Effect.exit(child.setParent({ id: "unknown" })), "Protocol");
    expectCode(
      yield* Effect.exit(Effect.scoped(BrowserWindow.make({ modal: true, show: false }))),
      "Protocol",
    );
    expectCode(
      yield* Effect.exit(Effect.scoped(BrowserWindow.make({ width: -1, show: false }))),
      "Protocol",
    );
    yield* Scope.close(childScope, Exit.void);
    yield* waitUntil(
      () => childNative.isDestroyed() && modalNative.isDestroyed(),
      "child windows destroyed",
    );
    record(
      "windows take a Sewed parent and modality at creation and reparent through the registry",
      {
        parents: ["first", null, "second"],
      },
    );
  }

  {
    const chromeScope = yield* Scope.make();
    const chromeTitle = `Sewed chrome ${process.pid}`;
    const chrome = yield* BrowserWindow.make({
      title: chromeTitle,
      show: false,
      width: 320,
      height: 240,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 10 },
      backgroundThrottling: false,
    }).pipe(Scope.provide(chromeScope));
    const chromeNative = NativeBrowserWindow.getAllWindows().find(
      (window) => window.getTitle() === chromeTitle,
    );
    assert.ok(chromeNative, "chrome window exists");
    assert.equal(chromeNative.webContents.getBackgroundThrottling(), false);
    const unthrottledBefore = nativeWebContents
      .getAllWebContents()
      .filter((contents) => !contents.getBackgroundThrottling()).length;
    yield* WebContentsView.make({ backgroundThrottling: false }).pipe(Scope.provide(chromeScope));
    const unthrottledAfter = nativeWebContents
      .getAllWebContents()
      .filter((contents) => !contents.getBackgroundThrottling()).length;
    assert.equal(unthrottledAfter, unthrottledBefore + 1);
    const buttons = yield* Effect.exit(chrome.setWindowButtonVisibility(true));
    if (process.platform === "darwin") assert.equal(buttons._tag, "Success");
    else expectCode(buttons, "Native");
    expectCode(
      yield* Effect.exit(
        Effect.scoped(BrowserWindow.make({ titleBarStyle: "sideways", show: false })),
      ),
      "Protocol",
    );
    expectCode(
      yield* Effect.exit(
        Effect.scoped(BrowserWindow.make({ backgroundThrottling: "no", show: false })),
      ),
      "Protocol",
    );
    expectCode(
      yield* Effect.exit(Effect.scoped(WebContentsView.make({ backgroundThrottling: "no" }))),
      "Protocol",
    );
    yield* Scope.close(chromeScope, Exit.void);
    yield* waitUntil(() => chromeNative.isDestroyed(), "chrome window destroyed");
    record(
      "title bar options and background throttling reach native owners; button visibility is macOS-only",
      {
        platform: process.platform,
        windowThrottling: false,
        viewThrottling: false,
        buttonVisibility: buttons._tag === "Success" ? "shown" : "Native",
      },
    );
  }

  yield* Effect.gen(function* () {
    const a = yield* First();
    const b = yield* Second();
    const boundState = yield* observe(a.changes());
    yield* settled(
      boundState,
      first.native,
      { visible: true },
      "bound snapshot includes visibility",
    );
    assert.deepEqual(yield* a.state(), nativeState(first.native));

    yield* b.hide();
    yield* settled(secondState, second.native, { visible: false }, "bound B hide");
    assert.equal(first.native.isVisible(), true);
    yield* b.showInactive();
    yield* settled(
      secondState,
      second.native,
      { visible: true, focused: false },
      "bound B showInactive",
    );
    assert.equal(first.native.isVisible(), true);
    record("bound showInactive reveals only its owner without focusing it", {
      first: yield* a.state(),
      second: yield* b.state(),
    });

    yield* a.hide();
    yield* a.hide();
    yield* settled(boundState, first.native, { visible: false }, "bound A hidden snapshot");
    assert.equal(second.native.isVisible(), true);
    yield* a.show();
    yield* a.show();
    yield* settled(boundState, first.native, { visible: true }, "bound A shown snapshot");
    assert.equal(NativeBrowserWindow.getAllWindows().length, 2);
    assert.equal(first.native.webContents.getOSProcessId(), document.processId);
    record("bound hide and show target one owner and keep its client usable", {
      firstOwner: first.handle.id,
      secondOwner: second.handle.id,
      first: yield* a.state(),
      second: yield* b.state(),
    });

    const boundFocus = yield* requestFocus(b.focus(), secondState, second.native, "bound B focus");
    yield* settled(boundState, first.native, { visible: true }, "bound A actual state");
    record("bound focus executes against its selected native owner", {
      focus: boundFocus,
      second: yield* b.state(),
    });

    const boundSecondState = yield* observe(b.changes());
    const firstBounds = first.native.getBounds();
    const secondBounds = { x: 220, y: 180, width: 560, height: 420 };
    yield* requestBounds(b.setBounds(secondBounds), boundSecondState, second.native, secondBounds);
    assert.equal(first.native.getBounds().width, firstBounds.width);
    assert.equal(first.native.getBounds().height, firstBounds.height);
    assert.deepEqual(yield* b.state(), nativeState(second.native));
    record("bound geometry requests and snapshots select the exact window owner", {
      first: yield* a.state(),
      second: yield* b.state(),
    });

    yield* b.setFullScreen({ fullScreen: true });
    const boundFullScreen = yield* settled(
      boundSecondState,
      second.native,
      {
        fullScreen: true,
        normalBounds: { width: secondBounds.width, height: secondBounds.height },
      },
      "bound B fullscreen entry",
    );
    assert.equal(first.native.isFullScreen(), false);
    yield* b.setFullScreen({ fullScreen: false });
    const boundRestored = yield* settled(
      boundSecondState,
      second.native,
      { fullScreen: false, bounds: { width: secondBounds.width, height: secondBounds.height } },
      "bound B fullscreen exit",
    );
    record("bound fullscreen calls stream native transitions for one owner", {
      fullScreen: boundFullScreen,
      restored: boundRestored,
    });
    const boundContentBounds = yield* second.handle.contentBounds;
    assert.deepEqual(boundContentBounds, second.native.getContentBounds());
    const current = yield* b.state();
    assert.equal(current.fullScreen, false);
    assert.ok(matches(current.bounds, { width: secondBounds.width, height: secondBounds.height }));
    record("fullscreen exits expose current content bounds through on-demand reads", {
      direct: restoredContentBounds,
      boundOwner: boundContentBounds,
      current,
    });

    const externalBounds = { x: 150, y: 160, width: 640, height: 480 };
    first.native.setBounds(externalBounds);
    const externalSize = { width: externalBounds.width, height: externalBounds.height };
    yield* settled(boundState, first.native, { bounds: externalSize }, "external native bounds");
    yield* settled(
      firstState,
      first.native,
      { bounds: externalSize },
      "direct native bounds observation",
    );
    record("native move and resize events update both direct and bound observers", {
      native: nativeState(first.native),
      bound: yield* a.state(),
    });

    const invalidBounds = [
      { x: 1.5 },
      { y: "top" },
      { x: 2 ** 31 },
      { y: -(2 ** 31) - 1 },
      { width: -1 },
      { height: 2 ** 31 },
      { width: Number.NaN },
      { height: Number.POSITIVE_INFINITY },
      { width: undefined },
      null,
    ];
    const originalSetBounds = first.native.setBounds;
    const originalSetFullScreen = first.native.setFullScreen;
    let nativeGeometryCalls = 0;
    yield* Effect.gen(function* () {
      first.native.setBounds = (...args) => {
        nativeGeometryCalls += 1;
        return originalSetBounds.apply(first.native, args);
      };
      first.native.setFullScreen = (...args) => {
        nativeGeometryCalls += 1;
        return originalSetFullScreen.apply(first.native, args);
      };
      for (const bounds of invalidBounds) {
        const direct = failure(yield* Effect.exit(first.handle.setBounds(bounds)));
        assert.equal(direct.code, "Native");
        assert.equal(direct.cause._tag, "SchemaError");
        invalidPayload(yield* Effect.exit(a.setBounds(bounds)), "setBounds");
      }
      const direct = failure(yield* Effect.exit(first.handle.setFullScreen("true")));
      assert.equal(direct.code, "Native");
      assert.equal(direct.cause._tag, "SchemaError");
      invalidPayload(yield* Effect.exit(a.setFullScreen({ fullScreen: "true" })), "setFullScreen");
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          first.native.setBounds = originalSetBounds;
          first.native.setFullScreen = originalSetFullScreen;
        }),
      ),
    );
    assert.equal(nativeGeometryCalls, 0);
    assert.ok(matches(first.native.getBounds(), externalSize));
    assert.equal(first.native.isFullScreen(), false);
    assert.deepEqual(yield* a.state(), nativeState(first.native));
    record("invalid geometry and fullscreen payloads fail before native invocation", {
      invalidBounds: invalidBounds.length,
      invalidFullScreen: 1,
      nativeGeometryCalls,
      survivingState: yield* a.state(),
    });

    first.native.hide();
    yield* settled(boundState, first.native, { visible: false }, "external native hide");
    first.native.showInactive();
    yield* settled(
      boundState,
      first.native,
      { visible: true, focused: false },
      "external native show",
    );
    assert.deepEqual(yield* a.state(), nativeState(first.native));
    record("visibility events outside Sewed update direct and bound observers", {
      native: nativeState(first.native),
      bound: yield* a.state(),
    });

    const originalShow = first.native.show;
    const nativeError = new Error("fixture native show failure");
    const failed = yield* Effect.exit(
      Effect.sync(() => {
        first.native.show = () => {
          throw nativeError;
        };
      }).pipe(
        Effect.andThen(first.handle.show),
        Effect.ensuring(
          Effect.sync(() => {
            first.native.show = originalShow;
          }),
        ),
      ),
    );
    const error = failure(failed);
    assert.equal(error.code, "Native");
    assert.equal(error.cause, nativeError);
    record("native invocation failures retain SewedError Native and the original cause", {
      code: error.code,
      message: error.message,
    });

    for (const [name, operation] of [
      ["setBounds", first.handle.setBounds({ width: 700 })],
      ["setFullScreen", first.handle.setFullScreen(true)],
    ]) {
      const original = first.native[name];
      const nativeError = new Error(`fixture native ${name} failure`);
      const result = yield* Effect.exit(
        Effect.sync(() => {
          first.native[name] = () => {
            throw nativeError;
          };
        }).pipe(
          Effect.andThen(operation),
          Effect.ensuring(
            Effect.sync(() => {
              first.native[name] = original;
            }),
          ),
        ),
      );
      const error = failure(result);
      assert.equal(error.code, "Native");
      assert.equal(error.cause, nativeError);
    }
    assert.ok(matches(first.native.getBounds(), externalSize));
    record("native geometry failures preserve causes without optimistic state changes", {
      state: yield* a.state(),
    });

    yield* Scope.close(ownership, Exit.void);
    assert.equal(first.native.isDestroyed(), true);
    const observerExit = yield* Fiber.await(firstState.fiber);
    assert.equal(observerExit._tag, "Success");
    const closedCalls = [];
    for (const [name, direct, remote] of [
      ...["show", "showInactive", "hide", "focus"].map((name) => [
        name,
        first.handle[name],
        a[name](),
      ]),
      ["setBounds", first.handle.setBounds({ width: 700 }), a.setBounds({ width: 700 })],
      ["setFullScreen", first.handle.setFullScreen(true), a.setFullScreen({ fullScreen: true })],
    ]) {
      const closed = failure(yield* Effect.exit(direct));
      assert.equal(closed.code, "Closed");
      const remoteClosed = failure(yield* Effect.exit(remote));
      assert.equal(remoteClosed._tag, "SewedError");
      assert.equal(remoteClosed.code, "Closed");
      assert.equal(remoteClosed.cause.reason.cause.code, "Closed");
      closedCalls.push({
        operation: name,
        direct: closed.code,
        remote: remoteClosed.code,
        cause: remoteClosed.cause.reason.cause.code,
      });
    }
    for (const [event, baseline] of Object.entries(first.listeners)) {
      assert.deepEqual(first.native.listeners(event), baseline);
    }
    assert.equal(NativeBrowserWindow.getAllWindows().length, 1);
    yield* b.show();
    yield* b.setBounds({ width: 580 });
    yield* settled(
      boundSecondState,
      second.native,
      { bounds: { width: 580, height: secondBounds.height } },
      "surviving geometry owner",
    );
    assert.equal((yield* b.state()).visible, true);
    record("owner scope closure completes observers and rejects direct and bound operations", {
      observerExit: observerExit._tag,
      closedCalls,
      nativeListenerCounts: Object.fromEntries(
        Object.entries(first.listeners).map(([event, baseline]) => [event, baseline.length]),
      ),
      firstOwner: first.handle.id,
      survivingOwner: second.handle.id,
      survivingState: yield* b.state(),
    });
  }).pipe(
    Effect.provide(
      Binding.layer([Binding.to(First, first.controls), Binding.to(Second, second.controls)]),
    ),
  );

  yield* second.handle.hide;
  yield* second.handle.close;
  yield* second.handle.awaitClosed;
  const mediaSourceIdAfterClose = expectCode(
    yield* Effect.exit(second.handle.mediaSourceId),
    "Closed",
  );
  const contentBoundsAfterClose = expectCode(
    yield* Effect.exit(second.handle.contentBounds),
    "Closed",
  );
  const closed = yield* Fiber.await(secondState.fiber);
  assert.equal(closed._tag, "Success");
  assert.equal(NativeBrowserWindow.getAllWindows().length, 0);
  record("native close of a hidden window ends its state stream", {
    observerExit: closed._tag,
    mediaSourceIdAfterClose: mediaSourceIdAfterClose.code,
    contentBoundsAfterClose: contentBoundsAfterClose.code,
  });

  yield* Effect.gen(function* () {
    const automationScope = yield* Scope.fork(yield* Effect.scope);
    const beforeAutomationWindow = new Set(NativeBrowserWindow.getAllWindows());
    const automationWindow = yield* BrowserWindow.make({
      title: "Sewed automation",
      show: false,
      width: 400,
      height: 300,
      automation: { evaluate: true, input: true, devtools: ["Page.captureScreenshot"] },
    }).pipe(Scope.provide(automationScope));
    const automationNative = [...NativeBrowserWindow.getAllWindows()].find(
      (candidate) => !beforeAutomationWindow.has(candidate),
    );
    assert.ok(automationNative, "automation window exists");
    const automationStates = yield* observe(automationWindow.webContents.state);
    const inputPage = new URL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          "<!doctype html><title>Sewed automation page</title>" + '<input id="field" type="text">',
        ),
    );
    yield* automationWindow.webContents.load(Renderer.entry(inputPage, { bindings: [] }), {
      bindings: [],
    });
    yield* waitUntil(
      () => automationStates.values.some((state) => state.status === "ready"),
      "automation page ready",
    );
    const title = yield* automationWindow.automation.evaluate("document.title", Schema.String);
    assert.equal(title, "Sewed automation page");
    yield* automationWindow.automation.evaluate("window.sewedPageMarker = 1; 1", Schema.Finite);
    const isolated = yield* automationWindow.automation.evaluate(
      "[document.title, typeof window.sewedPageMarker]",
      Schema.Array(Schema.String),
      { world: 1000 },
    );
    assert.deepEqual(isolated, ["Sewed automation page", "undefined"], "the DOM is shared, the page's state is not");

    const readField = () =>
      automationWindow.automation.evaluate('document.getElementById("field").value', Schema.String);
    const pollField = () =>
      Effect.gen(function* () {
        let value = "";
        for (let attempt = 0; attempt < 15 && value !== "a"; attempt += 1) {
          value = yield* readField();
          if (value !== "a") yield* Effect.sleep(40);
        }
        return value;
      });
    yield* automationWindow.automation.evaluate(
      'document.getElementById("field").focus(); null',
      Schema.Null,
    );
    yield* automationWindow.automation.input({ type: "char", keyCode: "a" });
    let requiredShow = false;
    let typed = yield* pollField();
    if (typed !== "a") {
      requiredShow = true;
      yield* automationWindow.show;
      yield* waitUntil(() => automationNative.isVisible(), "automation window visible for input");
      yield* automationWindow.automation.evaluate(
        'document.getElementById("field").focus(); null',
        Schema.Null,
      );
      yield* automationWindow.automation.input({ type: "char", keyCode: "a" });
      typed = yield* pollField();
    }
    assert.equal(
      typed,
      "a",
      `input did not reach the focused field (requiredShow=${requiredShow})`,
    );
    record(
      "automation.evaluate reads the document and automation.input types into a focused field",
      {
        title,
        requiredShow,
        typed,
      },
    );

    // Page.captureScreenshot never resolves against a renderer that has never been shown
    // (no compositor frame is produced), so the window must be visible before this call.
    if (!requiredShow) {
      yield* automationWindow.show;
      yield* waitUntil(() => automationNative.isVisible(), "automation window visible for capture");
    }
    let screenshot;
    let screenshotFailure;
    for (let attempt = 0; attempt < 5 && screenshot === undefined; attempt += 1) {
      const captured = yield* Effect.exit(
        automationWindow.automation
          .devtools(
            "Page.captureScreenshot",
            { format: "png" },
            Schema.Struct({ data: Schema.String }),
          )
          .pipe(Effect.timeout("5 seconds")),
      );
      if (captured._tag === "Success" && captured.value.data.length > 0)
        screenshot = captured.value;
      else {
        screenshotFailure = captured;
        yield* Effect.sleep(200);
      }
    }
    assert.ok(screenshot, `devtools capture failed: ${JSON.stringify(screenshotFailure)}`);
    record("automation.devtools runs an allowlisted DevTools method and returns its result", {
      dataLength: screenshot.data.length,
    });

    // `Decidables.WebContents.Input` on a window's own contents, against real Electron. It used to
    // install cleanly and never be consulted: the only input gate in the library was the one a guest
    // view installs at construction, while both kinds of contents share the owner kind "contents".
    // Nothing in the unit suite can reach the line that hands this window's real contents to that
    // gate — `internal/WebContents.ts` imports electron transitively — so this is where it is
    // proven: no native listener until a decider exists, the decider consulted for a key Chromium
    // dispatches, the keystroke swallowed, and both listener and effect gone with the scope.
    const inputNative = automationNative.webContents;
    const listenersBefore = {
      key: inputNative.listenerCount("before-input-event"),
      mouse: inputNative.listenerCount("before-mouse-event"),
    };
    assert.deepEqual(
      listenersBefore,
      { key: 0, mouse: 0 },
      "a window with no input decider carries no input listener",
    );
    let consultations = 0;
    const clearField = () =>
      automationWindow.automation.evaluate(
        'document.getElementById("field").value = ""; document.getElementById("field").focus(); null',
        Schema.Null,
      );
    const typeA = () =>
      Effect.sync(() => {
        inputNative.sendInputEvent({ type: "keyDown", keyCode: "a" });
        inputNative.sendInputEvent({ type: "char", keyCode: "a" });
        inputNative.sendInputEvent({ type: "keyUp", keyCode: "a" });
      });
    const inputScope = yield* Scope.fork(yield* Effect.scope);
    yield* automationWindow.webContents
      .decide(
        Decidables.WebContents.Input,
        Decision.sync(() => {
          consultations += 1;
          return "block";
        }),
      )
      .pipe(Scope.provide(inputScope));
    const listenersWithDecider = {
      key: inputNative.listenerCount("before-input-event"),
      mouse: inputNative.listenerCount("before-mouse-event"),
    };
    assert.deepEqual(
      listenersWithDecider,
      { key: 1, mouse: 1 },
      "the first input decider attaches both native listeners",
    );
    yield* clearField();
    yield* typeA();
    yield* waitUntil(() => consultations > 0, "the window's own input decider to be consulted");
    const consultedWhileBlocking = consultations;
    const blockedField = yield* readField();
    assert.equal(blockedField, "", "a blocked key must not reach the page");
    yield* Scope.close(inputScope, Exit.void);
    const listenersAfter = {
      key: inputNative.listenerCount("before-input-event"),
      mouse: inputNative.listenerCount("before-mouse-event"),
    };
    assert.deepEqual(
      listenersAfter,
      { key: 0, mouse: 0 },
      "the last decider's removal detaches both native listeners",
    );
    yield* clearField();
    yield* typeA();
    const allowedField = yield* pollField();
    assert.equal(allowedField, "a", "closing the decider's scope lets the next key through");
    assert.equal(
      consultations,
      consultedWhileBlocking,
      "a key after the scope closed consults nothing",
    );
    record(
      "an Input decider on a window's own web contents blocks a real keystroke, and its scope owns the native listener",
      {
        listenersBefore,
        listenersWithDecider,
        listenersAfter,
        consultedWhileBlocking,
        blockedField,
        allowedField,
      },
    );

    const undeclaredWindow = yield* BrowserWindow.make({
      title: "Sewed automation undeclared",
      show: false,
      width: 200,
      height: 150,
    }).pipe(Scope.provide(automationScope));
    expectCode(
      yield* Effect.exit(undeclaredWindow.automation.evaluate("document.title", Schema.String)),
      "Protocol",
    );
    record("a window made without an automation declaration has no runtime automation members", {});

    yield* Scope.close(automationScope, Exit.void);
  });
});

App.run(
  [],
  Effect.gen(function* () {
    yield* App.decide(
      Decidables.App.LastWindowClosed,
      Decision.sync(() => "stay"),
    );
    const result = yield* Effect.exit(runChecks);
    console.log(
      `WINDOW_CONTROLS_VERIFICATION ${JSON.stringify({
        success: result._tag === "Success" && unsettled.length === 0,
        unsettled,
        checks,
        error: result._tag === "Failure" ? Cause.pretty(result.cause) : undefined,
        platform: { os: process.platform, ozone: "x11" },
        nativeWindows: NativeBrowserWindow.getAllWindows().map((window) => ({
          id: window.id,
          title: window.getTitle(),
          state: nativeState(window),
        })),
      })}`,
    );
    if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
    yield* App.quit;
  }),
);
