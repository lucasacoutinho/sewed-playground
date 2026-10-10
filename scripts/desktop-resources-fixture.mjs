import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  BrowserWindow as NativeBrowserWindow,
  Tray as NativeTray,
  globalShortcut as NativeGlobalShortcut,
} from "electron";
import { Cause, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { Binding, Decidables, Decision, Renderer } from "sewed";
import { App, BrowserWindow, GlobalShortcut, host, Tray } from "sewed/main";
import { TrayEvents, TrayEventsSlot } from "./desktop-resources-contract.mjs";

const execFileAsync = promisify(execFile);
const marker = "DESKTOP_RESOURCES_VERIFICATION";
const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const rootArgument = process.argv.find((value) => value.startsWith("--sewed-desktop-root="));
const artifactRoot = resolve(
  rootArgument === undefined
    ? join(process.cwd(), ".artifacts", "desktop-resources-fixture")
    : rootArgument.slice("--sewed-desktop-root=".length),
);
const notifierScript = join(fixtureDirectory, "desktop-status-notifier.py");
const x11KeyScript = join(fixtureDirectory, "application-menu-window.py");
const checks = [];
const platformLimits = [];
const state = {
  artifactRoot,
  checks,
  platformLimits,
  errors: [],
  notifier: undefined,
  report: undefined,
};

mkdirSync(artifactRoot, { recursive: true });

const failure = (exit) => {
  assert.equal(exit._tag, "Failure");
  const error = Cause.findErrorOption(exit.cause);
  assert.equal(error._tag, "Some", Cause.pretty(exit.cause));
  return error.value;
};

const errorFacts = (error) =>
  error === undefined ? undefined : { name: error.name, code: error.code, message: error.message };

const exitFacts = (exit) => {
  if (exit._tag === "Success") return { tag: exit._tag };
  const error = Cause.findErrorOption(exit.cause);
  return {
    tag: exit._tag,
    interrupted: Cause.hasInterruptsOnly(exit.cause),
    error: error._tag === "Some" ? errorFacts(error.value) : undefined,
    cause: Cause.pretty(exit.cause),
  };
};

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
      yield* Effect.sleep(10);
    }
    throw new Error(
      `Timed out: ${description}${lastError ? ` (${lastError.message || lastError})` : ""}`,
    );
  });

const observe = (stream) =>
  Effect.gen(function* () {
    const observer = { values: [], exit: undefined };
    observer.fiber = yield* stream.pipe(
      Stream.runForEach((value) => Effect.sync(() => observer.values.push(value))),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          observer.exit = exit;
        }),
      ),
      Effect.forkScoped,
    );
    return observer;
  });

const createNotifier = () => {
  const child = spawn("/usr/bin/python3", [notifierScript], {
    cwd: fixtureDirectory,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  const exited = new Promise((resolveExit) => child.once("close", resolveExit));
  const pending = [];
  const lines = createInterface({ input: child.stdout });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  lines.on("line", (line) => {
    try {
      const event = JSON.parse(line);
      events.push(event);
      const eventIndex = events.length - 1;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        if (eventIndex < pending[index].after || !pending[index].predicate(event)) continue;
        const waiter = pending.splice(index, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      }
    } catch (error) {
      events.push({ event: "malformed", line, error: String(error) });
    }
  });
  const waitFor = (predicate, description, timeout = 8_000, after = 0) => {
    const existing = events.slice(after).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolvePromise, reject) => {
      const waiter = {
        predicate,
        after,
        resolve: resolvePromise,
        reject,
        timer: setTimeout(() => {
          const index = pending.indexOf(waiter);
          if (index !== -1) pending.splice(index, 1);
          reject(
            new Error(`Timed out waiting for notifier ${description}; stderr=${stderr.join("")}`),
          );
        }, timeout),
      };
      pending.push(waiter);
    });
  };
  const send = (command) => {
    child.stdin.write(`${JSON.stringify(command)}\n`);
  };
  const command = (value) => {
    const after = events.length;
    send(value);
    return waitFor(
      (event) => event.event === "command" && event.command === value.cmd,
      value.cmd,
      8_000,
      after,
    );
  };
  const snapshot = async () => {
    const after = events.length;
    send({ cmd: "snapshot" });
    return (await waitFor((event) => event.event === "snapshot", "snapshot", 8_000, after)).item;
  };
  const menuLayout = async () => {
    const after = events.length;
    send({ cmd: "menu-layout" });
    const result = await waitFor(
      (event) =>
        (event.event === "menu-layout" && event.layout !== undefined) ||
        (event.event === "error" && event.operation === "menu-layout"),
      "menu layout",
      8_000,
      after,
    );
    if (result.event === "error") throw new Error(result.message);
    return result.layout;
  };
  const stop = async () => {
    if (child.exitCode !== null) return;
    try {
      send({ cmd: "stop" });
      await waitFor(
        (event) => event.event === "command" && event.command === "stop",
        "stop",
        2_000,
      );
    } catch {
      // The process may already have gone away while the application scope closed.
    }
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
  };
  state.notifier = { child, events, stop };
  return {
    child,
    events,
    waitFor,
    send,
    command,
    snapshot,
    menuLayout,
    stop,
  };
};

