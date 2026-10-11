import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow as NativeBrowserWindow, session as nativeSession } from "electron";
import { Cause, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { Decidables, Decision, Renderer } from "sewed";
import { App, BaseWindow, BrowserWindow, Clipboard, Image, Net, Protocol, Session, SystemPreferences, Tray, View, WebContentsView } from "sewed/main";

const execFileAsync = promisify(execFile);
const checks = [];
const served = [];
const record = (name, evidence = {}) => {
  checks.push({ name, evidence: structuredClone(evidence) });
  console.log(`PASS ${name}`);
};
const errorOf = (exit) => {
  assert.equal(exit._tag, "Failure", "expected a failure");
  const error = Cause.findErrorOption(exit.cause);
  assert.equal(error._tag, "Some", Cause.pretty(exit.cause));
  return error.value;
};

// A WebSocket echo server small enough to read: it answers the handshake and echoes unfragmented
// text frames of up to 125 bytes, which is all this fixture sends.
const echoServer = () =>
  new Promise((resolve) => {
    const server = createServer((request, response) => {
      served.push(request.url);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        request.url === "/inner"
          ? "<!doctype html><title>Sewed inner</title><p>inner</p>"
          : "<!doctype html><title>Sewed parity</title><p>parity</p>",
      );
    });
    server.on("upgrade", (request, socket) => {
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.on("data", (frame) => {
        const opcode = frame[0] & 0x0f;
        const length = frame[1] & 0x7f;
        if (opcode === 0x8) return socket.end(Buffer.from([0x88, 0x00]));
        if (opcode !== 0x1 || length > 125) return;
        const mask = frame.subarray(2, 6);
        const payload = Buffer.from(frame.subarray(6, 6 + length).map((byte, i) => byte ^ mask[i % 4]));
        socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      });
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

// A window stays busy after an interruption until its native dialog or menu has really gone,
// which the library reports as Limit; how long that takes is the platform's. This opens a prompt
// as soon as the window will take one.
const whenFree = (prompt) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 8_000;
    for (;;) {
      const fiber = yield* Effect.forkChild(Effect.exit(prompt));
      yield* Effect.sleep(300);
      const settled = fiber.pollUnsafe();
      if (settled === undefined) return fiber;
      const exit = settled._tag === "Success" ? settled.value : settled;
      const refused = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
      assert.ok(
        refused?._tag === "Some" && refused.value.code === "Limit" && Date.now() < deadline,
        `the prompt did not stay open: ${exit._tag === "Failure" ? Cause.pretty(exit.cause) : JSON.stringify(exit.value)}`,
      );
    }
  });

const runChecks = (server) =>
  Effect.scoped(
    Effect.gen(function* () {
      const window = yield* BrowserWindow.make({ show: true, width: 480, height: 360, title: "Sewed prompts" });
      const native = NativeBrowserWindow.getAllWindows().find((each) => each.getTitle() === "Sewed prompts");
      assert.ok(native, "the native window");

      // A message box is opened natively and closed by interrupting the Effect that shows it;
      // the window then takes the next one once the first has gone.
      for (const attempt of [1, 2, 3]) {
        const shown = yield* whenFree(
          window.dialog.message({ message: `Sewed prompt ${attempt}`, buttons: ["Cancel", "Continue"] }),
        );
        yield* Effect.sleep(300);
        assert.equal(shown.pollUnsafe(), undefined, "the dialog is still open, waiting for an answer");
        yield* Fiber.interrupt(shown);
      }
      record("a native message box opens, an interruption closes it, and the window takes the next");

      // The blocking form stops the main process until answered, so the answer has to come from
      // outside it: a helper process, started first, presses Return on the dialog through X11.
      // Linux only, where that helper exists.
      if (process.platform === "linux") {
        const title = `Sewed blocking ${process.pid}`;
        spawn(
          "sh",
          [
            "-c",
            // Presses Return once the dialog exists; it may open a moment late if the window was busy.
            `sleep 2; for i in $(seq 1 60); do out=$(python3 scripts/dialog-window.py ${process.pid} "${title}" Return); [ "$out" != "[]" ] && break; sleep 0.25; done`,
          ],
          { detached: true, stdio: "ignore" },
        ).unref();
        const started = Date.now();
        // The window refuses a blocking dialog, like any other, while an earlier one is closing.
        const blockingOptions = {
          title,
          message: "Sewed blocking prompt",
          buttons: ["Cancel", "Continue"],
          defaultId: 1,
          cancelId: 0,
        };
        let answer;
        for (const deadline = Date.now() + 8_000; ; ) {
          const attempt = yield* Effect.exit(window.dialog.messageBlocking(blockingOptions));
          if (attempt._tag === "Success") {
            answer = attempt.value;
            break;
          }
          assert.equal(errorOf(attempt).code, "Limit");
          assert.ok(Date.now() < deadline, "the window never became free for the blocking dialog");
          yield* Effect.sleep(100);
        }
        assert.equal(answer, 1, "Return chose the default button");
        assert.ok(Date.now() - started >= 1_500, "the call blocked until the dialog was answered");
        record("a blocking message box holds the main process until a person answers it", {
          answer,
          blockedMs: Date.now() - started,
        });
      }

      // A file dialog has no abort signal; closing its window is what dismisses it, and the
      // Effect then fails Closed.
      const pickerScope = yield* Scope.fork(yield* Effect.scope);
      const picker = yield* BrowserWindow.make({ show: true, width: 300, height: 200, title: "Sewed picker" }).pipe(
        Scope.provide(pickerScope),
      );
      const picking = yield* whenFree(picker.dialog.open({ mode: "file", title: "Sewed open" }));
      yield* Effect.sleep(500);
      yield* Scope.close(pickerScope, Exit.void);
      const picked = yield* Fiber.join(picking).pipe(Effect.timeoutOption("8 seconds"));
      assert.equal(picked._tag, "Some", "the open dialog's Effect settled once its window closed");
      assert.equal(errorOf(picked.value).code, "Closed");
      record("a native file dialog is dismissed by closing its window, and its Effect fails Closed");

      // A popup menu opens natively and an interruption closes it.
      for (const id of ["inspect", "again"]) {
        const popup = yield* whenFree(window.menu.popup({ items: [{ kind: "command", id, label: id }] }));
        yield* Effect.sleep(300);
        assert.equal(popup.pollUnsafe(), undefined, "the popup is still open");
        yield* Fiber.interrupt(popup);
      }
      record("a native popup menu opens, an interruption closes it, and the window takes the next");

      // A tray icon exists for its scope and takes its settings natively.
      const pixel = yield* Image.encode(
        { width: 2, height: 2, bytes: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]) },
        { format: "png" },
      );
      // One image given as an encoding per scale factor: a display at 2x gets the sharp one.
      const sharp = yield* Image.encode(
        { width: 4, height: 4, bytes: new Uint8Array(64).fill(255) },
        { format: "png" },
      );
      const scaledIcon = { representations: [{ scaleFactor: 1, bytes: pixel }, { scaleFactor: 2, bytes: sharp }] };
      assert.deepEqual(
        (({ width, height }) => ({ width, height }))(yield* Image.decode(scaledIcon)),
        { width: 2, height: 2 },
        "a scaled image has its 1x size",
      );
      const scaledScope = yield* Scope.fork(yield* Effect.scope);
      const scaledTray = yield* Effect.exit(Tray.make({ icon: scaledIcon }).pipe(Scope.provide(scaledScope)));
      assert.ok(Exit.isSuccess(scaledTray), "a tray takes a scaled icon");
      yield* Scope.close(scaledScope, Exit.void);
      assert.equal(
        errorOf(yield* Effect.exit(Image.decode({ representations: [{ scaleFactor: 2, bytes: new Uint8Array([1, 2, 3]) }] }))).code,
        "Protocol",
      );
      const trayScope = yield* Scope.fork(yield* Effect.scope);
      const tray = yield* Effect.exit(
        Tray.make({ icon: pixel, tooltip: "Sewed prompts" }).pipe(Scope.provide(trayScope)),
      );
      if (tray._tag === "Success") {
        yield* tray.value.setToolTip("Sewed prompts updated");
        yield* tray.value.setImage(pixel);
        yield* tray.value.setMenu({ items: [{ kind: "command", id: "open", label: "Open" }] });
        const guid = yield* Effect.exit(tray.value.guid);
        if (process.platform === "linux") assert.equal(errorOf(guid).code, "Native");
        else assert.equal(guid._tag, "Success");
        const balloon = yield* Effect.exit(tray.value.displayBalloon({ title: "Sewed", content: "Balloon" }));
        if (process.platform === "win32") {
          assert.equal(balloon._tag, "Success");
          yield* tray.value.removeBalloon;
        } else assert.equal(errorOf(balloon).code, "Native");
        assert.equal(errorOf(yield* Effect.exit(tray.value.displayBalloon({ title: "Sewed" }))).code, "Protocol");
      } else assert.equal(errorOf(tray).code, "Native", "a desktop without a tray refuses it as Native");
      yield* Scope.close(trayScope, Exit.void);
      record("a tray icon is created, configured and released natively", { created: tray._tag });

      // The application menu installs for a scope and reports its visibility stream's lifetime.
      const menuScope = yield* Scope.fork(yield* Effect.scope);
      const menu = yield* App.menu({
        items: [
          { kind: "submenu", label: "Sewed", items: [{ kind: "command", id: "about", label: "About" }] },
          { kind: "role", role: "editMenu" },
        ],
      }).pipe(Scope.provide(menuScope));
      const visibility = yield* menu.visibility.pipe(Stream.runDrain, Effect.forkChild);
      yield* menu.replace({
        items: [{ kind: "submenu", label: "Sewed", items: [{ kind: "command", id: "other", label: "Other" }] }],
      });
      yield* Fiber.interrupt(visibility);
      yield* Scope.close(menuScope, Exit.void);
      record("the application menu installs, is replaced, and releases with its scope");

      // A main-process WebSocket through Chromium's network stack.
      const address = server.address();
      const socketScope = yield* Scope.fork(yield* Effect.scope);
      const socket = yield* Net.webSocket(`ws://127.0.0.1:${address.port}/`).pipe(Scope.provide(socketScope));
      const received = yield* Effect.forkChild(Stream.runHead(socket.messages));
      yield* Effect.sleep(50);
      yield* socket.send("sewed echo");
      const echoed = yield* Fiber.join(received).pipe(Effect.timeoutOption("8 seconds"));
      assert.equal(echoed._tag, "Some", "an echo arrived");
      assert.equal(echoed.value._tag, "Some");
      assert.equal(echoed.value.value, "sewed echo");
      yield* Scope.close(socketScope, Exit.void);
      const refused = yield* Effect.exit(Effect.scoped(Net.webSocket("https://example.com/")));
      assert.equal(errorOf(refused).code, "Protocol");
      const unreachable = yield* Effect.exit(Effect.scoped(Net.webSocket("ws://127.0.0.1:9/")));
      assert.equal(errorOf(unreachable).code, "Native");
      record("a WebSocket opens through Chromium, echoes a message, and closes with its scope");

      const origin = `http://127.0.0.1:${address.port}`;

      // An installed menu item is read and changed in place.
      const editScope = yield* Scope.fork(yield* Effect.scope);
      const editable = yield* App.menu({
        items: [
          {
            kind: "submenu",
            label: "Sewed",
            items: [
              { kind: "command", id: "save", label: "Save" },
              { kind: "checkbox", id: "wrap", label: "Wrap", checked: false },
            ],
          },
        ],
      }).pipe(Scope.provide(editScope));
      assert.deepEqual(yield* editable.item("save"), { id: "save", label: "Save", enabled: true, visible: true, checked: false, commandId: (yield* editable.item("save")).commandId, userAccelerator: null });
      assert.equal(typeof (yield* editable.item("save")).commandId, "number");
      yield* editable.update("save", { label: "Save all", enabled: false });
      yield* editable.update("wrap", { checked: true });
      assert.deepEqual(yield* editable.item("save"), { id: "save", label: "Save all", enabled: false, visible: true, checked: false, commandId: (yield* editable.item("save")).commandId, userAccelerator: null });
      assert.equal((yield* editable.item("wrap")).checked, true);
      assert.equal(errorOf(yield* Effect.exit(editable.item("missing"))).code, "Protocol");
      assert.equal(errorOf(yield* Effect.exit(editable.update("save", { label: "" }))).code, "Protocol");
      yield* Scope.close(editScope, Exit.void);
      record("an installed menu item is read and updated in place");

      // A webview is denied without a decider. Allowed, it arrives as an owned handle with a
      // guest's gates, and it closes when its element goes.
      const webviewWindow = yield* BrowserWindow.make({ show: false, webviewTag: true, title: "Sewed webview" });
      const owned = [];
      const owning = yield* webviewWindow.webContents.webviews.pipe(
        Stream.runForEach((handle) => Effect.sync(() => owned.push(handle))),
        Effect.forkChild,
      );
      const hostBlocked = [];
      const hostWatch = yield* webviewWindow.webContents.blocked.pipe(
        Stream.runForEach((entry) => Effect.sync(() => hostBlocked.push(entry))),
        Effect.forkChild,
      );
      yield* Effect.sleep(50);
      yield* webviewWindow.webContents.load(Renderer.entry(new URL("/", origin), { bindings: [] }), { bindings: [] });
      const hostNative = NativeBrowserWindow.getAllWindows().find((each) => each.webContents.getURL() === `${origin}/`);
      assert.ok(hostNative, "the native host window");
      const inPage = (script) => Effect.promise(() => hostNative.webContents.executeJavaScript(script));
      const attach = () =>
        inPage(
          `(() => { const view = document.createElement("webview"); view.id = "inner"; view.src = ${JSON.stringify(`${origin}/inner`)}; document.body.append(view); })()`,
        );
      const waitFor = (read, description) =>
        Effect.gen(function* () {
          const deadline = Date.now() + 8_000;
          for (;;) {
            const value = read();
            if (value) return value;
            assert.ok(Date.now() < deadline, `Timed out: ${description}`);
            yield* Effect.sleep(20);
          }
        });
      yield* attach();
      yield* waitFor(() => hostBlocked.some((entry) => entry.kind === "webview"), "the undecided webview reported as blocked");
      assert.equal(owned.length, 0, "a denied webview is never owned");
      yield* inPage(`document.getElementById("inner").remove()`);
      yield* webviewWindow.webContents.decide(
        Decidables.WebContents.WebviewAttach,
        Decision.sync((event) => (event.src.endsWith("/inner") ? "allow" : "deny")),
      );
      yield* attach();
      const webview = yield* waitFor(() => owned[0], "the allowed webview arriving as a handle");
      assert.equal(typeof webview.id, "string");
      assert.equal(webview.hostId, webviewWindow.id);
      assert.ok((yield* webview.webContents.userAgent).length > 0, "an owned operation reaches the webview");
      // It is listed like any other owned web contents, under its own id.
      assert.ok((yield* App.allWebContents).some((entry) => entry.id === webview.id), "listed under its Sewed id");
      // Its own navigation is gated like a guest's: denied without a decider on its handle.
      const guestBlocked = [];
      const guestWatch = yield* webview.blocked.pipe(
        Stream.runForEach((entry) => Effect.sync(() => guestBlocked.push(entry))),
        Effect.forkChild,
      );
      yield* Effect.sleep(50);
      yield* inPage(`document.getElementById("inner").executeJavaScript(${JSON.stringify(`location.href = "${origin}/elsewhere"`)})`);
      yield* waitFor(() => guestBlocked.some((entry) => entry.kind === "navigation"), "the webview's own navigation denied");
      // The host page pointing the element elsewhere is a load nothing can prevent beforehand:
      // its request is cancelled before it is sent and it is reported, until the handle's decider
      // allows it.
      const urlOfInner = () => inPage(`document.getElementById("inner").getURL()`);
      yield* inPage(`document.getElementById("inner").src = ${JSON.stringify(`${origin}/moved`)}`);
      yield* waitFor(() => guestBlocked.some((entry) => entry.url.endsWith("/moved")), "the host-directed load stopped");
      yield* Effect.sleep(500);
      assert.equal(yield* urlOfInner(), `${origin}/inner`, "the webview stayed where it was");
      assert.equal(yield* inPage(`document.getElementById("inner").executeJavaScript("document.title")`), "Sewed inner");
      assert.ok(!served.includes("/moved"), "the denied load never reached the server");
      yield* webview.webContents.decide(
        Decidables.WebContents.Navigation,
        Decision.sync((event) => (event.url.endsWith("/granted") ? "allow" : "deny")),
      );
      yield* inPage(`document.getElementById("inner").src = ${JSON.stringify(`${origin}/granted`)}`);
      yield* waitFor(() => served.includes("/granted"), "the allowed host-directed load served");
      for (let attempt = 0; attempt < 200 && (yield* urlOfInner()) !== `${origin}/granted`; attempt++)
        yield* Effect.sleep(20);
      assert.equal(yield* urlOfInner(), `${origin}/granted`);
      // A handle is found by its Sewed id: the very object its owner holds, not a second one.
      assert.equal(yield* App.window(webviewWindow.id), webviewWindow, "the window found by id");
      const foundHost = yield* App.webContents(webview.hostId);
      assert.ok(foundHost !== null, "the host's web contents found by id");
      assert.ok((yield* foundHost.userAgent).length > 0);
      const foundGuest = yield* App.webContents(webview.id);
      assert.equal(foundGuest, webview.webContents, "the webview's web contents found by id");
      const plain = yield* Effect.scoped(
        Effect.gen(function* () {
          const base = yield* BaseWindow.make({ show: false });
          assert.equal(yield* App.window(base.id), base, "a base window found by id");
          return base;
        }),
      );
      assert.equal(yield* App.window(plain.id), null, "a window is not found once its scope closed");
      assert.equal(yield* App.window("no-such-id"), null);
      assert.equal(errorOf(yield* Effect.exit(App.window(7))).code, "Protocol");
      // Removing the element ends it: the handle closes and refuses further work.
      yield* inPage(`document.getElementById("inner").remove()`);
      const closed = yield* webview.awaitClosed.pipe(Effect.timeoutOption("8 seconds"));
      assert.equal(closed._tag, "Some", "the handle closed with its element");
      assert.equal(errorOf(yield* Effect.exit(webview.webContents.userAgent)).code, "Closed");
      assert.equal(yield* App.webContents(webview.id), null, "a closed webview is no longer found");
      // DevTools hosted in a view the program owns and places.
      const toolsView = yield* WebContentsView.make({});
      yield* webviewWindow.attach(toolsView, { bounds: { x: 0, y: 0, width: 400, height: 300 } });
      yield* webviewWindow.webContents.openDevToolsIn(toolsView, { activate: false });
      for (let attempt = 0; attempt < 400 && !(yield* webviewWindow.webContents.devTools).opened; attempt++)
        yield* Effect.sleep(20);
      assert.equal((yield* webviewWindow.webContents.devTools).opened, true, "DevTools opened");
      const toolsEntry = (yield* App.allWebContents).find((entry) => entry.id === toolsView.id);
      assert.ok(toolsEntry, "the hosting view is listed under its Sewed id");
      for (let attempt = 0; attempt < 400; attempt++) {
        const listed = (yield* App.allWebContents).find((entry) => entry.id === toolsView.id);
        if (listed?.url.startsWith("devtools://")) break;
        yield* Effect.sleep(20);
      }
      const hosted = (yield* App.allWebContents).find((entry) => entry.id === toolsView.id);
      assert.ok(hosted.url.startsWith("devtools://"), `DevTools live in the owned view: ${hosted.url}`);
      assert.equal(yield* webviewWindow.webContents.devToolsContentsId, hosted.nativeId);
      // A view that has loaded something cannot host them.
      assert.equal(errorOf(yield* Effect.exit(webviewWindow.webContents.openDevToolsIn(toolsView))).code, "Protocol");
      // They last as long as the view: closing it closes them.
      yield* toolsView.close;
      for (let attempt = 0; attempt < 400 && (yield* webviewWindow.webContents.devTools).opened; attempt++)
        yield* Effect.sleep(20);
      assert.equal((yield* webviewWindow.webContents.devTools).opened, false, "DevTools closed with their view");
      assert.equal(yield* App.webContents(toolsView.id), null, "a closed view's web contents is no longer found");
      record("handles are found by id, and DevTools open inside an owned view", { hosted: hosted.url.slice(0, 40) });
      yield* Fiber.interrupt(owning);
      yield* Fiber.interrupt(hostWatch);
      yield* Fiber.interrupt(guestWatch);
      record("an allowed webview is an owned handle with a guest's gates, and closes with its element", {
        blockedInside: guestBlocked.map((entry) => new URL(entry.url).pathname),
      });

      // A window a page opens is denied without a decider. Allowed, the library builds it, so it
      // is owned from its first moment: a guest's gates, none of its opener's privileges.
      const newWindow = (known) => NativeBrowserWindow.getAllWindows().find((each) => !known.has(each.id));
      const knownIds = () => new Set(NativeBrowserWindow.getAllWindows().map((each) => each.id));
      const beforeOpener = knownIds();
      const openerScope = yield* Scope.fork(yield* Effect.scope);
      const openerWindow = yield* BrowserWindow.make({ show: false, title: "Sewed opener" }).pipe(Scope.provide(openerScope));
      yield* openerWindow.webContents.load(Renderer.entry(new URL("/", origin), { bindings: [] }), { bindings: [] });
      const nativeOpener = newWindow(beforeOpener);
      assert.ok(nativeOpener, "the native opener window");
      const openFromPage = (path) =>
        Effect.promise(() => nativeOpener.webContents.executeJavaScript(`void window.open(${JSON.stringify(`${origin}${path}`)}, "_blank", "width=320,height=240")`, true));
      const openerBlocked = [];
      const openerWatch = yield* openerWindow.webContents.blocked.pipe(
        Stream.runForEach((entry) => Effect.sync(() => openerBlocked.push(entry))),
        Effect.forkChild,
      );
      const popups = [];
      const popupWatch = yield* openerWindow.webContents.popups.pipe(
        Stream.runForEach((handle) => Effect.sync(() => popups.push(handle))),
        Effect.forkChild,
      );
      yield* Effect.sleep(100);
      const windowsBefore = NativeBrowserWindow.getAllWindows().length;
      yield* openFromPage("/inner");
      yield* waitFor(() => openerBlocked.some((entry) => entry.kind === "popup"), "the undecided popup reported as blocked");
      assert.equal(NativeBrowserWindow.getAllWindows().length, windowsBefore, "a denied popup creates no window");
      yield* openerWindow.webContents.decide(
        Decidables.WebContents.Popup,
        Decision.sync((event) => (event.url.endsWith("/inner") ? "allow" : "deny")),
      ).pipe(Scope.provide(openerScope));
      const beforePopup = knownIds();
      yield* openFromPage("/inner");
      const popup = yield* waitFor(() => popups[0], "the allowed popup arriving as a handle");
      assert.equal(popup.openerId, openerWindow.id);
      const nativePopup = newWindow(beforePopup);
      assert.ok(nativePopup, "the native popup window");
      const preferences = nativePopup.webContents.getLastWebPreferences();
      assert.deepEqual(
        { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration, preload: preferences.preload ?? null },
        { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: null },
        "the popup has none of its opener's privileges",
      );
      assert.ok((yield* App.windows).some((entry) => entry.id === popup.id), "the popup is listed under its Sewed id");
      assert.equal(yield* App.webContents(popup.id), popup.webContents);
      assert.ok((yield* popup.webContents.userAgent).length > 0, "an owned operation reaches the popup");
      // Its own navigation is gated like a guest's.
      const popupBlocked = [];
      const popupBlockedWatch = yield* popup.blocked.pipe(
        Stream.runForEach((entry) => Effect.sync(() => popupBlocked.push(entry))),
        Effect.forkChild,
      );
      yield* Effect.sleep(100);
      yield* Effect.promise(() => nativePopup.webContents.executeJavaScript(`void setTimeout(() => { location.href = ${JSON.stringify(`${origin}/elsewhere`)}; }, 50)`, true));
      yield* waitFor(() => popupBlocked.some((entry) => entry.kind === "navigation"), "the popup's own navigation denied");
      // A popup of the popup is denied: nothing on its handle allows one.
      yield* Effect.promise(() => nativePopup.webContents.executeJavaScript(`void setTimeout(() => window.open(${JSON.stringify(`${origin}/inner`)}), 50)`, true));
      yield* waitFor(() => popupBlocked.some((entry) => entry.kind === "popup"), "the popup's own popup denied");
      // Closing it ends the handle.
      yield* popup.close;
      assert.equal((yield* popup.awaitClosed.pipe(Effect.timeoutOption("8 seconds")))._tag, "Some");
      assert.equal(errorOf(yield* Effect.exit(popup.webContents.userAgent)).code, "Closed");
      assert.equal(yield* App.webContents(popup.id), null);
      // A popup does not outlive the window that opened it.
      yield* openFromPage("/inner");
      const second = yield* waitFor(() => popups[1], "a second popup");
      yield* Fiber.interrupt(openerWatch);
      yield* Fiber.interrupt(popupWatch);
      yield* Fiber.interrupt(popupBlockedWatch);
      yield* Scope.close(openerScope, Exit.void);
      assert.equal((yield* second.awaitClosed.pipe(Effect.timeoutOption("8 seconds")))._tag, "Some", "the popup closed with its opener");
      record("an allowed popup is an owned window with a guest's gates, and closes with its opener", {
        blockedInside: popupBlocked.map((entry) => entry.kind),
      });

      // A window's own menu bar is the same owned menu the application's is.
      const barWindow = yield* BrowserWindow.make({ show: false, title: "Sewed bar" });
      const barScope = yield* Scope.fork(yield* Effect.scope);
      const barOptions = {
        items: [{ kind: "submenu", label: "Tools", items: [{ kind: "command", id: "sync", label: "Sync" }] }],
      };
      const bar = yield* barWindow.setMenu(barOptions).pipe(Scope.provide(barScope));
      assert.equal((yield* bar.item("sync")).label, "Sync");
      yield* bar.update("sync", { label: "Sync now", enabled: false });
      assert.deepEqual(
        (({ label, enabled }) => ({ label, enabled }))(yield* bar.item("sync")),
        { label: "Sync now", enabled: false },
      );
      assert.equal(errorOf(yield* Effect.exit(barWindow.setMenu(barOptions).pipe(Scope.provide(barScope)))).code, "Limit");
      yield* Scope.close(barScope, Exit.void);
      assert.equal(errorOf(yield* Effect.exit(bar.item("sync"))).code, "Closed");
      const barAgain = yield* Scope.fork(yield* Effect.scope);
      yield* barWindow.setMenu(barOptions).pipe(Scope.provide(barAgain));
      yield* Scope.close(barAgain, Exit.void);
      assert.equal(errorOf(yield* Effect.exit(App.dock.menu({ items: [{ kind: "command", id: "a", label: "A" }] }))).code, "Native");
      yield* barWindow.blur;
      // A person's keystroke on that window reaches its own menu's selections, and only them.
      if (process.platform === "linux") {
        const shownScope = yield* Scope.fork(yield* Effect.scope);
        const shownTitle = `Sewed shown bar ${process.pid}`;
        const shown = yield* BrowserWindow.make({ title: shownTitle, width: 420, height: 260 }).pipe(Scope.provide(shownScope));
        yield* shown.webContents.load(Renderer.entry(new URL("/", origin), { bindings: [] }), { bindings: [] });
        const shownMenu = yield* shown
          .setMenu({
            items: [
              {
                kind: "submenu",
                label: "Tools",
                items: [{ kind: "command", id: "bar-sync", label: "Sync", accelerator: "Control+Shift+B" }],
              },
            ],
          })
          .pipe(Scope.provide(shownScope));
        const chosen = [];
        const choosing = yield* shownMenu.selections.pipe(
          Stream.runForEach((selection) => Effect.sync(() => chosen.push(selection))),
          Effect.forkChild,
        );
        yield* shown.focus;
        yield* Effect.sleep(300);
        const nativeShown = NativeBrowserWindow.getAllWindows().find((each) => each.getTitle() === shownTitle || each.webContents.getURL() === `${origin}/` && each.isVisible());
        assert.ok(nativeShown, "the shown window");
        const press = () =>
          Effect.promise(() =>
            execFileAsync(
              "python3",
              ["scripts/application-menu-window.py", String(process.pid), String(nativeShown.getNativeWindowHandle().readUInt32LE(0)), "b", "Control_L", "Shift_L"],
              { timeout: 4_000 },
            ),
          );
        for (let attempt = 0; attempt < 5 && chosen.length === 0; attempt++) {
          yield* press();
          yield* Effect.sleep(300);
        }
        assert.deepEqual(chosen[0], { kind: "command", id: "bar-sync" }, "the keystroke chose the window menu's command");
        yield* Fiber.interrupt(choosing);
        yield* Scope.close(shownScope, Exit.void);
      }
      record("a window's menu bar is an owned menu of its own");

      // A window's root is a container the program owns, for a scope.
      const nativeBar = NativeBrowserWindow.getAllWindows().find((each) => each.getTitle() === "Sewed bar");
      assert.ok(nativeBar, "the native bar window");
      const ownRoot = nativeBar.contentView;
      const rootScope = yield* Scope.fork(yield* Effect.scope);
      const container = yield* View.make({ backgroundColor: "#102030" });
      assert.equal(yield* barWindow.contentViewId, null);
      yield* barWindow.setContentView(container).pipe(Scope.provide(rootScope));
      assert.notEqual(nativeBar.contentView, ownRoot, "the root was replaced natively");
      assert.equal(yield* barWindow.contentViewId, container.id);
      const inRoot = yield* WebContentsView.make({});
      yield* barWindow.attach(inRoot, { bounds: { x: 0, y: 0, width: 50, height: 50 } });
      assert.equal(nativeBar.contentView.children.length, 1, "a view attached meanwhile sits in the owned root");
      assert.equal(errorOf(yield* Effect.exit(barWindow.setContentView(inRoot))).code, "Protocol");
      yield* Scope.close(rootScope, Exit.void);
      assert.equal(nativeBar.contentView, ownRoot, "the window's own root returned");
      assert.equal(yield* barWindow.contentViewId, null);
      record("a container view is a window's root for a scope, and the original returns");

      // A view over a clone of another view's web contents, with a lifetime of its own.
      const firstScope = yield* Scope.fork(yield* Effect.scope);
      const first = yield* WebContentsView.make({}).pipe(Scope.provide(firstScope));
      yield* barWindow.attach(first, { bounds: { x: 0, y: 0, width: 200, height: 200 } });
      yield* first.webContents.load(Renderer.entry(new URL("/", origin), { bindings: [] }), { bindings: [] });
      const cloneScope = yield* Scope.fork(yield* Effect.scope);
      const twin = yield* WebContentsView.make({ cloneOf: first }).pipe(Scope.provide(cloneScope));
      const survivor = yield* WebContentsView.make({ cloneOf: first });
      assert.notEqual(twin.id, first.id);
      const listed = (yield* App.allWebContents).filter((entry) => [first.id, twin.id].includes(entry.id));
      assert.equal(new Set(listed.map((entry) => entry.nativeId)).size, 2, "two web contents");
      assert.equal(listed.find((entry) => entry.id === twin.id).url, `${origin}/`, "the clone carries the history");
      assert.equal(yield* twin.webContents.rendererProcessId, yield* first.webContents.rendererProcessId);
      assert.equal(errorOf(yield* Effect.exit(WebContentsView.make({ cloneOf: first, backgroundThrottling: false }))).code, "Protocol");
      yield* Scope.close(cloneScope, Exit.void);
      assert.ok((yield* first.webContents.userAgent).length > 0, "the original outlives its clone");

      // One frame of a page is addressed, and a frame or DevTools target leads to its handle.
      const [mainFrame] = yield* first.webContents.frameTree;
      assert.equal(mainFrame.top, mainFrame.routingId);
      assert.equal(mainFrame.detached, false);
      const addressed = first.webContents.frame(mainFrame);
      assert.equal((yield* addressed.info).url, `${origin}/`);
      assert.equal(errorOf(yield* Effect.exit(first.webContents.frame({ processId: 1, routingId: 987654 }).info)).code, "Protocol");
      const byFrame = yield* App.webContentsOf({ kind: "frame", processId: mainFrame.processId, routingId: mainFrame.routingId });
      assert.equal(byFrame, yield* App.webContents(first.id), "a frame leads to its owner's handle");
      const byToken = yield* App.webContentsOf({ kind: "frame-token", processId: mainFrame.processId, token: mainFrame.token });
      assert.equal(byToken, byFrame);
      const byTarget = yield* App.webContentsOf({ kind: "devtools-target", id: yield* first.webContents.devToolsTargetId });
      assert.equal(byTarget, byFrame);
      assert.equal(yield* App.webContentsOf({ kind: "frame", processId: 1, routingId: 987654 }), null);
      assert.equal(errorOf(yield* Effect.exit(App.webContentsOf({ kind: "frame" }))).code, "Protocol");
      yield* addressed.reload;
      yield* Scope.close(firstScope, Exit.void);
      assert.ok((yield* survivor.webContents.userAgent).length > 0, "a clone outlives its original");
      yield* survivor.close;
      record("a view clones another's web contents, and frames are addressed and lead to their handle");

      // Connections opened ahead of use, and a bitmap cropped as data.
      const before = served.length;
      yield* Session.preconnect(yield* Session.defaultSession, { url: origin, numSockets: 2 });
      assert.equal(errorOf(yield* Effect.exit(Session.preconnect(yield* Session.defaultSession, { url: "file:///etc" }))).code, "Protocol");
      assert.equal(served.length, before, "a preconnect sends no request");
      const cropped = Image.crop({ width: 2, height: 2, bytes: new Uint8Array(16).map((_, index) => index) }, { x: 1, y: 1, width: 1, height: 1 });
      assert.deepEqual([...cropped.bytes], [12, 13, 14, 15]);
      // The primary selection is a clipboard of its own on Linux.
      yield* Clipboard.selection.write({ kind: "text", text: "sewed selection" });
      assert.deepEqual(yield* Clipboard.selection.read("text"), { kind: "text", text: "sewed selection" });
      assert.ok((yield* Clipboard.selection.formats).includes("text"));
      assert.equal(errorOf(yield* Effect.exit(Clipboard.selection.read("nonsense"))).code, "Protocol");
      if (process.platform !== "darwin") {
        assert.equal(errorOf(yield* Effect.exit(SystemPreferences.userDefault("AppleInterfaceStyle", "string"))).code, "Native");
        assert.equal(errorOf(yield* Effect.exit(SystemPreferences.setUserDefault("sewed", { type: "integer", value: 1.5 }))).code, "Protocol");
      }
      record("preconnect, crop and the primary selection");

      // A scheme served straight from a directory, with no handler.
      const root = mkdtempSync(join(tmpdir(), "sewed-routes-"));
      writeFileSync(join(root, "index.html"), "<!doctype html><title>Sewed routed</title>");
      const session = yield* Session.defaultSession;
      const routed = Protocol.scheme("sewed-routed");
      const routeScope = yield* Scope.fork(yield* Effect.scope);
      yield* Protocol.serveFiles(session, routed, [{ root, index: "index.html" }]).pipe(Scope.provide(routeScope));
      assert.equal(yield* Session.isProtocolHandled(session, "sewed-routed"), true);
      const body = yield* Effect.promise(() =>
        nativeSession.defaultSession.fetch("sewed-routed://app/").then((response) => response.text()),
      );
      assert.ok(body.includes("Sewed routed"), body);
      yield* Scope.close(routeScope, Exit.void);
      assert.equal(yield* Session.isProtocolHandled(session, "sewed-routed"), false);
      const relative = yield* Effect.exit(Effect.scoped(Protocol.serveFiles(session, routed, [{ root: "relative" }])));
      assert.equal(errorOf(relative).code, "Protocol");
      record("a scheme is served from a directory with no handler, for its scope");
    }),
  );

async function verify() {
  await app.whenReady();
  const server = await echoServer();
  App.run(
    [],
    Effect.gen(function* () {
      yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
      const result = yield* Effect.exit(runChecks(server));
      server.close();
      console.log(
        `PROMPTS_VERIFICATION ${JSON.stringify({
          success: result._tag === "Success",
          checks,
          error: result._tag === "Failure" ? Cause.pretty(result.cause) : undefined,
          platform: process.platform,
        })}`,
      );
      if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
      yield* App.quit;
    }),
  );
}

void verify().catch((error) => {
  console.error(error);
  app.exit(1);
});
