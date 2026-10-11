import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow as NativeBrowserWindow, session as nativeSession } from "electron";
import { Cause, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { Decidables, Decision } from "sewed";
import { App, BrowserWindow, Image, Net, Protocol, Session, Tray } from "sewed/main";

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
    const server = createServer();
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

const runChecks = (server) =>
  Effect.scoped(
    Effect.gen(function* () {
      const window = yield* BrowserWindow.make({ show: true, width: 480, height: 360, title: "Sewed prompts" });
      const native = NativeBrowserWindow.getAllWindows().find((each) => each.getTitle() === "Sewed prompts");
      assert.ok(native, "the native window");

      // A message box is opened natively and closed by interrupting the Effect that shows it.
      for (const attempt of [1, 2]) {
        const shown = yield* Effect.forkChild(
          window.dialog.message({ message: `Sewed prompt ${attempt}`, buttons: ["Cancel", "Continue"] }),
        );
        yield* Effect.sleep(600);
        assert.equal(shown.pollUnsafe(), undefined, "the dialog is still open, waiting for an answer");
        yield* Fiber.interrupt(shown);
      }
      // The window can show another dialog afterwards: nothing was left pending.
      const again = yield* Effect.forkChild(
        window.dialog.message({ message: "Sewed prompt after interruption", buttons: ["OK"] }),
      );
      yield* Effect.sleep(300);
      assert.equal(again.pollUnsafe(), undefined);
      yield* Fiber.interrupt(again);
      record("a native message box opens and an interruption closes it, leaving the window free");

      // A file dialog has no abort signal; closing its window is what dismisses it, and the
      // Effect then fails Closed.
      const pickerScope = yield* Scope.fork(yield* Effect.scope);
      const picker = yield* BrowserWindow.make({ show: true, width: 300, height: 200, title: "Sewed picker" }).pipe(
        Scope.provide(pickerScope),
      );
      const picking = yield* Effect.forkChild(Effect.exit(picker.dialog.open({ mode: "file", title: "Sewed open" })));
      yield* Effect.sleep(800);
      yield* Scope.close(pickerScope, Exit.void);
      const picked = yield* Fiber.join(picking).pipe(Effect.timeoutOption("8 seconds"));
      assert.equal(picked._tag, "Some", "the open dialog's Effect settled once its window closed");
      assert.equal(errorOf(picked.value).code, "Closed");
      record("a native file dialog is dismissed by closing its window, and its Effect fails Closed");

      // A popup menu opens natively and an interruption closes it.
      const popup = yield* Effect.forkChild(
        window.menu.popup({ items: [{ kind: "command", id: "inspect", label: "Inspect" }] }),
      );
      yield* Effect.sleep(500);
      yield* Fiber.interrupt(popup);
      const dismissed = yield* window.menu
        .popup({ items: [{ kind: "command", id: "again", label: "Again" }] })
        .pipe(Effect.timeoutOption("400 millis"));
      assert.equal(dismissed._tag, "None", "a second popup opens after the first was interrupted");
      record("a native popup menu opens and an interruption closes it");

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