const writeIcon = (name, base64) => {
  const path = join(artifactRoot, name);
  writeFileSync(path, Buffer.from(base64, "base64"));
  return path;
};

const nativeWindowForTitle = (title) => {
  const window = NativeBrowserWindow.getAllWindows().find(
    (candidate) => candidate.getTitle() === title,
  );
  assert.ok(window, `Native fixture window ${title} was not created`);
  return window;
};

const sendX11Key = (nativeWindow, key, modifiers) =>
  Effect.promise(async () => {
    const nativeId = nativeWindow.getNativeWindowHandle().readUInt32LE(0);
    const { stdout } = await execFileAsync(
      "/usr/bin/python3",
      [x11KeyScript, String(process.pid), String(nativeId), key, ...modifiers],
      { timeout: 2_000 },
    );
    return JSON.parse(stdout);
  });

const evaluate = (nativeWindow, source) =>
  Effect.promise(() => nativeWindow.webContents.executeJavaScript(source));

const waitRenderer = (nativeWindow, source, description) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const value = yield* evaluate(nativeWindow, source);
      if (value !== undefined && value !== null) return value;
      yield* Effect.sleep(10);
    }
    throw new Error(`Timed out: ${description}`);
  });

const runTrayBindingChecks = (notifier, tray, trayScope) =>
  Effect.gen(function* () {
    let activeSubscribers = 0;
    const owner = yield* host(
      TrayEvents,
      TrayEvents.toLayer({
        events: () =>
          Stream.unwrap(
            Effect.acquireRelease(
              Effect.sync(() => {
                activeSubscribers += 1;
                return tray.events;
              }),
              () =>
                Effect.sync(() => {
                  activeSubscribers -= 1;
                }),
            ),
          ),
      }),
    ).pipe(Scope.provide(trayScope));
    const rendererScope = yield* Scope.fork(yield* Effect.scope);
    const boundWindow = yield* BrowserWindow.make({
      title: "Sewed desktop resources bound renderer",
      width: 420,
      height: 220,
      show: false,
    }).pipe(Scope.provide(rendererScope));
    const unboundWindow = yield* BrowserWindow.make({
      title: "Sewed desktop resources unbound renderer",
      width: 420,
      height: 220,
      show: false,
    }).pipe(Scope.provide(rendererScope));
    const boundNative = NativeBrowserWindow.getAllWindows().find(
      (candidate) => candidate.getTitle() === "Sewed desktop resources bound renderer",
    );
    const unboundNative = NativeBrowserWindow.getAllWindows().find(
      (candidate) => candidate.getTitle() === "Sewed desktop resources unbound renderer",
    );
    assert.ok(boundNative);
    assert.ok(unboundNative);
    const boundEntry = Renderer.entry(
      new URL("../.artifacts/desktop-resources-renderer/index.html", import.meta.url),
      { bindings: [TrayEventsSlot] },
    );
    const unboundEntry = Renderer.entry(
      new URL("../.artifacts/desktop-resources-renderer/unbound.html", import.meta.url),
      { bindings: [] },
    );
    yield* boundWindow.webContents.load(boundEntry, {
      bindings: [Binding.to(TrayEventsSlot, owner)],
    });
    yield* unboundWindow.webContents.load(unboundEntry, { bindings: [] });
    yield* waitRenderer(
      boundNative,
      "window.desktopResourcesFixture?.session",
      "bound renderer startup",
    );
    yield* waitUntil(() => activeSubscribers === 1, "bound tray stream subscription");
    const unboundState = yield* waitRenderer(
      unboundNative,
      "window.desktopResourcesUnbound?.access",
      "unbound renderer access result",
    );
    assert.equal(unboundState.tag, "Failure", JSON.stringify(unboundState));
    assert.equal(unboundState.error.code, "Protocol", JSON.stringify(unboundState));
    record("an unbound renderer cannot acquire the tray event slot", {
      access: unboundState,
      activeSubscribers,
    });

    const activated = yield* Effect.promise(() => notifier.command({ cmd: "activate" }));
    assert.equal(activated.ok, true, JSON.stringify(activated));
    const firstRendererEvent = yield* waitRenderer(
      boundNative,
      "window.desktopResourcesFixture?.events?.[0]",
      "native tray Activate in bound renderer",
    );
    assert.deepEqual(firstRendererEvent, { kind: "click" });
    record("native tray Activate reaches the explicitly bound renderer stream", {
      owner: owner.id,
      event: firstRendererEvent,
      activeSubscribers,
    });

    yield* evaluate(boundNative, "window.desktopResourcesFixture.cancel()");
    yield* waitUntil(() => activeSubscribers === 0, "cancelled bound tray stream");
    const cancelled = yield* evaluate(boundNative, "window.desktopResourcesFixture.cancelled");
    assert.equal(cancelled, true);
    assert.equal(boundNative.isDestroyed(), false);
    const stillRegistered = yield* Effect.promise(() => notifier.snapshot());
    assert.equal(typeof stillRegistered.service, "string");
    record(
      "cancelling the renderer consumer releases only its subscription and preserves the tray",
      {
        cancelled,
        activeSubscribers,
        trayId: tray.id,
        statusNotifierService: stillRegistered.service,
      },
    );

    const previousSession = yield* evaluate(boundNative, "window.desktopResourcesFixture.session");
    yield* boundWindow.webContents.reload;
    const reloaded = yield* waitRenderer(
      boundNative,
      `window.desktopResourcesFixture?.session && window.desktopResourcesFixture.session !== ${JSON.stringify(previousSession)} ? window.desktopResourcesFixture.session : undefined`,
      "reloaded bound renderer session",
    );
    yield* waitUntil(() => activeSubscribers === 1, "reloaded bound tray stream subscription");
    const afterReload = yield* Effect.promise(() => notifier.command({ cmd: "activate" }));
    assert.equal(afterReload.ok, true, JSON.stringify(afterReload));
    const reloadedEvent = yield* waitRenderer(
      boundNative,
      "window.desktopResourcesFixture?.events?.[0]",
      "native tray Activate after renderer reload",
    );
    assert.deepEqual(reloadedEvent, { kind: "click" });
    record("renderer reload creates a fresh bound consumer while the tray resource survives", {
      previousSession,
      reloaded,
      event: reloadedEvent,
      activeSubscribers,
    });

    yield* Scope.close(rendererScope, Exit.void);
    yield* waitUntil(() => activeSubscribers === 0, "renderer scope cleanup");
  });

