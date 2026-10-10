import assert from "node:assert/strict";
import path from "node:path";
import { app, BrowserWindow as NativeWindow, session as nativeSession } from "electron";
import { Cause, Effect, Exit, Scope } from "effect";
import { Binding, Decidables, Decision, Navigation, Permission, Renderer } from "sewed";
import { App, BrowserWindow, Capability, Session, WindowControls, Worker } from "sewed/main";
import { Counter, CounterSlot, ControlsSlot } from "./session-contract.mjs";

const scenario = app.commandLine.getSwitchValue("sewed-session-case");
const profile = app.commandLine.getSwitchValue("sewed-session-profile");
const origin = app.commandLine.getSwitchValue("sewed-session-origin");
assert.ok(["full", "write", "read"].includes(scenario));
assert.ok(path.isAbsolute(profile));
assert.equal(new URL(origin).hostname, "127.0.0.1");
app.setPath("userData", profile);
app.setPath("sessionData", profile);

const checks = [];
const calls = [];
const permissionHandlers = new WeakMap();
const originalFromPartition = nativeSession.fromPartition;
nativeSession.fromPartition = (...args) => {
  const native = originalFromPartition(...args);
  if (!permissionHandlers.has(native)) {
    const handlers = {};
    const check = native.setPermissionCheckHandler.bind(native);
    const request = native.setPermissionRequestHandler.bind(native);
    native.setPermissionCheckHandler = (handler) => {
      handlers.check = handler;
      check(handler);
    };
    native.setPermissionRequestHandler = (handler) => {
      handlers.request = handler;
      request(handler);
    };
    permissionHandlers.set(native, handlers);
  }
  calls.push({ args, native });
  return native;
};
const record = (name, evidence = {}) => {
  checks.push({ name, evidence: structuredClone(evidence) });
  console.log(`PASS ${name}`);
};
const failure = (exit) => {
  assert.equal(exit._tag, "Failure");
  const error = Cause.findErrorOption(exit.cause);
  assert.equal(error._tag, "Some", Cause.pretty(exit.cause));
  return error.value;
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
const evaluate = (window, source) =>
  Effect.promise(() => window.native.webContents.executeJavaScript(source));
const readState = (window) =>
  evaluate(
    window,
    `(async () => ({
  local: localStorage.getItem("sewed-session"),
  cookie: document.cookie,
  request: (await fetch("/cookie").then((response) => response.json())).cookie,
}))()`,
  );
const writeState = (window, value) =>
  evaluate(
    window,
    `(() => {
  localStorage.setItem("sewed-session", ${JSON.stringify(value)});
  document.cookie = ${JSON.stringify(`sewed-session=${value}; Path=/; Max-Age=86400; SameSite=Lax`)};
})()`,
  );
const expectState = (value, expected) => {
  assert.equal(value.local, expected);
  const cookie = expected === null ? "" : `sewed-session=${expected}`;
  assert.equal(value.cookie, cookie);
  assert.equal(value.request, cookie);
};
const acquire = (partition) =>
  Effect.gen(function* () {
    const before = calls.length;
    const handle = yield* Session.fromPartition(partition);
    assert.equal(calls.length, before + 1);
    return { handle, native: calls.at(-1).native, args: calls.at(-1).args };
  });
const memoryDefinition = Session.fromPartition({ kind: "memory", name: "alpha" });
const defaultDefinition = Session.defaultSession;
assert.equal(calls.length, 0);
record("session definitions and imports acquire no native session before execution");

const runChecks = Effect.gen(function* () {
  const worker = yield* Worker.spawn(
    Worker.entry(new URL("./session-worker.mjs", import.meta.url), Counter),
  );
  const entry = Renderer.entry(new URL("/index.html", origin), {
    bindings: [CounterSlot, ControlsSlot],
  });
  let sequence = 0;
  const makeWindow = (options = {}, target = entry) =>
    Effect.gen(function* () {
      const scope = yield* Scope.fork(yield* Effect.scope);
      const title = `Sewed session ${process.pid} ${++sequence}`;
      const handle = yield* BrowserWindow.make({
        title,
        show: false,
        width: 500,
        height: 320,
        ...options,
      }).pipe(Scope.provide(scope));
      const native = NativeWindow.getAllWindows().find((window) => window.getTitle() === title);
      assert.ok(native);
      // The controls owner lives in the window's own scope, so closing that scope ends it too.
      const controls = yield* Capability.serve(WindowControls.capability).pipe(
        Effect.provide(WindowControls.native(handle)),
        Scope.provide(scope),
      );
      const window = { scope, handle, native, controls };
      yield* handle.webContents.load(target, {
        bindings: [Binding.to(CounterSlot, worker), Binding.to(ControlsSlot, controls)],
      });
      yield* waitUntil(
        evaluate(window, "Boolean(window.sessionFixture)"),
        "session renderer bindings",
      );
      return window;
    });
  const sample = (window) =>
    Effect.gen(function* () {
      const index = yield* evaluate(window, "window.sessionFixture.results.length");
      yield* evaluate(window, "window.sessionFixture.sample()");
      return yield* waitUntil(
        evaluate(window, `window.sessionFixture.results[${index}]`),
        "bound worker and window snapshot",
      );
    });

  if (scenario !== "full") {
    const persistent = yield* acquire({ kind: "persistent", name: "restart" });
    const memory = yield* acquire({ kind: "memory", name: "restart" });
    const upper = yield* acquire({ kind: "persistent", name: "RESTART" });
    const saved = yield* makeWindow({ session: persistent.handle });
    const transient = yield* makeWindow({ session: memory.handle });
    const separate = yield* makeWindow({ session: upper.handle });
    if (scenario === "write") {
      yield* writeState(saved, "persistent");
      yield* writeState(transient, "memory");
      yield* writeState(separate, "case-separated");
      expectState(yield* readState(saved), "persistent");
      expectState(yield* readState(transient), "memory");
      expectState(yield* readState(separate), "case-separated");
      record("the first process writes distinct persistent, memory, and case-differing profiles");
    } else {
      expectState(yield* readState(saved), "persistent");
      record("persistent cookies and local storage survive normal application exit and restart");
      expectState(yield* readState(transient), null);
      record("the same memory partition starts empty in a new Electron process");
      expectState(yield* readState(separate), "case-separated");
      record("case-differing persistent names keep distinct data across process restart");
    }
    return;
  }

  // cookies, clearStorage, closeAllConnections, resolveHost, blobData, requests, decide, and
  // intercept moved onto the acquired handle as methods in this wave; setPermissions,
  // setCertificatePolicy, setPreconnect, and setDisplayMedia are gone, replaced by
  // Decidables.Session and handle.decide, and the Rules bundle is gone with Session.intercept.
  assert.deepEqual(Object.keys(Session).sort(), [
    "cacheSize",
    "clearCache",
    "defaultSession",
    "fromPartition",
    "loadExtension",
    "resolveProxy",
    "serviceWorkers",
    "setDownloadPath",
    "setProxy",
    "setSpellChecker",
    "setUserAgent",
    "spellChecker",
    "userAgent",
  ]);
  const firstHandle = yield* memoryDefinition;
  const alpha = yield* acquire({ kind: "memory", name: "alpha" });
  assert.equal(firstHandle, alpha.handle);
  assert.equal(alpha.native.isPersistent(), false);
  assert.equal(alpha.native.getStoragePath(), null);
  assert.equal(Object.isFrozen(alpha.handle), true);
  assert.deepEqual(Object.keys(alpha.handle).sort(), [
    "blobData",
    "clearStorage",
    "closeAllConnections",
    "cookies",
    "decide",
    "intercept",
    "requests",
    "resolveHost",
  ]);
  record("repeated memory acquisition returns the same opaque native-backed handle");
  const beta = yield* acquire({ kind: "memory", name: "beta" });
  assert.notEqual(alpha.handle, beta.handle);
  assert.notEqual(alpha.native, beta.native);
  const first = yield* makeWindow({ session: alpha.handle, width: 520 });
  const twin = yield* makeWindow({ session: firstHandle, width: 540 });
  const other = yield* makeWindow({ session: beta.handle, width: 620 });
  assert.equal(first.native.webContents.session, alpha.native);
  assert.equal(twin.native.webContents.session, alpha.native);
  assert.equal(other.native.webContents.session, beta.native);
  yield* writeState(first, "alpha");
  const shared = yield* readState(twin);
  expectState(shared, "alpha");
  record(
    "two windows sharing a handle share same-origin cookies, request cookies, and local storage",
    shared,
  );
  expectState(yield* readState(other), null);
  yield* writeState(other, "beta");
  expectState(yield* readState(first), "alpha");
  expectState(yield* readState(other), "beta");
  record("different memory sessions isolate the same origin in both directions");

  assert.equal(yield* evaluate(first, "Notification.permission"), "denied");
  assert.equal(yield* evaluate(first, "Notification.requestPermission()"), "denied");
  record("new Sewed sessions deny browser permission checks and requests by default");
  // setPermissions used to replace one declarative policy outright; a decider composes instead, so
  // this fixture keeps one scope per "current" decider and closes it before installing the next —
  // this model's own way of replacing the whole policy at once.
  let permissionScope = yield* Scope.fork(yield* Effect.scope);
  const replacePermissionDecider = (decider) =>
    Effect.gen(function* () {
      yield* Scope.close(permissionScope, Exit.void);
      permissionScope = yield* Scope.fork(yield* Effect.scope);
      yield* alpha.handle
        .decide(Decidables.Session.Permission, decider)
        .pipe(Scope.provide(permissionScope));
    });
  const permissionOrigin = new URL(origin).origin;
  const grantedPermissions = new Set(["notifications"]);
  // `origin` is the requesting origin (`null` only for an opaque-origin document, which this
  // http: page is not), read directly rather than parsed back out of `document` (which is `null`
  // for a device check anyway).
  yield* replacePermissionDecider(
    Decision.sync(({ name, origin: requestOrigin }) =>
      grantedPermissions.has(name) && requestOrigin === permissionOrigin ? "allow" : "deny",
    ),
  );
  assert.equal(yield* evaluate(first, "Notification.permission"), "granted");
  assert.equal(yield* evaluate(twin, "Notification.requestPermission()"), "granted");
  assert.equal(yield* evaluate(other, "Notification.permission"), "denied");
  record("an explicit permission decider applies to one selected session across its windows");
  grantedPermissions.add("geolocation");
  const handlers = permissionHandlers.get(alpha.native);
  const details = { isMainFrame: true, requestingUrl: first.native.webContents.getURL() };
  assert.equal(handlers.check(first.native.webContents, "geolocation", origin, details), true);
  assert.equal(handlers.check(first.native.webContents, "notifications", origin, details), true);
  assert.equal(handlers.check(null, "notifications", origin, details), false);
  assert.equal(
    handlers.check(first.native.webContents, "notifications", origin, {
      ...details,
      isMainFrame: false,
    }),
    false,
  );
  assert.equal(
    handlers.check(first.native.webContents, "notifications", "https://untrusted.example", details),
    false,
  );
  assert.equal(
    handlers.check(first.native.webContents, "notifications", origin, {
      ...details,
      requestingUrl: `${origin}/different`,
    }),
    false,
  );
  assert.equal(handlers.check(first.native.webContents, "unrecognized", origin, details), false);
  let requestResult;
  handlers.request(
    first.native.webContents,
    "notifications",
    (allowed) => {
      requestResult = allowed;
    },
    { ...details, isMainFrame: false },
  );
  assert.equal(requestResult, false);
  record(
    "a live decider is consulted per check without reinstalling, and still rejects subframes, missing owners and mismatched origins",
    { injected: true },
  );

  // Task 3 (wave 4): a media request's event carries mediaTypes. getUserMedia itself is not
  // reachable here — the probe found neither resolution nor rejection in 2s with no media
  // devices under Xvfb — so this drives the same check/request handlers Electron would, directly,
  // exactly as the hard-gate checks above already do.
  const seenMediaTypes = [];
  yield* replacePermissionDecider(
    Decision.sync(({ mediaTypes }) => {
      seenMediaTypes.push(mediaTypes);
      return "allow";
    }),
  );
  handlers.check(first.native.webContents, "media", origin, { ...details, mediaType: "audio" });
  handlers.check(first.native.webContents, "media", origin, { ...details, mediaType: "unknown" });
  handlers.check(first.native.webContents, "notifications", origin, details);
  let mediaRequestResult;
  handlers.request(
    first.native.webContents,
    "media",
    (allowed) => {
      mediaRequestResult = allowed;
    },
    { ...details, mediaTypes: ["audio", "video"] },
  );
  assert.deepEqual(seenMediaTypes, [["audio"], [], [], ["audio", "video"]]);
  assert.equal(mediaRequestResult, true);
  record(
    "a media permission's event carries mediaTypes: the check handler's singular mediaType as one element, the request handler's own array, and an empty list for a non-media check",
    { seenMediaTypes },
  );

  const framePermission = yield* evaluate(
    first,
    `new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.onload = () => { const permission = frame.contentWindow.Notification.permission; frame.remove(); resolve(permission); };
    frame.srcdoc = "<html><body>Permission frame</body></html>";
    document.body.append(frame);
  })`,
  );
  assert.equal(framePermission, "denied");
  record("a real same-origin subframe does not inherit its top document's permission grant");
  // setPermissions used to validate a declarative policy and reject a broken one before it could
  // take effect; a decider is arbitrary code, so there is no schema left to reject — a broken
  // decider composes instead, and restrictive composition means it can only deny more, never grant
  // less: installing one that throws denies even where the working decider above still allows.
  const brokenPermissionScope = yield* Scope.fork(yield* Effect.scope);
  yield* alpha.handle
    .decide(
      Decidables.Session.Permission,
      Decision.sync(() => {
        throw new Error("a broken permission decider");
      }),
    )
    .pipe(Scope.provide(brokenPermissionScope));
  assert.equal(yield* evaluate(first, "Notification.permission"), "denied");
  yield* Scope.close(brokenPermissionScope, Exit.void);
  assert.equal(yield* evaluate(first, "Notification.permission"), "granted");
  record(
    "a broken decider composes restrictively too: it can only deny, never widen an allow, and removing it restores the working decider",
  );
  const routeDocument = new URL(`${first.native.webContents.getURL()}#route`);
  routeDocument.hash = "";
  yield* replacePermissionDecider(
    Decision.policy(Permission.Policy, [
      { kind: "document", url: routeDocument.href, permissions: ["notifications"] },
    ]),
  );
  assert.equal(yield* evaluate(first, "Notification.permission"), "granted");
  // A cap, deliberately, not a policy: this replaces the working decider above with one that denies
  // everything, unconditionally, to prove replacement itself revokes access — a grant with no rules
  // would pass on everything and hit the same fallback deny, but would not demonstrate a decider
  // that actively vetoes rather than merely having nothing to say.
  yield* replacePermissionDecider(Decision.sync(() => "deny"));
  assert.equal(yield* evaluate(first, "Notification.requestPermission()"), "denied");
  record(
    "document-scoped deciders ignore route fragments, and replacing the decider revokes future access",
  );

  const implicitDefault = yield* makeWindow();
  const defaultHandle = yield* defaultDefinition;
  assert.equal(defaultHandle, yield* Session.defaultSession);
  const explicitDefault = yield* makeWindow({ session: defaultHandle });
  assert.equal(yield* evaluate(implicitDefault, "Notification.permission"), "denied");
  assert.equal(implicitDefault.native.webContents.session, nativeSession.defaultSession);
  assert.equal(explicitDefault.native.webContents.session, nativeSession.defaultSession);
  yield* writeState(implicitDefault, "default");
  expectState(yield* readState(explicitDefault), "default");
  expectState(yield* readState(first), "alpha");
  expectState(yield* readState(other), "beta");
  record(
    "omitted and explicit default sessions share Electron's default without changing named sessions",
  );
  yield* Scope.close(implicitDefault.scope, Exit.void);
  yield* Scope.close(explicitDefault.scope, Exit.void);

  const persistent = yield* acquire({ kind: "persistent", name: "alpha" });
  assert.equal(persistent.native.isPersistent(), true);
  assert.notEqual(persistent.native, alpha.native);
  const saved = yield* makeWindow({ session: persistent.handle });
  expectState(yield* readState(saved), null);
  yield* writeState(saved, "persistent-alpha");
  expectState(yield* readState(first), "alpha");
  record("memory and persistent partitions with the same name have separate stores");
  yield* Scope.close(saved.scope, Exit.void);

  const upper = yield* acquire({ kind: "persistent", name: "Work" });
  const lower = yield* acquire({ kind: "persistent", name: "work" });
  assert.deepEqual(upper.args, [
    "persist:sewed-v1-0d143d71930e332038b470cbd97406e9d3532063aaf27e65d7d355bfd7ba7d45",
  ]);
  assert.deepEqual(lower.args, [
    "persist:sewed-v1-9aa0f14be7df8ae328ab71d9f8f27777beefecaa4c0493d2ad08b8ad9aeb07a9",
  ]);
  assert.notEqual(upper.native, lower.native);
  assert.notEqual(upper.native.getStoragePath(), lower.native.getStoragePath());
  const upperWindow = yield* makeWindow({ session: upper.handle });
  const lowerWindow = yield* makeWindow({ session: lower.handle });
  yield* writeState(upperWindow, "upper");
  expectState(yield* readState(lowerWindow), null);
  yield* writeState(lowerWindow, "lower");
  expectState(yield* readState(upperWindow), "upper");
  record("case-differing names retain stable partition keys and distinct persistent stores", {
    upper: upper.native.getStoragePath(),
    lower: lower.native.getStoragePath(),
  });
  yield* Scope.close(upperWindow.scope, Exit.void);
  yield* Scope.close(lowerWindow.scope, Exit.void);

  const raw = yield* acquire({ kind: "persistent", name: "Work", mapping: "raw" });
  assert.deepEqual(raw.args, ["persist:Work"]);
  const rawMemory = yield* acquire({ kind: "memory", name: "Work", mapping: "raw" });
  assert.deepEqual(rawMemory.args, ["Work"]);
  assert.notEqual(
    raw.native,
    upper.native,
    "a raw-mapped partition is a distinct native session from the hashed one sharing its name",
  );
  const rawWindow = yield* makeWindow({ session: raw.handle });
  expectState(yield* readState(rawWindow), null);
  yield* writeState(rawWindow, "raw-work");
  expectState(yield* readState(rawWindow), "raw-work");
  record('mapping: "raw" hands Electron the name verbatim, persist:-prefixed for a persistent one', {
    raw: raw.args,
    rawMemory: rawMemory.args,
  });
  yield* Scope.close(rawWindow.scope, Exit.void);

  const prefixed = yield* acquire({ kind: "memory", name: "persist:alpha" });
  assert.equal(prefixed.native.isPersistent(), false);
  assert.equal(prefixed.native.getStoragePath(), null);
  const pathLike = yield* acquire({ kind: "persistent", name: "../../account" });
  const relativePath = path.relative(
    path.join(profile, "Partitions"),
    pathLike.native.getStoragePath(),
  );
  assert.equal(path.dirname(relativePath), ".");
  assert.notEqual(relativePath, "..");
  const surrogate = yield* acquire({ kind: "persistent", name: "\ud800" });
  const replacement = yield* acquire({ kind: "persistent", name: "\ufffd" });
  assert.notEqual(surrogate.native.getStoragePath(), replacement.native.getStoragePath());
  record(
    "names cannot override persistence, escape the profile, or alias through UTF-8 replacement",
  );

  const sampleA = yield* sample(first);
  const sampleB = yield* sample(other);
  assert.ok(sampleA.worker.threadId > 0);
  assert.equal(sampleB.worker.threadId, sampleA.worker.threadId);
  assert.equal(sampleB.worker.count, sampleA.worker.count + 1);
  assert.equal(sampleA.window.bounds.width, first.native.getBounds().width);
  assert.equal(sampleB.window.bounds.width, other.native.getBounds().width);
  assert.notEqual(sampleA.window.bounds.width, sampleB.window.bounds.width);
  record("isolated browser sessions can bind one worker and distinct native window controls", {
    first: sampleA,
    second: sampleB,
  });

  const documentBefore = yield* evaluate(other, "window.sessionFixture.document");
  yield* other.handle.webContents.reload;
  yield* waitUntil(
    evaluate(
      other,
      `Boolean(window.sessionFixture) && window.sessionFixture.document !== ${JSON.stringify(documentBefore)}`,
    ),
    "new renderer document",
  );
  assert.equal(other.native.webContents.session, beta.native);
  expectState(yield* readState(other), "beta");
  const reloaded = yield* sample(other);
  assert.equal(reloaded.worker.threadId, sampleA.worker.threadId);
  assert.equal(reloaded.worker.count, sampleB.worker.count + 1);
  record(
    "document reload preserves the selected session and shared worker while replacing its clients",
  );

  const scopedHandle = yield* Effect.scoped(
    Session.fromPartition({ kind: "memory", name: "alpha" }),
  );
  assert.equal(scopedHandle, alpha.handle);
  yield* Scope.close(first.scope, Exit.void);
  yield* Scope.close(twin.scope, Exit.void);
  assert.ok(first.native.isDestroyed() && twin.native.isDestroyed());
  const reacquired = yield* acquire({ kind: "memory", name: "alpha" });
  assert.equal(reacquired.handle, scopedHandle);
  assert.equal(reacquired.native, alpha.native);
  const reopened = yield* makeWindow({ session: scopedHandle });
  expectState(yield* readState(reopened), "alpha");
  const afterReopen = yield* sample(reopened);
  assert.equal(afterReopen.worker.threadId, sampleA.worker.threadId);
  assert.equal(afterReopen.worker.count, reloaded.worker.count + 1);
  record(
    "caller scope and last-window closure preserve a named session for an explicitly created later window",
  );

  const invalid = [
    undefined,
    null,
    1,
    "persist:alpha",
    {},
    { kind: "unknown", name: "a" },
    { kind: "memory", name: "" },
    { kind: "persistent", name: 1 },
  ];
  const beforeInvalid = calls.length;
  for (const value of invalid) {
    const error = failure(yield* Effect.exit(Session.fromPartition(value)));
    assert.equal(error.code, "Native");
    assert.equal(error.cause._tag, "SchemaError");
  }
  assert.equal(calls.length, beforeInvalid);
  record("invalid partition definitions fail before native acquisition", {
    inputs: invalid.length,
  });
  const extra = yield* acquire({
    kind: "memory",
    name: "alpha",
    partition: "persist:override",
    path: profile,
    cache: false,
  });
  assert.equal(extra.handle, alpha.handle);
  assert.equal(extra.args.length, 1);
  record(
    "untyped native creation options cannot override partition identity or first-use settings",
  );

  const beforeForged = NativeWindow.getAllWindows().length;
  // structuredClone(alpha.handle) used to belong here too: with the old opaque marker handle, it
  // was equivalent to the `{}` case below, since structuredClone drops the identity symbol the same
  // way JSON does. Now that the handle also carries real methods (cookies, decide, ...),
  // structuredClone throws DataCloneError on the functions inside it before this array can even be
  // built. `{ ...alpha.handle }` already covers what a "copied" handle needs to demonstrate — the
  // same identity symbol, a different object reference — since this test is about identity, not
  // structural depth.
  const forged = [null, "alpha", {}, { ...alpha.handle }, alpha.native, memoryDefinition];
  for (const handle of forged) {
    const error = failure(yield* Effect.exit(BrowserWindow.make({ session: handle, show: false })));
    assert.equal(error.code, "Native");
    assert.ok(error.cause instanceof TypeError);
  }
  assert.equal(NativeWindow.getAllWindows().length, beforeForged);
  record(
    "raw, fabricated, copied, and unacquired session handles cannot construct native windows",
    { inputs: forged.length },
  );

  const protectedWindow = yield* makeWindow({
    session: alpha.handle,
    webPreferences: {
      session: beta.native,
      partition: "persist:override",
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  assert.equal(protectedWindow.native.webContents.session, alpha.native);
  const preferences = protectedWindow.native.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.deepEqual(
    yield* evaluate(protectedWindow, "({ node: typeof process, require: typeof require })"),
    { node: "undefined", require: "undefined" },
  );
  expectState(yield* readState(protectedWindow), "alpha");
  record("session selection preserves secure web preferences and rejects untyped native overrides");

  const nativeError = new Error("injected session acquisition failure");
  const real = nativeSession.fromPartition;
  const exit = yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      nativeSession.fromPartition = () => {
        throw nativeError;
      };
    }),
    () => Effect.exit(Session.fromPartition({ kind: "memory", name: "native-failure" })),
    () =>
      Effect.sync(() => {
        nativeSession.fromPartition = real;
      }),
  );
  assert.equal(failure(exit).code, "Native");
  assert.equal(failure(exit).cause, nativeError);
  assert.equal((yield* acquire({ kind: "memory", name: "alpha" })).handle, alpha.handle);
  record(
    "native acquisition failures retain their original cause without corrupting existing handles",
    { injected: true },
  );

  const alternateUrl = new URL("/index.html", origin);
  alternateUrl.hostname = "localhost";
  const alternate = yield* makeWindow(
    { session: alpha.handle },
    Renderer.entry(alternateUrl, { bindings: [CounterSlot, ControlsSlot] }),
  );
  yield* writeState(alternate, "alternate-alpha");
  yield* alpha.handle.clearStorage({ kind: "origin", origin, storages: ["localstorage"] });
  assert.deepEqual(yield* readState(reopened), {
    local: null,
    cookie: "sewed-session=alpha",
    request: "sewed-session=alpha",
  });
  expectState(yield* readState(alternate), "alternate-alpha");
  expectState(yield* readState(other), "beta");
  record("origin storage clearing preserves cookies, other origins and other session owners");
  yield* alpha.handle.clearStorage({ kind: "session", storages: ["cookies"] });
  assert.deepEqual(yield* readState(reopened), { local: null, cookie: "", request: "" });
  assert.deepEqual(yield* readState(alternate), {
    local: "alternate-alpha",
    cookie: "",
    request: "",
  });
  expectState(yield* readState(other), "beta");
  yield* alpha.handle.clearStorage({ kind: "session", storages: ["localstorage"] });
  expectState(yield* readState(alternate), null);
  record("session-wide clearing targets explicit storage kinds in the selected session only");
  const clear = alpha.native.clearStorageData.bind(alpha.native);
  let nativeClears = 0;
  alpha.native.clearStorageData = (...args) => {
    nativeClears += 1;
    return clear(...args);
  };
  for (const options of [
    undefined,
    {},
    { kind: "session", storages: [] },
    { kind: "origin", origin, storages: ["cookies"] },
    { kind: "origin", origin: `${origin}/path`, storages: ["localstorage"] },
    { kind: "session", storages: ["unknown"] },
  ]) {
    assert.equal(
      failure(yield* Effect.exit(alpha.handle.clearStorage(options))).code,
      "Native",
    );
  }
  assert.equal(nativeClears, 0);
  const clearError = new Error("injected storage clearing failure");
  alpha.native.clearStorageData = () => Promise.reject(clearError);
  const failedClear = failure(
    yield* Effect.exit(alpha.handle.clearStorage({ kind: "session", storages: ["cookies"] })),
  );
  assert.equal(failedClear.code, "Native");
  assert.equal(failedClear.cause, clearError);
  alpha.native.clearStorageData = clear;
  record("invalid clearing options never reach Electron and native failures preserve their cause", {
    injected: true,
  });
  yield* writeState(reopened, "alpha");

  const navigationWindow = yield* makeWindow({ session: alpha.handle });
  const navigationEvents = [];
  navigationWindow.native.webContents.on("will-navigate", (event) =>
    navigationEvents.push({ url: event.url, prevented: event.defaultPrevented }),
  );
  const windowCount = NativeWindow.getAllWindows().length;
  assert.equal(
    yield* evaluate(navigationWindow, 'window.open("/index.html?popup", "_blank") === null'),
    true,
  );
  assert.equal(NativeWindow.getAllWindows().length, windowCount);
  record("renderer window.open cannot create an unowned native window");
  const originalUrl = navigationWindow.native.webContents.getURL();
  const originalDocument = yield* evaluate(navigationWindow, "window.sessionFixture.document");
  const nextUrl = new URL("/index.html?next", origin);
  yield* evaluate(navigationWindow, `location.href = ${JSON.stringify(nextUrl.href)}`);
  yield* waitUntil(
    Effect.sync(() => navigationEvents.length > 0),
    "blocked navigation event",
  );
  assert.equal(navigationEvents.at(-1).prevented, true);
  assert.equal(navigationWindow.native.webContents.getURL(), originalUrl);
  assert.equal(
    yield* evaluate(navigationWindow, "window.sessionFixture.document"),
    originalDocument,
  );
  yield* evaluate(navigationWindow, 'location.hash = "route"');
  assert.equal(
    yield* evaluate(navigationWindow, "window.sessionFixture.document"),
    originalDocument,
  );
  record(
    "default navigation policy blocks a different document while preserving same-document routes",
  );
  // setNavigationPolicy is gone: an exact-document allowance now installs as a decider on
  // Decidables.WebContents.Navigation, through Navigation.Policy's own document rule, scoped so it
  // can be removed the same way replacing the old single policy slot could — closing the scope is
  // this model's "reset to []".
  const documentDecider = (url) => Decision.policy(Navigation.Policy, [{ kind: "document", url }]);
  const nextUrlScope = yield* Scope.fork(navigationWindow.scope);
  yield* navigationWindow.handle.webContents
    .decide(Decidables.WebContents.Navigation, documentDecider(nextUrl.href))
    .pipe(Scope.provide(nextUrlScope));
  yield* evaluate(navigationWindow, `location.href = ${JSON.stringify(nextUrl.href)}`);
  yield* waitUntil(
    Effect.sync(
      () =>
        navigationWindow.native.webContents.getURL() === nextUrl.href &&
        !navigationWindow.native.webContents.isLoading(),
    ),
    "allowed navigation",
  );
  assert.equal(navigationEvents.at(-1).prevented, false);
  assert.equal(yield* evaluate(navigationWindow, "typeof window.sessionFixture"), "undefined");
  assert.equal(navigationWindow.native.webContents.session, alpha.native);
  record(
    "allowing navigation preserves the browser session without granting the old document's bindings",
  );
  const loadNavigation = (url) =>
    navigationWindow.handle.webContents.load(
      Renderer.entry(url, { bindings: [CounterSlot, ControlsSlot] }),
      {
        bindings: [
          Binding.to(CounterSlot, worker),
          Binding.to(ControlsSlot, navigationWindow.controls),
        ],
      },
    );
  yield* loadNavigation(nextUrl);
  yield* waitUntil(
    evaluate(navigationWindow, "Boolean(window.sessionFixture)"),
    "explicitly rebound document",
  );
  assert.equal((yield* sample(navigationWindow)).worker.threadId, sampleA.worker.threadId);
  record("main can explicitly load and bind the new document to the existing owners");
  // setNavigationPolicy's own input validation is gone with it: Navigation.Rules's schema decode
  // and UrlRule.compile's canonical-origin/scheme checks are the library's own concern now (covered
  // by its unit suite), not a runtime operation this fixture calls against a real Electron process.
  // Removing the allowance installed above is what stands in for resetting the policy to [].
  yield* Scope.close(nextUrlScope, Exit.void);
  const redirectUrl = new URL("/redirect", origin);
  assert.equal(failure(yield* Effect.exit(loadNavigation(redirectUrl))).code, "Native");
  const destination = new URL("/index.html?redirected", origin);
  assert.notEqual(navigationWindow.native.webContents.getURL(), destination.href);
  yield* navigationWindow.handle.webContents
    .decide(Decidables.WebContents.Navigation, documentDecider(destination.href))
    .pipe(Scope.provide(navigationWindow.scope));
  yield* loadNavigation(redirectUrl);
  assert.equal(navigationWindow.native.webContents.getURL(), destination.href);
  record(
    "main-frame redirects require an allowed destination, and removing the allowance blocks again",
  );
  yield* Scope.close(navigationWindow.scope, Exit.void);
  assert.equal(
    failure(
      yield* Effect.exit(
        navigationWindow.handle.webContents.decide(
          Decidables.WebContents.Navigation,
          Decision.sync(() => "allow"),
        ),
      ),
    ).code,
    "Closed",
  );
  record("closed native owners cannot accept new navigation deciders");
});

App.run(
  [],
  Effect.gen(function* () {
    yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
    const result = yield* Effect.exit(runChecks);
    console.log(
      `SESSION_VERIFICATION ${JSON.stringify({
        success: result._tag === "Success",
        scenario,
        pid: process.pid,
        checks,
        error: result._tag === "Failure" ? Cause.pretty(result.cause) : undefined,
        platform: { os: process.platform, ozone: "x11", profile: "isolated temporary directory" },
      })}`,
    );
    nativeSession.fromPartition = originalFromPartition;
    if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
    yield* App.quit;
  }),
);
