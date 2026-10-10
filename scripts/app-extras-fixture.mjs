import assert from "node:assert/strict";
import { createServer } from "node:http";
import { app, BrowserWindow as NativeBrowserWindow } from "electron";
import { Cause, Effect, Fiber, Redacted, Stream } from "effect";
import { Certificate, Decidables, Decision, Navigation, Renderer } from "sewed";
import { App, BrowserWindow, CommandLine, Image, Paths } from "sewed/main";

const checks = [];
const record = (name, evidence = {}) => {
  checks.push({ name, evidence: structuredClone(evidence) });
  console.log(`PASS ${name}`);
};
const failure = (exit) => {
  assert.equal(exit._tag, "Failure", "expected a failure");
  const error = Cause.findErrorOption(exit.cause);
  assert.equal(error._tag, "Some", Cause.pretty(exit.cause));
  return error.value;
};
const expectCode = (exit, code) => {
  const error = failure(exit);
  assert.equal(error._tag, "SewedError", String(error));
  assert.equal(error.code, code, error.message);
  return error;
};
const waitUntil = (read, description) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const value = read();
      if (value) return value;
      yield* Effect.sleep(10);
    }
    throw new Error(`Timed out: ${description}`);
  });
const observe = (stream) =>
  Effect.gen(function* () {
    const observer = { values: [], exit: undefined };
    observer.fiber = yield* stream.pipe(
      Stream.runForEach((value) =>
        Effect.sync(() => {
          observer.values.push(value);
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

const challenges = [];
const authorizations = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/secret") {
    const authorization = request.headers.authorization;
    authorizations.push(authorization ?? null);
    if (authorization !== `Basic ${Buffer.from("sewed:hunter2").toString("base64")}`) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="Sewed extras"' }).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Sewed secret</title>authorized");
    return;
  }
  response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Sewed public</title>public");
});
const listen = () =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });

const runChecks = (origin) =>
  Effect.scoped(
    Effect.gen(function* () {
      // Task 1 (fully-on-sewed wave 1), ruling 1: App.appPath and App.defaultPath were read before
      // readiness, in this module's own first synchronous pass, above. Once inside the program,
      // App.path(name) is the reader -- and it must answer the same thing App.defaultPath already
      // read, for every name, except logs: the fixture's own Paths.declare({ logs }) (below, in its
      // declaration list) moves it, and App.defaultPath keeps answering what Electron would have
      // used with nothing declared.
      const declaredLogs = yield* App.path("logs");
      if (logsTarget === undefined) assert.equal(declaredLogs, recordedDefaultPaths.logs);
      else assert.notEqual(declaredLogs, recordedDefaultPaths.logs);
      assert.equal(yield* App.path("userData"), recordedDefaultPaths.userData);
      assert.equal(yield* App.path("appData"), recordedDefaultPaths.appData);
      assert.equal(yield* App.path("temp"), recordedDefaultPaths.temp);
      assert.equal(yield* App.path("crashDumps"), recordedDefaultPaths.crashDumps);
      assert.equal(recordedAppPath, app.getAppPath());
      record(
        "App.appPath and App.defaultPath, read before readiness, match App.path after readiness except a directory a declaration moved",
        { appPath: recordedAppPath, defaultPaths: recordedDefaultPaths, declaredLogs },
      );

      const info = yield* App.info;
      assert.equal(info.name, app.getName());
      assert.equal(info.version, app.getVersion());
      assert.equal(info.packaged, false);
      assert.equal(yield* App.path("userData"), app.getPath("userData"));
      expectCode(yield* Effect.exit(App.path("cache")), "Protocol");
      const gpu = yield* App.gpu("basic");
      assert.equal(typeof gpu, "object");
      const features = yield* App.gpuFeatures;
      assert.ok(Object.keys(features).length > 0);
      const loginItems = yield* App.loginItems;
      assert.equal(typeof loginItems.openAtLogin, "boolean");
      assert.equal(typeof (yield* App.badge), "number");
      yield* App.setAboutPanel({ applicationName: "Sewed extras", authors: ["Sewed"] });
      assert.equal(typeof (yield* App.isDefaultProtocolClient({ scheme: "sewed-extras" })), "boolean");
      expectCode(yield* Effect.exit(App.isDefaultProtocolClient({ scheme: "Sewed" })), "Protocol");
      if (process.platform === "darwin") {
        yield* App.setSecureKeyboardEntry(false);
        assert.equal(yield* App.secureKeyboardEntry, false);
      } else {
        expectCode(yield* Effect.exit(App.setSecureKeyboardEntry(false)), "Native");
        expectCode(yield* Effect.exit(App.secureKeyboardEntry), "Native");
      }
      assert.equal(app.commandLine.getSwitchValue("sewed-extras"), "on");
      record("application queries, settings, and startup switches apply with validated inputs", {
        name: info.name,
        locale: info.locale,
        features: Object.keys(features).length,
      });

      if (process.platform !== "darwin") {
        expectCode(yield* Effect.exit(App.dock.setBadge("1")), "Native");
        expectCode(yield* Effect.exit(App.dock.visible), "Native");
        expectCode(yield* Effect.exit(App.dock.setIcon("icon.png")), "Native");
      }
      if (process.platform !== "win32") {
        expectCode(yield* Effect.exit(App.taskbar.setUserTasks([])), "Native");
        expectCode(yield* Effect.exit(App.taskbar.setJumpList(null)), "Native");
      }
      expectCode(yield* Effect.exit(App.taskbar.setUserTasks([{ program: "x" }])), "Protocol");
      record("platform groups fail with Native where unsupported and validate their inputs", {
        platform: process.platform,
      });

      const focus = yield* observe(App.windowFocus);
      const created = yield* observe(App.webContentsCreated);
      const gone = yield* observe(App.childProcesses);
      yield* waitUntil(
        () => app.listenerCount("browser-window-focus") >= 1 && app.listenerCount("child-process-gone") >= 1,
        "application listeners",
      );
      const window = yield* BrowserWindow.make({ show: false, width: 400, height: 300, title: "Sewed extras" });
      yield* waitUntil(() => created.values.length >= 1, "web contents created");
      assert.equal(created.values[0].type, "window");
      const native = NativeBrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === "Sewed extras");
      assert.ok(native, "native window");
      app.emit("browser-window-focus", {}, native);
      app.emit("browser-window-blur", {}, native);
      yield* waitUntil(() => focus.values.length >= 2, "focus events");
      assert.ok(focus.values.some((value) => value.focused && value.window === window.id));
      assert.ok(focus.values.some((value) => !value.focused && value.window === window.id));
      app.emit("child-process-gone", {}, { type: "Utility", reason: "killed", exitCode: 9, name: "probe" });
      yield* waitUntil(() => gone.values.length === 1, "child process event");
      assert.deepEqual(gone.values[0], { type: "Utility", reason: "killed", exitCode: 9, name: "probe" });
      const focusListeners = app.listenerCount("browser-window-focus");
      yield* Fiber.interrupt(focus.fiber);
      yield* Fiber.interrupt(created.fiber);
      yield* Fiber.interrupt(gone.fiber);
      assert.equal(app.listenerCount("browser-window-focus"), focusListeners - 1);
      record("focus, web contents, and child process streams name Sewed windows and release listeners", {
        focus: focus.values,
        created: created.values.length,
      });

      const iconBitmap = {
        width: 2,
        height: 2,
        bytes: new Uint8Array([
          255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
        ]),
      };
      const pngBytes = yield* Image.encode(iconBitmap, { format: "png" });
      yield* window.setIcon(pngBytes);
      record("a window's setIcon accepts already-encoded bytes, over Image.Source", {
        bytes: pngBytes.length,
      });

      yield* App.decide(
        Decidables.App.Login,
        Decision.async((challenge) =>
          Effect.sync(() => {
            challenges.push(challenge);
            return challenge.realm === "Sewed extras"
              ? { kind: "credentials", username: "sewed", password: Redacted.make("hunter2") }
              : { kind: "cancel" };
          }),
        ),
      );
      // The old App.login singleton failed a second install with Limit; App.decide composes
      // instead (Decidables.App.Login is "first"), so a second install is no longer refused — it
      // is just a decider the first one's non-Pass answer out-ranks. That constraint has no
      // replacement to prove here; the library's own suite covers "first" composition directly.
      const states = yield* observe(window.webContents.state);
      // setNavigationPolicy is gone: an origin-scoped policy now installs as a decider on
      // Decidables.WebContents.Navigation, through Navigation.Policy's own origin rule, composed
      // restrictively with whatever else is installed.
      yield* window.webContents.decide(
        Decidables.WebContents.Navigation,
        Decision.policy(Navigation.Policy, [{ kind: "origin", origin }]),
      );
      yield* window.webContents.load(Renderer.entry(new URL("/secret", origin), { bindings: [] }), {
        bindings: [],
      });
      yield* waitUntil(
        () => states.values.some((state) => state.status === "ready" && state.url.endsWith("/secret")),
        "authenticated document",
      );
      assert.equal(challenges.length, 1);
      assert.equal(challenges[0].realm, "Sewed extras");
      assert.equal(challenges[0].host, "127.0.0.1");
      assert.equal(authorizations.at(-1)?.startsWith("Basic "), true);
      yield* Fiber.interrupt(states.fiber);
      record("a scoped login decider answers HTTP authentication with redacted credentials", {
        challenge: challenges[0],
        attempts: authorizations.length,
      });
    }),
  );