const runInjectedTrayConfigurationFailureCheck = (icon) =>
  Effect.gen(function* () {
    const failureScope = yield* Scope.fork(yield* Effect.scope);
    const originalSetToolTip = NativeTray.prototype.setToolTip;
    let captured;
    NativeTray.prototype.setToolTip = function (...args) {
      captured = this;
      throw new Error(`injected setToolTip failure: ${String(args[0])}`);
    };
    let result;
    try {
      result = yield* Effect.exit(
        Tray.make({ icon, tooltip: "injected configuration failure" }).pipe(
          Scope.provide(failureScope),
        ),
      );
    } finally {
      NativeTray.prototype.setToolTip = originalSetToolTip;
    }
    const error = failure(result);
    assert.equal(error.code, "Native");
    assert.ok(captured, "the injected native setter was not called");
    assert.equal(
      captured.isDestroyed(),
      true,
      "failed Tray.make retained a native tray until parent scope close",
    );
    record(
      "injected Tray configuration failure destroys the native tray before its parent scope closes",
      {
        error: errorFacts(error),
        destroyed: captured.isDestroyed(),
        parentScopeAlive: true,
      },
    );
    yield* Scope.close(failureScope, Exit.void);
  });

const runTrayChecks = (notifier, initialIcon, updatedIcon) =>
  Effect.gen(function* () {
    const menu = {
      items: [
        { kind: "command", id: "open", label: "Open" },
        { kind: "checkbox", id: "flag", label: "Flag", checked: false },
        { kind: "separator" },
        {
          kind: "submenu",
          label: "More",
          items: [{ kind: "radio", id: "alpha", label: "Alpha", checked: true }],
        },
      ],
    };
    const trayScope = yield* Scope.fork(yield* Effect.scope);
    const tray = yield* Tray.make({ icon: initialIcon, tooltip: "Sewed tray initial", menu }).pipe(
      Scope.provide(trayScope),
    );
    const first = yield* observe(tray.events);
    const second = yield* observe(tray.events);
    const registration = yield* Effect.promise(() =>
      notifier.waitFor((event) => event.event === "registered", "StatusNotifierItem registration"),
    );
    const initial = yield* Effect.promise(() => notifier.snapshot());
    const initialLayout = yield* Effect.promise(() => notifier.menuLayout());
    assert.equal(typeof initial.Title, "string", JSON.stringify(initial));
    assert.equal(initial.tooltipText.includes("Sewed tray initial"), true, JSON.stringify(initial));
    assert.equal(
      initialLayout.root.children.some((item) => item.label === "Open"),
      true,
      JSON.stringify(initialLayout),
    );
    record("Linux StatusNotifierItem registration exposes tooltip and dbusmenu", {
      registration,
      snapshot: initial,
      menu: initialLayout,
    });

    yield* tray.setToolTip("Sewed tray updated");
    const updatedTooltip = yield* Effect.promise(() => notifier.snapshot());
    assert.equal(
      updatedTooltip.tooltipText.includes("Sewed tray updated"),
      true,
      JSON.stringify(updatedTooltip),
    );
    yield* tray.setImage(updatedIcon);
    const updatedImage = yield* Effect.promise(() => notifier.snapshot());
    assert.notEqual(
      updatedImage.iconSignature,
      initial.iconSignature,
      "tray image did not change native icon pixmap",
    );
    const updatedMenu = {
      items: [
        { kind: "command", id: "updated", label: "Updated" },
        { kind: "checkbox", id: "flag", label: "Flag updated", checked: true },
      ],
    };
    yield* tray.setMenu(updatedMenu);
    const updatedMenuState = yield* Effect.promise(() => notifier.snapshot());
    record("tray StatusNotifier properties remain readable after setMenu", {
      snapshot: updatedMenuState,
    });
    const layout = yield* Effect.promise(() => notifier.menuLayout());
    assert.equal(
      layout.root.children.some((item) => item.label === "Updated"),
      true,
      JSON.stringify(layout),
    );
    assert.equal(
      layout.root.children.some((item) => item.label === "Open"),
      false,
      JSON.stringify(layout),
    );
    record("tray tooltip, image, and menu update through native operations", {
      tooltip: updatedTooltip,
      image: { before: initial.iconSignature, after: updatedImage.iconSignature },
      menu: layout,
    });

    // Task 6 (wave 4): setImage now resolves its icon through wave 3's own nativeImageOf helper,
    // the same one Window.setIcon and App.dock.setIcon already use — a path Electron reads back
    // empty fails Protocol there, naming the icon, not the tray-specific Native this used to be.
    const missingImage = failure(
      yield* Effect.exit(tray.setImage(join(artifactRoot, "does-not-exist.png"))),
    );
    assert.equal(missingImage.code, "Protocol");
    const duplicateMenu = failure(
      yield* Effect.exit(
        tray.setMenu({
          items: [
            { kind: "command", id: "duplicate", label: "One" },
            { kind: "command", id: "duplicate", label: "Two" },
          ],
        }),
      ),
    );
    assert.equal(duplicateMenu.code, "Native");
    record("an invalid tray image path fails Protocol and duplicate menu ids fail Native", {
      missingImage: errorFacts(missingImage),
      duplicateMenu: errorFacts(duplicateMenu),
    });

    const activated = yield* Effect.promise(() => notifier.command({ cmd: "activate" }));
    yield* waitUntil(
      () => first.values.some((event) => event.kind === "click"),
      "tray Activate click",
    );
    assert.equal(first.values.filter((event) => event.kind === "click").length, 1);
    assert.equal(second.values.filter((event) => event.kind === "click").length, 1);
    yield* Fiber.interrupt(second.fiber);
    const secondExit = yield* Fiber.await(second.fiber);
    const beforeCancellation = first.values.length;
    yield* Effect.promise(() => notifier.command({ cmd: "activate" }));
    yield* waitUntil(
      () => first.values.length > beforeCancellation,
      "remaining tray observer after cancellation",
    );
    assert.equal(second.values.filter((event) => event.kind === "click").length, 1);
    record("tray Activate fans out to observers and cancellation removes one observer", {
      activate: activated,
      first: first.values,
      secondExit: exitFacts(secondExit),
    });

    const updatedItem = layout.root.children.find((item) => item.label === "Updated");
    assert.ok(updatedItem);
    const selected = yield* Effect.promise(() =>
      notifier.command({ cmd: "menu-event", id: updatedItem.id }),
    );
    assert.equal(selected.ok, true, JSON.stringify(selected));
    yield* waitUntil(
      () =>
        first.values.some(
          (event) => event.kind === "menu-selection" && event.selection.id === "updated",
        ),
      "native dbusmenu click selection",
    );
    record("native dbusmenu selection uses the updated typed menu identifier", {
      nativeItemId: updatedItem.id,
      events: first.values,
    });
    platformLimits.push({
      feature: "right-click and double-click tray events",
      reason:
        "Electron exposes these events on macOS and Windows; Linux StatusNotifier activation is verified through click instead.",
      source: "https://www.electronjs.org/docs/latest/api/tray",
    });

    yield* runTrayBindingChecks(notifier, tray, trayScope);
    yield* Scope.close(trayScope, Exit.void);
    const firstExit = yield* Fiber.await(first.fiber);
    assert.equal(firstExit._tag, "Success", exitFacts(firstExit));
    const unregistered = yield* Effect.promise(() =>
      notifier.waitFor(
        (event) => event.event === "unregistered",
        "StatusNotifierItem unregistration",
      ),
    );
    const closed = failure(yield* Effect.exit(tray.setToolTip("late")));
    assert.equal(closed.code, "Closed");
    record("tray scope cleanup unregisters the native item and ends its stream", {
      unregistered,
      observerExit: exitFacts(firstExit),
      lateOperation: errorFacts(closed),
    });
  });

