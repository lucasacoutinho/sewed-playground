import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow as NativeBrowserWindow, session as nativeSession } from "electron";
import { Cause, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { Decidables, Decision, Renderer } from "sewed";
import { App, BrowserWindow, Image, Native, Net, Protocol, Session, Tray } from "sewed/main";

const checks = [];
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

      // The native bridge: Electron's own object behind a handle, for one function.
      const origin = `http://127.0.0.1:${address.port}`;
      assert.equal(yield* Native.window(window, (each) => each.getTitle()), "Sewed prompts");
      assert.equal(
        yield* Native.window(window, async (each) => each.getContentView().constructor.name.length > 0),
        true,
      );
      assert.equal(typeof (yield* Native.session(yield* Session.defaultSession, (each) => each.getUserAgent())), "string");
      assert.equal(
        errorOf(yield* Effect.exit(Native.window(window, () => { throw new Error("boom"); }))).code,
        "Native",
      );
      assert.equal(errorOf(yield* Effect.exit(Native.window({ id: "not-a-window" }, () => 1))).code, "Protocol");
      const goneScope = yield* Scope.fork(yield* Effect.scope);
      const gone = yield* BrowserWindow.make({ show: false, title: "Sewed gone" }).pipe(Scope.provide(goneScope));
      yield* Scope.close(goneScope, Exit.void);
      assert.equal(errorOf(yield* Effect.exit(Native.window(gone, (each) => each.getTitle()))).code, "Closed");
      record("the native bridge reaches the object behind a handle and keeps typed failures at its edge");

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
      assert.deepEqual(yield* editable.item("save"), { id: "save", label: "Save", enabled: true, visible: true, checked: false });
      yield* editable.update("save", { label: "Save all", enabled: false });
      yield* editable.update("wrap", { checked: true });
      assert.deepEqual(yield* editable.item("save"), { id: "save", label: "Save all", enabled: false, visible: true, checked: false });
      assert.equal((yield* editable.item("wrap")).checked, true);
      assert.equal(errorOf(yield* Effect.exit(editable.item("missing"))).code, "Protocol");
      assert.equal(errorOf(yield* Effect.exit(editable.update("save", { label: "" }))).code, "Protocol");
      yield* Scope.close(editScope, Exit.void);
      record("an installed menu item is read and updated in place");

      // Raw IPC with a page that carries its own preload.
      const ipcSession = yield* Session.fromPartition({ kind: "memory", name: `ipc-${process.pid}` });
      const preload = join(mkdtempSync(join(tmpdir(), "sewed-ipc-")), "preload.js");
      writeFileSync(
        preload,
        `const { ipcRenderer } = require("electron");
ipcRenderer.on("reply", (_event, value) => ipcRenderer.send("got", value));
window.addEventListener("DOMContentLoaded", () => {
  ipcRenderer.send("hello", { n: 1 }, "text");
  ipcRenderer.send("answered", ipcRenderer.sendSync("ask", "question"));
});
`,
      );
      yield* Session.registerPreloadScript(ipcSession, { type: "frame", filePath: preload });
      const ipcWindow = yield* BrowserWindow.make({ show: false, session: ipcSession, title: "Sewed ipc" });
      const ipcReceived = [];
      const listening = yield* ipcWindow.webContents.ipc.messages.pipe(
        Stream.runForEach((message) => Effect.sync(() => ipcReceived.push(message))),
        Effect.forkChild,
      );
      yield* ipcWindow.webContents.ipc.answerSync((message) => ({ heard: message.args[0] }));
      yield* Effect.sleep(50);
      yield* ipcWindow.webContents.load(Renderer.entry(new URL("/", origin), { bindings: [] }), { bindings: [] });
      const waitFor = (channel) =>
        Effect.gen(function* () {
          const deadline = Date.now() + 8_000;
          for (;;) {
            const found = ipcReceived.find((message) => message.channel === channel);
            if (found !== undefined) return found;
            assert.ok(Date.now() < deadline, `no "${channel}" message arrived: ${JSON.stringify(ipcReceived)}`);
            yield* Effect.sleep(20);
          }
        });
      const hello = yield* waitFor("hello");
      assert.deepEqual(hello.args, [{ n: 1 }, "text"]);
      assert.equal(hello.frame.isMainFrame, true);
      assert.deepEqual((yield* waitFor("answered")).args, [{ heard: "question" }]);
      yield* ipcWindow.webContents.ipc.send("reply", "pong");
      assert.deepEqual((yield* waitFor("got")).args, ["pong"]);
      yield* Fiber.interrupt(listening);
      record("raw IPC reaches main from a page's own preload, is answered synchronously, and is sent back");

      // A webview is denied without a decider and attaches, locked down, when one allows it.
      const webviewWindow = yield* BrowserWindow.make({ show: false, webviewTag: true, title: "Sewed webview" });
      const pageEvents = [];
      const watching = yield* webviewWindow.webContents.events.pipe(
        Stream.runForEach((event) => Effect.sync(() => pageEvents.push(event))),
        Effect.forkChild,
      );
      const blockedAttachments = [];
      const blockedWatch = yield* webviewWindow.webContents.blocked.pipe(
        Stream.runForEach((entry) => Effect.sync(() => blockedAttachments.push(entry))),
        Effect.forkChild,
      );
      yield* Effect.sleep(50);
      yield* webviewWindow.webContents.load(Renderer.entry(new URL("/", origin), { bindings: [] }), { bindings: [] });
      const nativeWebview = NativeBrowserWindow.getAllWindows().find((each) => each.getTitle() === "Sewed parity" || each.getTitle() === "Sewed webview");
      const attach = () =>
        Effect.promise(() =>
          nativeWebview.webContents.executeJavaScript(
            `(() => { const view = document.createElement("webview"); view.src = ${JSON.stringify(`${origin}/inner`)}; document.body.append(view); })()`,
          ),
        );
      yield* attach();
      const deadlineDenied = Date.now() + 8_000;
      while (!blockedAttachments.some((entry) => entry.kind === "webview")) {
        assert.ok(Date.now() < deadlineDenied, "the undecided webview was not reported as blocked");
        yield* Effect.sleep(20);
      }
      assert.equal(pageEvents.some((event) => event.kind === "webview-attached"), false);
      yield* webviewWindow.webContents.decide(
        Decidables.WebContents.WebviewAttach,
        Decision.sync((event) => (event.src.endsWith("/inner") ? "allow" : "deny")),
      );
      yield* attach();
      const deadlineAllowed = Date.now() + 8_000;
      while (!pageEvents.some((event) => event.kind === "webview-attached")) {
        assert.ok(Date.now() < deadlineAllowed, "the allowed webview never attached");
        yield* Effect.sleep(20);
      }
      yield* Fiber.interrupt(watching);
      yield* Fiber.interrupt(blockedWatch);
      record("a webview is denied without a decider and attaches once one allows it");

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