const argumentValue = (prefix) =>
  process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
// Task 3 ("declared, therefore present"): the verifier passes a `logs` target three parent levels
// deep under a fresh temp directory that does not exist yet, and asserts -- itself, once this
// process has exited, not from in here -- that `Paths.declare` created it before the program ever
// ran. Absent, the entry the check adds below is skipped.
const logsTarget = argumentValue("--sewed-app-extras-logs=");

// Task 1 (fully-on-sewed wave 1), ruling 1: App.appPath and App.defaultPath are plain synchronous
// readers, like CommandLine's own declaration inputs -- recorded here, in this module's own first
// synchronous pass, before `App.run` is even called below, so the record is provably a pre-readiness
// one and not just a claim. App.defaultPath("recent") is also confirmed here to throw a SewedError
// Native on this platform (Windows-only path), per ruling 1's own probe.
const recordedAppPath = App.appPath();
const recordedDefaultPaths = {
  userData: App.defaultPath("userData"),
  appData: App.defaultPath("appData"),
  temp: App.defaultPath("temp"),
  logs: App.defaultPath("logs"),
  crashDumps: App.defaultPath("crashDumps"),
};
let recentPathError;
try {
  App.defaultPath("recent");
} catch (error) {
  recentPathError = error;
}
assert.ok(recentPathError, 'App.defaultPath("recent") was expected to throw before readiness');
assert.equal(recentPathError._tag, "SewedError");
assert.equal(recentPathError.code, "Native");
record('App.defaultPath("recent") throws Native before readiness, on this platform', {
  code: recentPathError.code,
  message: recentPathError.message,
});