// Task 6 (wave 4): Tray.Options.icon and setImage(icon, { template? }) take Image.Source, a path
// or already-encoded bytes; template calls the native image's own setTemplateImage(true), a
// probed no-op on Linux this can only prove does not break anything, since isTemplateImage is
// not exposed over the StatusNotifierItem DBus surface this fixture otherwise reads state from.
const runTrayBytesChecks = (notifier, iconPath) =>
  Effect.gen(function* () {
    const bytes = readFileSync(iconPath);
    const registeredAfter = notifier.events.length;
    const trayScope = yield* Scope.fork(yield* Effect.scope);
    const tray = yield* Tray.make({
      icon: bytes,
      template: true,
      tooltip: "Sewed tray from bytes",
    }).pipe(Scope.provide(trayScope));
    yield* Effect.promise(() =>
      notifier.waitFor(
        (event) => event.event === "registered",
        "StatusNotifierItem registration from bytes",
        8_000,
        registeredAfter,
      ),
    );
    const snapshot = yield* Effect.promise(() => notifier.snapshot());
    assert.equal(
      snapshot.tooltipText.includes("Sewed tray from bytes"),
      true,
      JSON.stringify(snapshot),
    );
    yield* tray.setImage(bytes, { template: true });
    const afterSetImage = yield* Effect.promise(() => notifier.snapshot());
    assert.equal(
      afterSetImage.iconSignature,
      snapshot.iconSignature,
      "reapplying the same bytes through setImage should keep the same native pixmap",
    );
    record(
      "a tray icon from bytes registers and updates like a path, and template is a harmless no-op on Linux",
      { snapshot, afterSetImage },
    );
    yield* Scope.close(trayScope, Exit.void);

    const emptyBytes = failure(
      yield* Effect.exit(Effect.scoped(Tray.make({ icon: new Uint8Array(0) }))),
    );
    assert.equal(emptyBytes.code, "Protocol");
    record("an empty byte array as a tray icon is refused Protocol before native creation", {
      error: errorFacts(emptyBytes),
    });
  });

