import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app, BrowserWindow as NativeWindow, Menu as NativeMenu } from "electron";
import { Cause, Deferred, Effect, Exit, Fiber, PubSub, Schema, Scope, Stream } from "effect";
import { Binding, Decidables, Decision, Menu, Renderer } from "sewed";
import { App, BrowserWindow, host } from "sewed/main";
import { MenuEvents, MenuEventsSlot } from "./application-menu-contract.mjs";

const execFileAsync = promisify(execFile);
const checks = [];
const windows = [];
const record = (name, evidence = {}) => {
  checks.push({ name, evidence: structuredClone(evidence) });
  console.log(`PASS ${name}`);
};
const options = () => ({
  items: [
    {
      kind: "submenu",
      label: "&Actions",
      items: [
        {
          kind: "command",
          id: "disabled",
          label: "Disabled",
          enabled: false,
          accelerator: "Control+Shift+X",
        },
        { kind: "command", id: "inspect", label: "Inspect", accelerator: "Control+Shift+K" },
        {
          kind: "checkbox",
          id: "details",
          label: "Details",
          checked: false,
          accelerator: "Control+Shift+D",
        },
        { kind: "separator" },
        {
          kind: "submenu",
          label: "Size",
          items: [
            { kind: "radio", id: "small", label: "Small", checked: true },
            { kind: "radio", id: "large", label: "Large", checked: false },
          ],
        },
        { kind: "role", role: "close" },
      ],
    },
    { kind: "role", role: "editMenu" },
  ],
});
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
const failure = (exit) => {
  assert.equal(exit._tag, "Failure");
  const error = Cause.findErrorOption(exit.cause);
  assert.equal(error._tag, "Some", Cause.pretty(exit.cause));
  return error.value;
};
const evaluate = (window, source) =>
  Effect.promise(() => window.native.webContents.executeJavaScript(source));
const key = (window, name, ...modifiers) =>
  Effect.promise(async () => {
    const { stdout } = await execFileAsync(
      "python3",
      [
        "scripts/application-menu-window.py",
        String(process.pid),
        String(window.nativeId),
        name,
        ...modifiers,
      ],
      { timeout: 2_000 },
    );
    return JSON.parse(stdout);
  }).pipe(Effect.andThen(Effect.sleep(40)));
const command = (window) => key(window, "k", "Control_L", "Shift_L");
const visibleMenus = (window) =>
  Effect.promise(async () => {
    const { stdout } = await execFileAsync(
      "python3",
      ["scripts/menu-window.py", String(process.pid), String(window.nativeId)],
      { timeout: 2_000 },
    );
    return JSON.parse(stdout);
  });
const makeWindow = (name) =>
  Effect.gen(function* () {
    const title = `Sewed application menu ${process.pid} ${name}`;
    const handle = yield* BrowserWindow.make({ title, width: 560, height: 360 });
    const native = NativeWindow.getAllWindows().find((window) => window.getTitle() === title);
    assert.ok(native);
    yield* handle.webContents.load(
      Renderer.entry(new URL("./application-menu-renderer/idle.html", import.meta.url), {
        bindings: [],
      }),
      { bindings: [] },
    );
    yield* handle.focus;
    yield* Effect.sleep(100);
    const window = { handle, native, nativeId: native.getNativeWindowHandle().readUInt32LE(0) };
    windows.push(window);
    return window;
  });
const observe = (stream, handle = () => Effect.void) =>
  Effect.gen(function* () {
    const values = [];
    const fiber = yield* stream.pipe(
      Stream.runForEach((value) =>
        Effect.andThen(
          Effect.sync(() => values.push(value)),
          handle(value),
        ),
      ),
      Effect.forkScoped,
    );
    return { values, fiber };
  });
const waitValues = (observer, length) =>
  waitUntil(
    Effect.sync(() => observer.values.length === length),
    `menu selection count ${length}`,
  );
const sendCommand = (window, observer) =>
  Effect.gen(function* () {
    const next = observer.values.length + 1;
    yield* command(window);
    yield* waitValues(observer, next);
  });