// `App.run` is called synchronously, in this module's own first pass, with no `await` anywhere
// before it -- the entry rule Task 3 hardens (readiness probed in sewed-round-two's
// .artifacts/probe-ready): an `async function` awaited internally, but never awaited at this
// module's own top level, does not hold Electron's `ready`, so a call reached only after such an
// await is already too late. `App.run` itself awaits readiness before running the program below,
// so nothing here needs to await it a second time.
function main() {
  App.run(
    [
      CommandLine.declare({ name: "sewed-extras", value: "on" }),
      App.declare({ userModelId: "dev.sewed.playground" }),
      ...(logsTarget === undefined ? [] : [Paths.declare({ logs: logsTarget })]),
    ],
    Effect.gen(function* () {
      const origin = yield* Effect.promise(listen);
      yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
      // The old certificateErrors option's hostname matching is Certificate.Policy's own compile
      // now — Sewed owns the *.-suffix and lowercasing semantics again, restored by Task 6b after
      // the plan's own three-argument policy briefly forced every application to hand-write this
      // matcher. See packages/sewed/test/policies.test.ts's "a certificate policy matches exact and
      // *.-suffix hostnames, case-insensitively" in the sewed repository. Not exercised by this
      // fixture (no HTTPS request to *.internal.example is made here); kept only to preserve the
      // configured rule data.
      yield* App.decide(
        Decidables.App.CertificateError,
        Decision.policy(Certificate.Policy, [{ hostname: "*.internal.example", trust: "always" }]),
      );
      const result = yield* Effect.exit(runChecks(origin));
      server.close();
      console.log(
        `APP_EXTRAS_VERIFICATION ${JSON.stringify({
          success: result._tag === "Success",
          checks,
          error: result._tag === "Failure" ? Cause.pretty(result.cause) : undefined,
        })}`,
      );
      if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
      yield* App.quit;
    }),
  );
}

try {
  main();
} catch (error) {
  console.error(error);
  app.exit(1);
}