const runShortcutChecks = () =>
  Effect.gen(function* () {
    const windowTitle = "Sewed global shortcut focus target";
    const windowScope = yield* Scope.fork(yield* Effect.scope);
    const window = yield* BrowserWindow.make({
      title: windowTitle,
      width: 420,
      height: 220,
      show: true,
    }).pipe(Scope.provide(windowScope));
    const nativeWindow = nativeWindowForTitle(windowTitle);
    yield* window.focus;
    const accelerator = "Control+Alt+Shift+H";
    const unrelated = "Control+Alt+Shift+J";
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        assert.equal(
          NativeGlobalShortcut.register(unrelated, () => {}),
          true,
        );
      }),
      () =>
        Effect.sync(() => {
          if (NativeGlobalShortcut.isRegistered(unrelated))
            NativeGlobalShortcut.unregister(unrelated);
        }),
    );
    const shortcutScope = yield* Scope.fork(yield* Effect.scope);
    const shortcut = yield* GlobalShortcut.register(accelerator).pipe(Scope.provide(shortcutScope));
    const first = yield* observe(shortcut.presses);
    const second = yield* observe(shortcut.presses);
    yield* sendX11Key(nativeWindow, "h", ["Control_L", "Alt_L", "Shift_L"]);
    yield* waitUntil(
      () => first.values.length === 1 && second.values.length === 1,
      "global shortcut press fanout",
    );
    assert.equal(NativeBrowserWindow.getFocusedWindow()?.getTitle(), windowTitle);
    record("X11 XTest delivers a registered global shortcut while another window is focused", {
      accelerator: shortcut.accelerator,
      target: windowTitle,
      firstPresses: first.values.length,
      secondPresses: second.values.length,
    });

    const duplicate = failure(
      yield* Effect.exit(GlobalShortcut.register(accelerator).pipe(Scope.provide(shortcutScope))),
    );
    assert.equal(duplicate.code, "Native");
    const invalid = failure(yield* Effect.exit(GlobalShortcut.register(" ")));
    assert.equal(invalid.code, "Native");
    record("duplicate and invalid global shortcut accelerators fail with typed Native errors", {
      duplicate: errorFacts(duplicate),
      invalid: errorFacts(invalid),
    });

    yield* Fiber.interrupt(second.fiber);
    const secondExit = yield* Fiber.await(second.fiber);
    const beforeCancellation = first.values.length;
    yield* sendX11Key(nativeWindow, "h", ["Control_L", "Alt_L", "Shift_L"]);
    yield* waitUntil(
      () => first.values.length === beforeCancellation + 1,
      "remaining global shortcut observer",
    );
    assert.equal(second.values.length, 1);
    yield* Scope.close(shortcutScope, Exit.void);
    const firstExit = yield* Fiber.await(first.fiber);
    assert.equal(firstExit._tag, "Success", exitFacts(firstExit));
    assert.equal(NativeGlobalShortcut.isRegistered(accelerator), false);
    assert.equal(NativeGlobalShortcut.isRegistered(unrelated), true);
    record(
      "shortcut scope cancellation ends observers, unregisters only its accelerator, and preserves unrelated native registration",
      {
        cancelled: exitFacts(secondExit),
        closed: exitFacts(firstExit),
        unrelatedStillRegistered: NativeGlobalShortcut.isRegistered(unrelated),
      },
    );

    const reRegisterScope = yield* Scope.fork(yield* Effect.scope);
    const reRegistered = yield* GlobalShortcut.register(accelerator).pipe(
      Scope.provide(reRegisterScope),
    );
    assert.equal(reRegistered.accelerator, accelerator);
    yield* Scope.close(reRegisterScope, Exit.void);
    assert.equal(NativeGlobalShortcut.isRegistered(accelerator), false);
    record("global shortcut can be registered again after its owner scope closes", {
      accelerator: reRegistered.accelerator,
    });

    yield* Scope.close(windowScope, Exit.void);
    assert.equal(
      NativeBrowserWindow.getAllWindows().some((candidate) => candidate.getTitle() === windowTitle),
      false,
    );
  });

