import assert from "node:assert/strict";
import { createServer } from "node:http";
import { app, webContents as nativeWebContents } from "electron";
import { Cause, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { Decidables, Decision, Permission, Renderer } from "sewed";
import {
  App,
  BrowserWindow,
  DesktopCapturer,
  InAppPurchase,
  PushNotifications,
  Session,
  SystemPreferences,
} from "sewed/main";

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

const server = createServer((_request, response) => {
  response
    .writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end("<!doctype html><title>Sewed platform</title><body><p>platform</p></body>");
});
const listen = () =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });

const runChecks = (origin) =>
  Effect.scoped(
    Effect.gen(function* () {
      const animation = yield* SystemPreferences.animation;
      assert.equal(typeof animation.prefersReducedMotion, "boolean");
      const mac = process.platform === "darwin";
      // Electron implements these per platform; the contract is a value or a Native failure.
      const availability = {};
      const gated = (name, effect) =>
        Effect.map(Effect.exit(effect), (exit) => {
          if (exit._tag === "Success") availability[name] = "available";
          else {
            expectCode(exit, "Native");
            availability[name] = "native";
          }
        });
      yield* gated("appearance", SystemPreferences.appearance);
      yield* gated("systemColor", SystemPreferences.systemColor("blue"));
      yield* gated("accentColor", SystemPreferences.accentColor);
      yield* gated("mediaAccess", SystemPreferences.mediaAccess("camera"));
      yield* gated("color", SystemPreferences.color("window"));
      if (!mac) yield* gated("askForMediaAccess", SystemPreferences.askForMediaAccess("camera"));
      expectCode(yield* Effect.exit(SystemPreferences.mediaAccess("keyboard")), "Protocol");
      const changes = yield* observe(SystemPreferences.changes);
      yield* Effect.sleep(20);
      yield* Fiber.interrupt(changes.fiber);
      record("system preferences answer everywhere they exist and report Native elsewhere", {
        animation,
        availability,
        platform: process.platform,
      });

      const sources = yield* DesktopCapturer.sources({
        types: ["screen"],
        thumbnailSize: { width: 32, height: 32 },
      });
      assert.ok(sources.length > 0, "at least one screen source");
      assert.ok(sources[0].id.startsWith("screen:"), sources[0].id);
      assert.ok(sources[0].thumbnail.byteLength > 0, "thumbnail bytes");
      expectCode(yield* Effect.exit(DesktopCapturer.sources({ types: [] })), "Protocol");

      const session = yield* Session.fromPartition({ kind: "memory", name: "platform" });
      const requests = [];
      // setDisplayMedia is gone: the decider now installs on Decidables.Session.DisplayMedia
      // through session.decide, scoped so it can be removed the same way passing null used to.
      const displayMediaScope = yield* Scope.fork(yield* Effect.scope);
      yield* session
        .decide(
          Decidables.Session.DisplayMedia,
          Decision.async((request) =>
            Effect.sync(() => {
              requests.push(request);
              return { kind: "source", id: sources[0].id };
            }),
          ),
        )
        .pipe(Scope.provide(displayMediaScope));
      const window = yield* BrowserWindow.make({ show: false, session, width: 400, height: 300 });
      const states = yield* observe(window.webContents.state);
      // setPermissions is gone: an origin allowance now installs as a decider on
      // Decidables.Session.Permission, through Permission.Policy's own origin rule. `origin` (`null`
      // only for an opaque-origin document, which this http: page is not) is the requesting origin,
      // never `document`.
      const permissionOrigin = new URL(origin).origin;
      yield* session.decide(
        Decidables.Session.Permission,
        Decision.policy(Permission.Policy, [
          { kind: "origin", origin: permissionOrigin, permissions: ["media"] },
        ]),
      );
      yield* window.webContents.load(Renderer.entry(new URL("/", origin), { bindings: [] }), {
        bindings: [],
      });
      yield* waitUntil(() => states.values.some((state) => state.status === "ready"), "document");
      const native = nativeWebContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === new URL("/", origin).href);
      assert.ok(native, "native web contents");
      const outcome = yield* Effect.promise(() =>
        native.executeJavaScript(
          "navigator.mediaDevices.getDisplayMedia({ video: true }).then((stream) => { const tracks = stream.getTracks().map((track) => track.kind); stream.getTracks().forEach((track) => track.stop()); return { tracks }; }).catch((error) => ({ error: String(error && error.name) }))",
        ),
      );
      yield* waitUntil(() => requests.length === 1, "display media decision");
      assert.equal(requests[0].origin, origin);
      assert.equal(requests[0].videoRequested, true);
      // No null-removal path anymore: closing the decider's own scope is what removes it.
      yield* Scope.close(displayMediaScope, Exit.void);
      const denied = yield* Effect.promise(() =>
        native.executeJavaScript(
          "navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => ({ granted: true })).catch((error) => ({ error: String(error && error.name) }))",
        ),
      );
      assert.equal(denied.granted, undefined);
      yield* Fiber.interrupt(states.fiber);
      record("capture sources list with thumbnails and the display media decider answers real requests", {
        sources: sources.length,
        outcome,
        denied,
      });

      const bar = {
        items: [
          { kind: "button", id: "save", label: "Save" },
          { kind: "slider", id: "volume", minValue: 0, maxValue: 100, value: 50 },
        ],
      };
      if (mac) yield* window.touchBar.set(bar);
      else expectCode(yield* Effect.exit(window.touchBar.set(bar)), "Native");
      expectCode(
        yield* Effect.exit(
          window.touchBar.set({ items: [{ kind: "button", id: "a" }, { kind: "button", id: "a" }] }),
        ),
        "Protocol",
      );
      const interactions = yield* observe(window.touchBar.interactions);
      yield* Effect.sleep(20);
      yield* Fiber.interrupt(interactions.fiber);
      if (!mac) {
        expectCode(yield* Effect.exit(window.menu.share({ texts: ["hello"] })), "Native");
        expectCode(yield* Effect.exit(InAppPurchase.canMakePayments), "Native");
        expectCode(yield* Effect.exit(InAppPurchase.products(["pro"])), "Native");
        expectCode(yield* Effect.exit(Stream.runDrain(InAppPurchase.transactions)), "Native");
        expectCode(yield* Effect.exit(PushNotifications.register), "Native");
        expectCode(yield* Effect.exit(Stream.runDrain(PushNotifications.notifications)), "Native");
      }
      expectCode(yield* Effect.exit(window.menu.share({})), "Protocol");
      expectCode(yield* Effect.exit(InAppPurchase.products([])), "Protocol");
      record("touch bar, share sheet, store, and push surfaces validate input and gate by platform", {
        platform: process.platform,
      });
    }),
  );

async function verify() {
  await app.whenReady();
  const origin = await listen();
  App.run(
    [],
    Effect.gen(function* () {
      yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
      const result = yield* Effect.exit(runChecks(origin));
      server.close();
      console.log(
        `PLATFORM_VERIFICATION ${JSON.stringify({
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

void verify().catch((error) => {
  console.error(error);
  app.exit(1);
});