const inject = (id = "inspect") => {
  const item = NativeMenu.getApplicationMenu().getMenuItemById(id);
  assert.ok(item);
  item.click({}, undefined, undefined);
};

const runFixture = async () => {
  await app.whenReady();
  const scenario = app.commandLine.getSwitchValue("sewed-menu-case") || "full";
  const fault = ["invalid", "construction", "installation"].includes(scenario);
  const settings = options();
  settings.items[0].items.push({ kind: "role", role: "quit" });
  let leaked = 0;
  Object.assign(settings.items[0].items[1], {
    role: "quit",
    click: () => {
      leaked += 1;
    },
    submenu: [],
  });
  const before = NativeMenu.getApplicationMenu();
  assert.equal(NativeMenu.getApplicationMenu(), before);
  let constructors = 0;
  let installations = 0;
  let startupError = "";
  let setupStarted = false;
  let outcome;
  let installed;
  let lastWindow;
  const buildFromTemplate = NativeMenu.buildFromTemplate;
  const setApplicationMenu = NativeMenu.setApplicationMenu;
  NativeMenu.buildFromTemplate = (...args) => {
    constructors += 1;
    if (scenario === "construction") throw new Error("injected menu construction failure");
    return buildFromTemplate(...args);
  };
  NativeMenu.setApplicationMenu = (menu) => {
    installations += 1;
    setApplicationMenu(menu);
    if (scenario === "installation") throw new Error("injected menu installation failure");
  };
  const stderr = console.error;
  console.error = (...args) => {
    startupError += args.join(" ");
    stderr(...args);
    // App.run reports startup errors before app.exit, which does not emit quit.
    if (fault) report(1);
  };

  const runChecks = (menu) =>
    Effect.gen(function* () {
      setupStarted = true;
      if (scenario === "none") {
        assert.equal(menu, undefined);
        assert.equal(installations, 0);
        assert.equal(NativeMenu.getApplicationMenu(), before);
        record(
          "an app that never calls App.menu keeps Electron's default menu and has no observers",
        );
        return;
      }
      const stream = menu.selections;
      installed = NativeMenu.getApplicationMenu();
      assert.notEqual(installed, before);
      assert.equal(installations, 1);
      assert.ok(constructors > 0);
      record("App.menu installs the menu once acquired, before the rest of setup runs");

      const secondMenu = failure(yield* Effect.exit(Effect.scoped(App.menu(options()))));
      assert.equal(secondMenu.code, "Limit");
      assert.equal(installations, 1);
      assert.equal(NativeMenu.getApplicationMenu(), installed);
      record("a second live application menu fails Limit while the first stays installed");

      settings.items[0].items[1].label = "Mutated after startup";
      const custom = installed.getMenuItemById("inspect");
      assert.equal(custom.label, "Inspect");
      assert.equal(custom.accelerator, "Control+Shift+K");
      assert.equal(custom.role, null);
      assert.equal(custom.submenu, null);
      assert.equal(installed.items[1].role, "editmenu");
      record("validated options are copied and native roles cannot be injected into custom commands");

      const events = yield* PubSub.bounded(128);
      let subscribers = 0;
      const owner = yield* host(
        MenuEvents,
        MenuEvents.toLayer({
          selections: () =>
            Stream.unwrap(
              Effect.acquireRelease(
                Effect.sync(() => {
                  subscribers += 1;
                  return Stream.fromPubSub(events);
                }),
                () =>
                  Effect.sync(() => {
                    subscribers -= 1;
                  }),
              ),
            ),
        }),
      );
      const primary = yield* observe(stream, (selection) => PubSub.publish(events, selection));
      const initial = yield* makeWindow("initial");
      yield* key(initial, "a", "Alt_L");
      yield* key(initial, "Home");
      yield* key(initial, "Return");
      yield* waitValues(primary, 1);
      assert.deepEqual(primary.values, [{ kind: "command", id: "inspect" }]);
      assert.equal(leaked, 0);
      record("real menu bar navigation skips disabled commands and uses Sewed's guarded callback");

      yield* key(initial, "x", "Control_L", "Shift_L");
      yield* sendCommand(initial, primary);
      assert.equal(primary.values.length, 2);
      record("native accelerators dispatch enabled commands and ignore disabled commands");
      yield* key(initial, "d", "Control_L", "Shift_L");
      yield* waitValues(primary, 3);
      yield* key(initial, "d", "Control_L", "Shift_L");
      yield* waitValues(primary, 4);
      assert.deepEqual(primary.values.slice(2), [
        { kind: "checkbox", id: "details", checked: true },
        { kind: "checkbox", id: "details", checked: false },
      ]);
      record("checkbox selections report the actual native checked state");
      for (const [name, modifiers] of [
        ["a", ["Alt_L"]],
        ["Home", []],
        ["Down", []],
        ["Down", []],
        ["Right", []],
        ["Down", []],
        ["Return", []],
      ])
        yield* key(initial, name, ...modifiers);
      yield* waitValues(primary, 5);
      assert.deepEqual(primary.values[4], { kind: "radio", id: "large" });
      assert.equal(installed.getMenuItemById("large").checked, true);
      assert.equal(installed.getMenuItemById("small").checked, false);
      record("nested native radio selection updates its adjacent group");

      const second = yield* observe(stream);
      yield* Effect.sleep(10);
      assert.equal(second.values.length, 0);
      yield* sendCommand(initial, primary);
      yield* waitValues(second, 1);
      assert.deepEqual(second.values[0], primary.values.at(-1));
      yield* Fiber.interrupt(second.fiber);
      yield* sendCommand(initial, primary);
      assert.equal(second.values.length, 1);
      assert.equal(NativeMenu.getApplicationMenu(), installed);
      record(
        "observers receive future events independently and interruption removes only that observer",
      );

      const future = yield* makeWindow("future");
      yield* sendCommand(future, primary);
      assert.equal(installations, 1);
      record("future windows inherit the application menu without another installation");
      const entry = Renderer.entry(
        new URL("../.artifacts/application-menu-renderer/index.html", import.meta.url),
        { bindings: [MenuEventsSlot] },
      );
      yield* future.handle.webContents.load(entry, { bindings: [Binding.to(MenuEventsSlot, owner)] });
      yield* waitUntil(
        Effect.sync(() => subscribers === 1),
        "bound renderer subscription",
      );
      yield* sendCommand(future, primary);
      assert.deepEqual(
        yield* waitUntil(
          evaluate(future, "window.applicationMenuFixture?.selections[0]"),
          "renderer selection",
        ),
        { kind: "command", id: "inspect" },
      );
      record("native selections reach the renderer through an explicitly bound main host", {
        owner: owner.id,
      });
      const session = yield* evaluate(future, "window.applicationMenuFixture.session");
      yield* future.handle.webContents.reload;
      yield* waitUntil(
        evaluate(
          future,
          `Boolean(window.applicationMenuFixture && window.applicationMenuFixture.session !== ${JSON.stringify(session)})`,
        ),
        "fresh renderer document",
      );
      yield* waitUntil(
        Effect.sync(() => subscribers === 1),
        "one bound subscription after reload",
      );
      yield* sendCommand(future, primary);
      assert.deepEqual(
        yield* waitUntil(
          evaluate(future, "window.applicationMenuFixture.selections[0]"),
          "fresh renderer event",
        ),
        { kind: "command", id: "inspect" },
      );
      assert.equal(installations, 1);
      record(
        "document reload releases its client subscription while main's menu observation survives",
      );

      const beforeRoles = primary.values.length;
      yield* evaluate(future, "document.getElementById('editor').focus()");
      yield* key(future, "a", "Control_L");
      const selected = yield* evaluate(
        future,
        "(() => { const e = document.getElementById('editor'); return e.value.slice(e.selectionStart, e.selectionEnd); })()",
      );
      assert.equal(selected, "Sewed native editing fixture");
      yield* key(future, "c", "Control_L");
      yield* evaluate(future, "document.getElementById('editor').value = ''");
      yield* key(future, "v", "Control_L");
      assert.equal(yield* evaluate(future, "document.getElementById('editor').value"), selected);
      assert.equal(primary.values.length, beforeRoles);
      record("native Select All, Copy and Paste edit the focused renderer without custom selections");
      yield* key(future, "w", "Control_L");
      yield* future.handle.awaitClosed;
      assert.equal(initial.native.isDestroyed(), false);
      yield* sendCommand(initial, primary);
      assert.equal(installations, 1);
      record(
        "the native Close role closes only the focused window and leaves the application menu alive",
      );

      const once = yield* observe(stream.pipe(Stream.take(1)));
      yield* sendCommand(initial, primary);
      yield* Fiber.join(once.fiber);
      assert.deepEqual(once.values, [{ kind: "command", id: "inspect" }]);
      assert.equal(NativeMenu.getApplicationMenu(), installed);
      record("normal observer completion preserves menu ownership");

      const scope = yield* Scope.fork(yield* Effect.scope);
      const pending = yield* observe(stream, () => Effect.never).pipe(Scope.provide(scope));
      yield* sendCommand(initial, primary);
      yield* waitValues(pending, 1);
      yield* Scope.close(scope, Exit.void);
      const scopedExit = yield* Fiber.await(pending.fiber);
      assert.equal(scopedExit._tag, "Failure");
      assert.equal(Cause.hasInterruptsOnly(scopedExit.cause), true);
      assert.equal(NativeMenu.getApplicationMenu(), installed);
      record(
        "scope closure interrupts a running observer handler without removing the application menu",
      );
      const handlerError = new Error("fixture command failure");
      const failed = yield* observe(stream, () => Effect.fail(handlerError));
      yield* sendCommand(initial, primary);
      assert.equal(failure(yield* Fiber.await(failed.fiber)), handlerError);
      yield* sendCommand(initial, primary);
      record("an observer's handler error propagates while other observers remain usable");

      const invalid = [
        { items: [] },
        { items: [{ kind: "command", id: "a", label: "A" }] },
        { items: [{ kind: "role", role: "copy" }] },
        { items: [{ kind: "submenu", label: "A", items: [] }] },
        { items: [{ kind: "submenu", label: "A", items: [{ kind: "separator" }] }] },
        { items: [{ kind: "role", role: "unknown" }] },
        {
          items: [
            { kind: "submenu", label: "A", items: [{ kind: "checkbox", id: "a", label: "A" }] },
          ],
        },
        {
          items: [
            {
              kind: "submenu",
              label: "A",
              items: [{ kind: "command", id: "a", label: "A", accelerator: 1 }],
            },
          ],
        },
        {
          items: [
            {
              kind: "submenu",
              label: "A",
              items: [{ kind: "command", id: "a", label: "A", accelerator: "" }],
            },
          ],
        },
        { items: [options().items[0], options().items[0]] },
      ];
      const constructionCount = constructors;
      for (const value of invalid)
        assert.throws(() => Schema.decodeUnknownSync(Menu.ApplicationOptions)(value));
      assert.equal(constructors, constructionCount);
      record("inert schemas reject invalid trees, roles, accelerators and duplicate IDs", {
        cases: invalid.length,
      });

      const beforePopup = primary.values.length;
      const popup = yield* Effect.forkScoped(
        initial.handle.menu.popup({ items: [{ kind: "command", id: "context", label: "Context" }] }),
      );
      yield* waitUntil(
        visibleMenus(initial).pipe(Effect.map((windows) => windows.length > 0)),
        "native context popup",
      );
      yield* key(initial, "Home");
      yield* key(initial, "Return");
      assert.deepEqual(yield* Fiber.join(popup), { kind: "command", id: "context" });
      assert.equal(primary.values.length, beforePopup);
      assert.equal(NativeMenu.getApplicationMenu(), installed);
      record("request-owned context popups remain separate from application menu selections");

      const gate = yield* Deferred.make();
      const slow = yield* observe(stream, () => Deferred.await(gate));
      yield* sendCommand(initial, primary);
      yield* waitValues(slow, 1);
      const fastBefore = primary.values.length;
      for (let index = 0; index < 160; index += 1) {
        inject();
        yield* Effect.sleep(1);
      }
      yield* waitValues(primary, fastBefore + 160);
      yield* Deferred.succeed(gate, undefined);
      assert.equal(failure(yield* Fiber.await(slow.fiber)).code, "Limit");
      assert.equal(slow.values.length, 129);
      yield* sendCommand(initial, primary);
      assert.equal(NativeMenu.getApplicationMenu(), installed);
      record("a slow observer drains its bounded queue and fails without stopping a fast observer", {
        slowDelivered: slow.values.length,
        injectedCallbackBurst: 160,
      });

      const survivor = yield* observe(stream);
      yield* key(initial, "a", "Alt_L");
      yield* waitUntil(
        visibleMenus(initial).pipe(Effect.map((windows) => windows.length > 0)),
        "open application submenu",
      );
      yield* Fiber.interrupt(primary.fiber);
      assert.equal(NativeMenu.getApplicationMenu(), installed);
      assert.ok((yield* visibleMenus(initial)).length > 0);
      yield* key(initial, "Home");
      yield* key(initial, "Return");
      yield* waitValues(survivor, 1);
      record("stopping an observer leaves an open native submenu usable by the application owner");

      yield* initial.handle.close;
      yield* initial.handle.awaitClosed;
      assert.equal(NativeWindow.getAllWindows().length, 0);
      assert.equal(NativeMenu.getApplicationMenu(), installed);
      lastWindow = yield* makeWindow("explicitly reopened");
      yield* sendCommand(lastWindow, survivor);
      assert.equal(installations, 1);
      record("the menu survives having no windows and attaches to an explicitly created window");
      yield* key(lastWindow, "a", "Alt_L");
      yield* waitUntil(
        visibleMenus(lastWindow).pipe(Effect.map((windows) => windows.length > 0)),
        "submenu open before replacement",
      );
      const openBeforeReplacement = (yield* visibleMenus(lastWindow)).length;
      const replacement = options();
      replacement.items[0].items[1] = {
        kind: "command",
        id: "replaced",
        label: "Replaced",
        accelerator: "Control+Shift+K",
      };
      yield* menu.replace(replacement);
      const replacedMenu = NativeMenu.getApplicationMenu();
      assert.notEqual(replacedMenu, installed);
      assert.equal(installations, 2);
      assert.ok(replacedMenu.getMenuItemById("replaced"));
      assert.equal(replacedMenu.getMenuItemById("inspect"), null);
      const visibleAfterReplacement = (yield* visibleMenus(lastWindow)).length;
      yield* key(lastWindow, "Escape");
      yield* key(lastWindow, "Escape");
      const selectionsBefore = survivor.values.length;
      installed.getMenuItemById("inspect").click({}, undefined, undefined);
      yield* Effect.sleep(200);
      assert.equal(survivor.values.length, selectionsBefore);
      yield* command(lastWindow);
      yield* waitValues(survivor, selectionsBefore + 1);
      assert.deepEqual(survivor.values.at(-1), { kind: "command", id: "replaced" });
      const invalidReplacement = failure(yield* Effect.exit(menu.replace({ items: [] })));
      assert.equal(invalidReplacement.code, "Protocol");
      assert.equal(installations, 2);
      assert.equal(NativeMenu.getApplicationMenu(), replacedMenu);
      record("replacing the application menu while a submenu is open installs the new menu and silences the old one", {
        installations,
        openBeforeReplacement,
        visibleAfterReplacement,
        selection: survivor.values.at(-1),
      });

      // Every Electron role but `shareMenu`, and a submenu carrying the `help` role. The
      // top-level submenu keeps the "&Actions" mnemonic so the trailing shutdown-with-open-
      // submenu check below still opens something with Alt+A.
      const sevenRoles = ["services", "hide", "hideOthers", "unhide", "front", "zoom", "help"];
      yield* menu.replace({
        items: [
          {
            kind: "submenu",
            label: "&Actions",
            items: sevenRoles.map((role) => ({ kind: "role", role })),
          },
          {
            kind: "submenu",
            role: "help",
            label: "&Help",
            items: [{ kind: "command", id: "help-item", label: "Help item" }],
          },
        ],
      });
      const rolesMenu = NativeMenu.getApplicationMenu();
      assert.equal(installations, 3);
      // Electron's native MenuItem.role getter reports every role lowercased (the same reason
      // `installed.items[1].role` above reads back as "editmenu" for `role: "editMenu"`), so the
      // recorded labels are keyed by the role Sewed was given, not by the native's own casing.
      const roleLabels = Object.fromEntries(
        rolesMenu.items[0].submenu.items.map((item, index) => [
          sevenRoles[index],
          { native: item.role, label: item.label },
        ]),
      );
      for (const role of sevenRoles)
        assert.equal(roleLabels[role]?.native, role.toLowerCase(), `${role} is present`);
      assert.equal(rolesMenu.items[1].role, "help");
      const helpItemLabels = rolesMenu.items[1].submenu.items.map((item) => item.label);
      assert.ok(helpItemLabels.includes("Help item"));
      record(
        "every one of the seven roles Jobwright's menu needs builds with Electron's own label, and a submenu carrying the help role keeps its custom item",
        { roleLabels, helpItemLabels },
      );

      yield* key(lastWindow, "a", "Alt_L");
      yield* waitUntil(
        visibleMenus(lastWindow).pipe(Effect.map((windows) => windows.length > 0)),
        "submenu before application shutdown",
      );
    });

  const report = (exitCode) => {
    let error;
    try {
      if (fault) {
        assert.equal(exitCode, 1);
        assert.equal(setupStarted, false);
        if (scenario === "invalid") {
          assert.match(startupError, /Invalid application menu/);
          assert.equal(constructors, 0);
          assert.equal(installations, 0);
        } else {
          assert.match(startupError, /Could not install application menu/);
          assert.match(startupError, new RegExp(`injected menu ${scenario} failure`));
          assert.equal(installations, scenario === "installation" ? 1 : 0);
        }
        record(`application startup rejects ${scenario} before running setup`, {
          expectedExitCode: exitCode,
          constructors,
          installations,
          injected: scenario !== "invalid",
        });
      } else {
        assert.equal(exitCode, 0);
        assert.equal(
          outcome?._tag,
          "Success",
          outcome?._tag === "Failure" ? Cause.pretty(outcome.cause) : "setup did not finish",
        );
        if (scenario === "full") {
          assert.ok(windows.every((window) => window.native.isDestroyed()));
          assert.equal(NativeWindow.getAllWindows().length, 0);
          record("application shutdown closes its scoped window owners before process exit");
        }
      }
    } catch (cause) {
      error = cause.stack;
    }
    console.log(
      `APPLICATION_MENU_VERIFICATION ${JSON.stringify({ success: error === undefined, checks, error, scenario, pid: process.pid, lastWindow: lastWindow?.nativeId, platform: { os: process.platform, ozone: "x11", nativeInput: "XTest menu bar navigation, shortcuts and editing roles" } })}`,
    );
  };
  app.once("quit", (_event, exitCode) => report(exitCode));
  const menuOptions =
    scenario === "invalid" ? { items: [settings.items[0], settings.items[0]] } : settings;
  App.run(
    [],
    Effect.gen(function* () {
      const menu = scenario === "none" ? undefined : yield* App.menu(menuOptions);
      yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
      outcome = yield* Effect.exit(runChecks(menu));
      if (outcome._tag === "Failure") return yield* Effect.failCause(outcome.cause);
      yield* App.quit;
    }),
  );
};
runFixture().catch((error) => {
  console.error(error);
  app.exit(1);
});