const runChecks = Effect.gen(function* () {
  assert.ok(process.env.DISPLAY, "The native desktop fixture requires X11 DISPLAY");
  assert.ok(
    process.env.DBUS_SESSION_BUS_ADDRESS,
    "The fixture must run on its private D-Bus session",
  );
  const initialIcon = writeIcon(
    "tray-initial.png",
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR42mO4o6HxnxLMMGrAqAGjBgwXAwBpmSsfN7qQxQAAAABJRU5ErkJggg==",
  );
  const updatedIcon = writeIcon(
    "tray-updated.png",
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR42mPQCLjznxLMMGrAqAGjBgwXAwBaSVMf04DljgAAAABJRU5ErkJggg==",
  );
  const notifier = createNotifier();
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await notifier.stop();
      writeFileSync(
        join(artifactRoot, "notifier-events.json"),
        `${JSON.stringify(state.notifier.events, null, 2)}\n`,
      );
    }),
  );
  const ready = yield* Effect.promise(() =>
    notifier.waitFor((event) => event.event === "ready", "private StatusNotifier host"),
  );
  yield* runTrayChecks(notifier, initialIcon, updatedIcon);
  yield* runTrayBytesChecks(notifier, initialIcon);
  yield* runInjectedTrayConfigurationFailureCheck(initialIcon);
  yield* Effect.promise(() => notifier.stop());
  yield* runShortcutChecks();
  record("desktop native fixture ran against an X11 display and private StatusNotifier bus", {
    display: process.env.DISPLAY,
    dbus: process.env.DBUS_SESSION_BUS_ADDRESS,
    notifierReady: ready,
  });
});

const emitReport = (result) => {
  const report = {
    success: result._tag === "Success" && state.errors.length === 0,
    checks,
    errors: state.errors,
    platformLimits,
    platform: {
      os: process.platform,
      display: process.env.DISPLAY ?? null,
      dbusSession: Boolean(process.env.DBUS_SESSION_BUS_ADDRESS),
      scope:
        "Linux X11 + private D-Bus StatusNotifierWatcher; tray protocol and XTest are platform-specific",
    },
    error: result._tag === "Failure" ? Cause.pretty(result.cause) : undefined,
  };
  state.report = report;
  writeFileSync(
    join(artifactRoot, "desktop-resources-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`${marker} ${JSON.stringify(report)}`);
};

process.on("exit", () => {
  if (state.report !== undefined) return;
  const report = {
    success: false,
    checks,
    errors: [...state.errors, "fixture exited before reporting"],
    platformLimits,
    platform: { os: process.platform, display: process.env.DISPLAY ?? null },
  };
  try {
    writeFileSync(
      join(artifactRoot, "desktop-resources-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(`${marker} ${JSON.stringify(report)}`);
  } catch {
    // Preserve the original process exit if setup failed before the artifact root existed.
  }
});

App.run(
  [],
  Effect.gen(function* () {
    yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
    const result = yield* Effect.exit(runChecks);
    emitReport(result);
    if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
    yield* App.quit;
  }),
);
