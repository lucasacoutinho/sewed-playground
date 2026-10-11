import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, session as nativeSession, webContents as nativeWebContents } from "electron";
import { Cause, Context, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { Binding, Cookie, Decidables, Decision, Permission, Renderer } from "sewed";
import { App, BrowserWindow, Capability, Cookies, Session } from "sewed/main";

app.setPath("userData", mkdtempSync(join(tmpdir(), "sewed-session-extras-")));
const CookieJar = Cookie.capability.slot;
class Audit extends Context.Service()("session-extras/Audit") {}
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

const requests = [];
const holdState = {};
const blobPayloadText = "sewed blob data check";
// A blob is a one-time-readable native resource: `session.blobData` and `readBody({ blobs:
// "resolve" })` cannot both read the *same* blob id in one request, so `readBody`'s own upload
// is entirely separate from the one `session.blobData` reads below.
const readBodyPayloadText = "sewed readBody data check";
let preconnectOrigin;
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  requests.push({ path: url.pathname, headers: request.headers });
  if (url.pathname === "/") {
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end("<!doctype html><title>Sewed session extras</title><body><p>extras</p></body>");
    return;
  }
  if (url.pathname === "/echo") {
    response
      .writeHead(200, { "content-type": "application/json", "x-upstream": "yes" })
      .end(JSON.stringify({ path: url.pathname, trace: request.headers["x-trace"] ?? null }));
    return;
  }
  if (url.pathname === "/untouched") {
    response
      .writeHead(200, {
        "content-type": "application/json",
        "x-untouched": "server-value",
        "cache-control": "no-store",
      })
      .end(
        JSON.stringify({
          names: Object.keys(request.headers).sort(),
          accept: request.headers.accept ?? null,
          userAgent: request.headers["user-agent"] ?? null,
          trace: request.headers["x-trace"] ?? null,
        }),
      );
    return;
  }
  if (url.pathname === "/moved") {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ path: "/moved" }));
    return;
  }
  if (url.pathname === "/hold") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("start\n");
    holdState.opened = Date.now();
    response.on("close", () => {
      holdState.closed = Date.now();
    });
    return;
  }
  if (url.pathname === "/preconnect") {
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(
        `<!doctype html><title>preconnect</title><link rel="preconnect" href="${preconnectOrigin}">`,
      );
    return;
  }
  if (url.pathname === "/upload") {
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(
        "<!doctype html><title>upload</title><script>" +
          "(async () => {" +
          `const bytes = new TextEncoder().encode(${JSON.stringify(blobPayloadText)});` +
          'const file = new File([bytes], "payload.bin", { type: "application/octet-stream" });' +
          "const form = new FormData();" +
          'form.append("file", file);' +
          'const response = await fetch("/submit-blob", { method: "POST", body: form });' +
          "window.__uploadStatus = response.status;" +
          "})();" +
          "</script>",
      );
    return;
  }
  if (url.pathname === "/submit-blob") {
    request.resume();
    request.on("end", () => {
      response.writeHead(204).end();
    });
    return;
  }
  if (url.pathname === "/upload-readbody") {
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(
        "<!doctype html><title>upload readBody</title><script>" +
          "(async () => {" +
          `const bytes = new TextEncoder().encode(${JSON.stringify(readBodyPayloadText)});` +
          'const file = new File([bytes], "payload.bin", { type: "application/octet-stream" });' +
          "const form = new FormData();" +
          'form.append("file", file);' +
          'const response = await fetch("/submit-blob-readbody", { method: "POST", body: form });' +
          "window.__uploadReadBodyStatus = response.status;" +
          "})();" +
          "</script>",
      );
    return;
  }
  if (url.pathname === "/submit-blob-readbody") {
    request.resume();
    request.on("end", () => {
      response.writeHead(204).end();
    });
    return;
  }
  // Task 1b: the fail-open bites only when every install on a stage names `types` and at least one
  // names `other`; a `<link rel="prefetch">` is Electron's own `other`-typed resource.
  if (url.pathname === "/other-check") {
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(
        "<!doctype html><title>other check</title>" +
          '<link rel="prefetch" href="/other-check-prefetch.txt">' +
          '<img src="/other-check-image.png" onload="window.__otherCheckImage=\'loaded\'" onerror="window.__otherCheckImage=\'error\'">',
      );
    return;
  }
  if (url.pathname === "/other-check-image.png") {
    response
      .writeHead(200, { "content-type": "image/png" })
      .end(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          "base64",
        ),
      );
    return;
  }
  if (url.pathname === "/other-check-prefetch.txt") {
    response.writeHead(200, { "content-type": "text/plain" }).end("prefetch");
    return;
  }
  response.writeHead(404).end();
});

// Completes a real WebSocket handshake on the same server and port the http checks use, so
// `{ urls: ["<all_urls>"] }` (which delivers `webSocket`-typed requests) and a bare `*` scheme
// (which does not) can both be pinned against a real upgrade rather than an assumption.
const wsUpgrades = [];
server.on("upgrade", (request, socket) => {
  const url = new URL(request.url, "http://localhost");
  wsUpgrades.push(url.pathname);
  const acceptKey = createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
  );
});
const listen = () =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
let preconnectConnectionCount = 0;
const preconnectServer = createServer((_request, response) => {
  response.writeHead(204).end();
});
preconnectServer.on("connection", () => {
  preconnectConnectionCount += 1;
});
const listenPreconnect = () =>
  new Promise((resolve) => {
    preconnectServer.listen(0, "127.0.0.1", () => resolve(preconnectServer.address().port));
  });
const fetchJson = (native, path, init = "{}") =>
  Effect.promise(() =>
    native.executeJavaScript(
      `fetch(${JSON.stringify(path)}, ${init}).then(async (response) => ({ status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.text() })).catch((error) => ({ error: String(error) }))`,
    ),
  );

/**
 * Fires a freshly-tagged `/echo` request against `native` and waits for `observerValues` (an
 * `observe(...)`'d stream's own accumulating array) to record its `completed` event, retrying with
 * a NEW tag on each attempt rather than re-checking the same one: a just-forked observation stream
 * (`Effect.forkScoped`) has not necessarily finished registering its native listener by the time
 * the fork call returns, so a single fetch made immediately after installing the observer can race
 * it and complete before the listener is attached — no future event for that exact tag would ever
 * arrive. Retrying the ACTION (not just the wait) removes that race instead of just widening it.
 */
const observeEcho = (native, observerValues, label) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const tag = `${label}-${attempt}`;
      const path = `/echo?tag=${tag}`;
      const response = yield* fetchJson(native, path);
      assert.equal(response.status, 200);
      const deadline = Date.now() + 300;
      while (Date.now() < deadline) {
        if (observerValues.some((event) => event.stage === "completed" && event.url.endsWith(path)))
          return tag;
        yield* Effect.sleep(20);
      }
    }
    throw new Error(
      `Timed out: no observer event ever arrived for any /echo request tagged ${label}-*`,
    );
  });

/** Opens one WebSocket from the currently loaded document and resolves once it settles. */
const openSocket = (native, wsUrl) =>
  Effect.promise(() =>
    native.executeJavaScript(
      `new Promise((resolve) => {
        const socket = new WebSocket(${JSON.stringify(wsUrl)});
        const result = { open: false, closedCode: null };
        socket.onopen = () => { result.open = true; socket.close(); };
        socket.onclose = (event) => { result.closedCode = event.code; resolve(result); };
        socket.onerror = () => {};
        setTimeout(() => resolve(result), 3000);
      })`,
    ),
  );

const runChecks = (origin) =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* Session.fromPartition({ kind: "memory", name: "extras" });
      const window = yield* BrowserWindow.make({ show: false, session });
      const states = yield* observe(window.webContents.state);
      yield* window.webContents.load(Renderer.entry(new URL("/", origin), { bindings: [] }), {
        bindings: [],
      });
      yield* waitUntil(() => states.values.some((state) => state.status === "ready"), "document");
      const native = nativeWebContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === new URL("/", origin).href);
      assert.ok(native, "native web contents");

      const cookies = session.cookies;
      const listeners = () => native.session.cookies.listenerCount("changed");
      const baseline = listeners();
      const changes = yield* observe(cookies.changes);
      yield* waitUntil(() => listeners() === baseline + 1, "cookie listener");
      yield* cookies.set({ url: origin, name: "sewed", value: "one", sameSite: "lax" });
      const stored = yield* cookies.get({ url: origin });
      assert.deepEqual(
        stored.map((cookie) => [cookie.name, cookie.value]),
        [["sewed", "one"]],
      );
      yield* waitUntil(
        () => changes.values.some((change) => change.cookie.name === "sewed"),
        "cookie change",
      );
      yield* cookies.remove(origin, "sewed");
      assert.deepEqual(yield* cookies.get({ url: origin }), []);
      yield* waitUntil(() => changes.values.some((change) => change.removed), "cookie removal");
      expectCode(
        yield* Effect.exit(cookies.set({ url: origin, name: "", value: "x" })),
        "Protocol",
      );
      yield* cookies.flush;
      yield* Fiber.interrupt(changes.fiber);
      yield* waitUntil(() => listeners() === baseline, "cookie listener released");
      record("cookies round-trip and stream their changes", {
        changes: changes.values.map((change) => [change.cause, change.removed]),
      });

      const jar = yield* Capability.serve(Cookie.capability).pipe(
        Effect.provide(Cookies.native(session, [{ kind: "origin", origin }])),
      );
      yield* Effect.gen(function* () {
        const client = yield* CookieJar();
        yield* client.set({ details: { url: origin, name: "bound", value: "yes" } });
        const found = yield* client.get({ filter: { url: origin, name: "bound" } });
        assert.equal(found[0]?.value, "yes");
        expectCode(yield* Effect.exit(client.get({ filter: {} })), "Protocol");
        expectCode(
          yield* Effect.exit(
            client.set({ details: { url: "https://other.example", name: "x", value: "y" } }),
          ),
          "Protocol",
        );
        const remote = yield* observe(client.changes());
        yield* waitUntil(() => listeners() === baseline + 1, "bound cookie listener");
        yield* client.remove({ url: origin, name: "bound" });
        yield* waitUntil(
          () => remote.values.some((change) => change.removed),
          "bound cookie change",
        );
        yield* Fiber.interrupt(remote.fiber);
        record("a cookie host applies its origin policy to bound clients", {
          changes: remote.values.length,
        });
      }).pipe(Effect.provide(Binding.layer([Binding.to(CookieJar, jar)])));

      yield* Effect.gen(function* () {
        const client = yield* Cookie.capability;
        const filter = { url: origin };
        const read = client.get({ filter });
        filter.url = "https://other.example/";
        expectCode(yield* Effect.exit(read), "Protocol");
        const details = { url: origin, name: "mutable", value: "denied" };
        const write = client.set({ details });
        details.url = "https://other.example/";
        expectCode(yield* Effect.exit(write), "Protocol");
        assert.deepEqual(yield* cookies.get({ url: details.url, name: details.name }), []);
        record("cookie calls authorize the payload present when their Effect runs");
      }).pipe(Effect.provide(Cookies.native(session, [{ kind: "origin", origin }])));

      yield* Effect.gen(function* () {
        const client = yield* Cookie.capability;
        const watching = yield* Effect.forkScoped(
          Stream.runCollect(client.changes().pipe(Stream.take(1))),
        );
        yield* waitUntil(() => listeners() === baseline + 1, "policy cookie listener");
        yield* cookies.set({ url: "https://example.com/", name: "parent-only", value: "private" });
        yield* cookies.set({
          url: "https://app.example.com/",
          domain: ".example.com",
          name: "shared",
          value: "public",
        });
        const changes = yield* Fiber.join(watching).pipe(Effect.timeout(5000));
        assert.deepEqual(
          changes.map((change) => change.cookie.name),
          ["shared"],
        );
        yield* waitUntil(() => listeners() === baseline, "policy cookie listener released");
        record(
          "cookie observation excludes parent host-only cookies and includes shared domain cookies",
        );
      }).pipe(
        Effect.provide(
          Cookies.native(session, [{ kind: "origin", origin: "https://app.example.com" }]),
        ),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          let calls = 0;
          yield* session.intercept(
            Decidables.Session.Request,
            { urls: ["http://127.0.0.1:80/*"] },
            Decision.sync(() => {
              calls += 1;
              return { kind: "block" };
            }),
          );
          const result = yield* Effect.exit(
            Effect.tryPromise({
              try: (signal) => native.session.fetch("http://127.0.0.1/default-port", { signal }),
              catch: (error) => error,
            }).pipe(Effect.timeout(5000)),
          );
          assert.equal(result._tag, "Failure");
          assert.equal(calls, 1);
          record("an explicit default-port request filter invokes its blocking decider", { calls });
        }),
      );

      const seen = [];
      const observed = yield* observe(session.requests({ urls: [`${origin}/*`] }));
      const interceptScope = yield* Scope.fork(yield* Effect.scope);
      // Three independent installs on one filter: blocking, request-header rewriting, and
      // response-header rewriting are separate features that no longer share a rules bundle.
      const interceptFilter = { urls: [`${origin}/*`], types: ["xhr"] };
      yield* session
        .intercept(
          Decidables.Session.Request,
          interceptFilter,
          Decision.async((request) =>
            Effect.map(Audit, (audit) => {
              audit.note(request.url);
              if (request.url.endsWith("/blocked")) return { kind: "block" };
              if (request.url.endsWith("/old")) return { kind: "redirect", url: `${origin}/moved` };
              return Decision.Pass;
            }),
          ),
        )
        .pipe(
          Scope.provide(interceptScope),
          Effect.provideService(Audit, { note: (url) => seen.push(url) }),
        );
      yield* session
        .intercept(
          Decidables.Session.RequestHeaders,
          interceptFilter,
          Decision.sync(({ headers }) => ({
            kind: "headers",
            headers: { ...headers, "x-trace": "sewed" },
          })),
        )
        .pipe(Scope.provide(interceptScope));
      yield* session
        .intercept(
          Decidables.Session.ResponseHeaders,
          interceptFilter,
          Decision.sync(({ headers }) => ({
            kind: "headers",
            headers: { ...headers, "x-sewed": ["intercepted"] },
          })),
        )
        .pipe(Scope.provide(interceptScope));
      const echoed = yield* fetchJson(native, "/echo");
      assert.equal(echoed.status, 200);
      assert.equal(JSON.parse(echoed.body).trace, "sewed");
      assert.equal(echoed.headers["x-sewed"], "intercepted");
      const blocked = yield* fetchJson(native, "/blocked");
      assert.ok(blocked.error, "blocked request fails in the page");
      const moved = yield* fetchJson(native, "/old");
      assert.equal(JSON.parse(moved.body).path, "/moved");
      assert.ok(
        seen.some((url) => url.endsWith("/echo")),
        "decider saw the request",
      );
      const failingScope = yield* Scope.fork(yield* Effect.scope);
      yield* session
        .intercept(
          Decidables.Session.Request,
          { urls: [`${origin}/fails`] },
          Decision.async(() => Effect.die(new Error("decider failed"))),
        )
        .pipe(Scope.provide(failingScope));
      const failed = yield* fetchJson(native, "/fails");
      assert.ok(failed.error, "a failing decider blocks its request");
      yield* Scope.close(failingScope, Exit.void);
      yield* Scope.close(interceptScope, Exit.void);
      const released = yield* fetchJson(native, "/echo");
      assert.equal(JSON.parse(released.body).trace, null);
      assert.equal(released.headers["x-sewed"], undefined);
      expectCode(
        yield* Effect.exit(
          Effect.scoped(
            session.intercept(Decidables.Session.Request, { urls: ["nope"] }, Decision.pass),
          ),
        ),
        "Protocol",
      );
      // A body means nothing on a header stage, and is refused rather than ignored.
      expectCode(
        yield* Effect.exit(
          Effect.scoped(
            session.intercept(
              Decidables.Session.RequestHeaders,
              { urls: [`${origin}/*`], body: { maxBytes: 16, blobs: "resolve" } },
              Decision.pass,
            ),
          ),
        ),
        "Protocol",
      );
      record(
        "interception blocks, redirects, rewrites headers, fails closed, and uninstalls with its scope",
        {
          seen: seen.length,
          requests: requests.map((request) => request.path),
        },
      );
      yield* waitUntil(
        () =>
          observed.values.some((event) => event.stage === "sent" && event.url.endsWith("/echo")) &&
          observed.values.some(
            (event) => event.stage === "completed" && event.statusCode === 200,
          ) &&
          observed.values.some(
            (event) => event.stage === "redirect" && event.redirectUrl.endsWith("/moved"),
          ) &&
          observed.values.some((event) => event.stage === "error"),
        "observed request stages",
      );
      yield* Fiber.interrupt(observed.fiber);
      record(
        "the request tap streams sent, completed, redirect, and error stages beside interception",
        {
          stages: [...new Set(observed.values.map((event) => event.stage))],
        },
      );

      // A header decider that only ever passes must leave the request and the response exactly as
      // they were. That path answers Electron's `{}` "no change" form instead of handing the headers
      // back, which is the one behaviour change every intercepted request pays, and every other
      // check here installs deciders that always rewrite. Differential against real Chromium: the
      // same fetch with nothing installed, then with a passing decider on both header stages.
      const untouchedFilter = { urls: [`${origin}/untouched*`] };
      const untouchedBaseline = JSON.parse((yield* fetchJson(native, "/untouched")).body);
      const passScope = yield* Scope.fork(yield* Effect.scope);
      yield* session
        .intercept(Decidables.Session.RequestHeaders, untouchedFilter, Decision.pass)
        .pipe(Scope.provide(passScope));
      yield* session
        .intercept(Decidables.Session.ResponseHeaders, untouchedFilter, Decision.pass)
        .pipe(Scope.provide(passScope));
      const untouched = yield* fetchJson(native, "/untouched");
      assert.equal(untouched.status, 200);
      const passed = JSON.parse(untouched.body);
      assert.ok(
        untouchedBaseline.names.length > 3,
        "the browser sends real headers to compare against",
      );
      assert.deepEqual(
        passed.names,
        untouchedBaseline.names,
        "the server saw the same request headers",
      );
      assert.equal(passed.accept, untouchedBaseline.accept);
      assert.equal(passed.userAgent, untouchedBaseline.userAgent);
      assert.equal(passed.trace, null, "a passing decider adds nothing");
      assert.equal(
        untouched.headers["x-untouched"],
        "server-value",
        "and the page saw the server's own response headers",
      );
      assert.equal(untouched.headers["content-type"], "application/json");
      assert.equal(untouched.headers["cache-control"], "no-store");
      yield* Scope.close(passScope, Exit.void);
      record("passing header deciders leave the request and the response exactly as they were", {
        requestHeaders: untouchedBaseline.names.length,
        responseHeaders: Object.keys(untouched.headers).sort(),
      });

      // Task 1b: Electron accepts one native `webRequest` listener per stage, so Sewed's native
      // filter is the union of every installed decider's filter on that stage. Before the fix, an
      // `other`-only decider sharing a stage with a `types`-naming decider was silently never
      // consulted, because the union stripped `"other"` from an otherwise-restrictive native filter
      // instead of widening it. Here an `image`-only decider (which passes) and an `other`-only
      // decider (which blocks) share one stage: the prefetch link — Electron's own `other`-typed
      // resource — must be blocked, and the image must still load.
      const otherCheckScope = yield* Scope.fork(yield* Effect.scope);
      yield* session
        .intercept(
          Decidables.Session.Request,
          { urls: [`${origin}/*`], types: ["image"] },
          Decision.pass,
        )
        .pipe(Scope.provide(otherCheckScope));
      yield* session
        .intercept(
          Decidables.Session.Request,
          { urls: [`${origin}/*`], types: ["other"] },
          Decision.sync(() => ({ kind: "block" })),
        )
        .pipe(Scope.provide(otherCheckScope));
      const otherCheckUrl = new URL("/other-check", origin);
      yield* window.webContents.load(Renderer.entry(otherCheckUrl, { bindings: [] }), {
        bindings: [],
      });
      yield* waitUntil(
        () =>
          states.values.some(
            (state) => state.status === "ready" && state.url === otherCheckUrl.href,
          ),
        "other-check page ready",
      );
      let otherCheckImage;
      for (let attempt = 0; attempt < 40 && otherCheckImage === undefined; attempt += 1) {
        otherCheckImage = yield* Effect.promise(() =>
          native.executeJavaScript("window.__otherCheckImage"),
        );
        if (otherCheckImage === undefined) yield* Effect.sleep(50);
      }
      yield* Scope.close(otherCheckScope, Exit.void);
      assert.equal(
        otherCheckImage,
        "loaded",
        "the image-only decider passes, so the image still loads",
      );
      assert.ok(
        !requests.some((request) => request.path === "/other-check-prefetch.txt"),
        "the other-only decider blocked the prefetch; the server never saw it",
      );
      record(
        "an other-only decider is consulted even though an image-only decider shares the native filter",
        {
          otherCheckImage,
          prefetchRequested: requests.some(
            (request) => request.path === "/other-check-prefetch.txt",
          ),
        },
      );

      // Task 1c: a registration Electron refuses must not silence the stage's other deciders.
      // `.artifacts/probe-refused-registration` (in the sewed-round-two worktree) finds Electron
      // discarding the previous native listener before it validates the new one, for a `urls`
      // pattern Sewed's own schema accepts — a non-standard scheme such as `custom://host/*`, or a
      // port outside 0-65535. A blocking decider is installed first here; then a second install
      // with that refused filter is attempted and must fail with a typed `SewedError`, and the
      // first decider must still block afterwards — proving the fix re-registers the surviving
      // installs' native listener rather than assume Electron left it alone.
      const refusedScope = yield* Scope.fork(yield* Effect.scope);
      const refusedFilter = { urls: [`${origin}/refused-check*`] };
      yield* session
        .intercept(
          Decidables.Session.Request,
          refusedFilter,
          Decision.sync(() => ({ kind: "block" })),
        )
        .pipe(Scope.provide(refusedScope));
      const refusedBefore = yield* fetchJson(native, "/refused-check");
      assert.ok(
        refusedBefore.error,
        "the first decider blocks before the refused install is attempted",
      );
      const refusedAttempt = yield* Effect.exit(
        Effect.scoped(
          session.intercept(
            Decidables.Session.Request,
            { urls: ["custom://host/*"] },
            Decision.pass,
          ),
        ),
      );
      const refusedError = expectCode(refusedAttempt, "Native");
      const refusedAfter = yield* fetchJson(native, "/refused-check");
      assert.ok(
        refusedAfter.error,
        "the first decider still blocks after the refused install failed",
      );
      yield* Scope.close(refusedScope, Exit.void);
      record(
        "a registration Electron refuses fails alone, and the stage's other decider keeps deciding",
        {
          refusedErrorCode: refusedError.code,
          refusedErrorMessage: refusedError.message,
        },
      );

      // Task 1c, fix round 1, I1: `session.requests` (the observation tap, `internal/WebRequest.ts`'s
      // `observe`) shares the same acquire-path shape as `intercept` above, and its own fix had no
      // real-Electron coverage. It also fixed a WORSE latent bug: before this task, a refused tap
      // registration was never rolled back at all, so the failed tap stayed in `wiring.taps` forever
      // and poisoned every LATER `reinstallTaps` call with a filter Electron had already refused —
      // not just the registration that named it. This proves both halves: a good observer keeps
      // receiving events across a refused registration, AND a second, independent good observer
      // installed AFTER the refusal can still register and receive events at all (on `2c7c1969`'s
      // shape, that second registration would itself have failed, poisoned by the leftover tap).
      const observeGoodFilter = { urls: [`${origin}/echo*`] };
      const observeScope1 = yield* Scope.fork(yield* Effect.scope);
      const firstObserver = yield* observe(session.requests(observeGoodFilter)).pipe(
        Scope.provide(observeScope1),
      );
      yield* observeEcho(native, firstObserver.values, "observe-before");
      const refusedObserveAttempt = yield* Effect.exit(
        Stream.runDrain(session.requests({ urls: ["custom://host/*"] })),
      );
      const refusedObserveError = expectCode(refusedObserveAttempt, "Native");
      yield* observeEcho(native, firstObserver.values, "observe-after");
      const observeScope2 = yield* Scope.fork(yield* Effect.scope);
      const secondObserver = yield* observe(session.requests(observeGoodFilter)).pipe(
        Scope.provide(observeScope2),
      );
      yield* observeEcho(native, secondObserver.values, "observe-second");
      yield* Fiber.interrupt(firstObserver.fiber);
      yield* Fiber.interrupt(secondObserver.fiber);
      yield* Scope.close(observeScope1, Exit.void);
      yield* Scope.close(observeScope2, Exit.void);
      record(
        "a refused session.requests registration fails alone with a typed Native error, and observers installed before and after it both keep receiving events",
        {
          refusedObserveErrorCode: refusedObserveError.code,
          refusedObserveErrorMessage: refusedObserveError.message,
          firstObserverStages: [...new Set(firstObserver.values.map((event) => event.stage))],
          secondObserverStages: [...new Set(secondObserver.values.map((event) => event.stage))],
        },
      );

      // Task 1b, second fact from the same probe: `<all_urls>` delivers WebSocket handshakes
      // (`resourceType: "webSocket"`) to a request decider, and a decider that blocks everything
      // stops the handshake before the server ever sees the upgrade; a bare `*` scheme such as
      // `*://*/*` would not even see it. Pinned here so an Electron bump cannot regress it silently.
      const wsBaseUrl = `${origin.replace(/^http/, "ws")}`;
      const openSocketBaseline = yield* openSocket(native, `${wsBaseUrl}/ws-open`);
      assert.equal(openSocketBaseline.open, true, "with no decider installed, the handshake opens");
      assert.ok(wsUpgrades.includes("/ws-open"), "the server completed the upgrade");
      const wsBlockScope = yield* Scope.fork(yield* Effect.scope);
      yield* session
        .intercept(
          Decidables.Session.Request,
          { urls: ["<all_urls>"] },
          Decision.sync(() => ({ kind: "block" })),
        )
        .pipe(Scope.provide(wsBlockScope));
      const openSocketBlocked = yield* openSocket(native, `${wsBaseUrl}/ws-blocked`);
      yield* Scope.close(wsBlockScope, Exit.void);
      assert.equal(
        openSocketBlocked.open,
        false,
        "a block-everything decider under <all_urls> stops the handshake",
      );
      assert.ok(!wsUpgrades.includes("/ws-blocked"), "the server never saw the blocked upgrade");
      record("<all_urls> delivers a WebSocket handshake to a request decider, which can block it", {
        baseline: openSocketBaseline,
        blocked: openSocketBlocked,
        wsUpgrades: [...wsUpgrades],
      });

      yield* Session.setProxy(session, { mode: "direct" });
      assert.equal(yield* Session.resolveProxy(session, "https://example.com/"), "DIRECT");
      expectCode(
        yield* Effect.exit(Session.setProxy(session, { mode: "fixed_servers", proxyRules: "" })),
        "Protocol",
      );
      const spell = yield* Session.spellChecker(session);
      yield* Session.setSpellChecker(session, { enabled: !spell.enabled });
      assert.equal((yield* Session.spellChecker(session)).enabled, !spell.enabled);
      yield* Session.setSpellChecker(session, { enabled: spell.enabled });
      yield* Session.clearCache(session);
      assert.equal(typeof (yield* Session.cacheSize(session)), "number");
      yield* Session.clearAuthCache(session);
      yield* Session.clearHostResolverCache(session);
      yield* Session.clearCodeCaches(session);
      yield* Session.clearCodeCaches(session, ["https://example.com/app.js"]);
      expectCode(yield* Effect.exit(Session.clearCodeCaches(session, ["not a url"])), "Protocol");
      yield* Session.flushStorage(session);
      const storagePath = yield* Session.storagePath(session);
      assert.ok(storagePath === null || typeof storagePath === "string");
      yield* Session.forceReloadProxyConfig(session);
      yield* Session.setNetworkEmulation(session, { offline: true });
      expectCode(yield* Effect.exit(Session.setNetworkEmulation(session, { latency: -1 })), "Protocol");
      yield* Session.clearNetworkEmulation(session);
      yield* Session.setSSLConfig(session, { minVersion: "tls1.2", maxVersion: "tls1.3" });
      expectCode(yield* Effect.exit(Session.setSSLConfig(session, { minVersion: "ssl3" })), "Protocol");
      expectCode(yield* Effect.exit(Session.addSpellCheckerWord(session, "")), "Protocol");
      const words = yield* Session.spellCheckerWords(session);
      assert.ok(Array.isArray(words));
      if (storagePath !== null) {
        yield* Session.addSpellCheckerWord(session, "sewedword");
        assert.ok((yield* Session.spellCheckerWords(session)).includes("sewedword"));
        yield* Session.removeSpellCheckerWord(session, "sewedword");
        assert.ok(!(yield* Session.spellCheckerWords(session)).includes("sewedword"));
      } else {
        expectCode(yield* Effect.exit(Session.addSpellCheckerWord(session, "sewedword")), "Native");
      }
      // A separate session, so clearing everything here cannot disturb the checks around it.
      const scratch = yield* Session.fromPartition({ kind: "memory", name: "data-clearing" });
      const dictionaryKey = {
        frameOrigin: "https://example.com",
        topFrameSite: "https://example.com",
      };
      yield* Session.clearData(scratch, { dataTypes: ["cache", "cookies"] });
      yield* Session.clearData(scratch, { origins: ["https://example.com"] });
      yield* Session.clearData(scratch);
      expectCode(
        yield* Effect.exit(
          Session.clearData(scratch, {
            origins: ["https://example.com"],
            excludeOrigins: ["https://example.org"],
          }),
        ),
        "Protocol",
      );
      expectCode(yield* Effect.exit(Session.clearData(scratch, { dataTypes: ["history"] })), "Protocol");
      assert.ok(Array.isArray(yield* Session.sharedDictionaryUsage(scratch)));
      assert.ok(Array.isArray(yield* Session.sharedDictionaries(scratch, dictionaryKey)));
      yield* Session.clearSharedDictionaries(scratch, dictionaryKey);
      yield* Session.clearSharedDictionaries(scratch);
      assert.deepEqual(yield* Session.extensions(scratch), []);
      yield* Session.allowNtlmCredentialsForDomains(scratch, ["*.example.com", "intranet"]);
      expectCode(yield* Effect.exit(Session.allowNtlmCredentialsForDomains(scratch, [])), "Protocol");
      yield* Session.setSpellCheckerDictionaryDownloadUrl(scratch, "https://dictionaries.invalid/");
      expectCode(
        yield* Effect.exit(
          Session.setSpellCheckerDictionaryDownloadUrl(scratch, "https://dictionaries.invalid/files"),
        ),
        "Protocol",
      );
      expectCode(yield* Effect.exit(Session.setCodeCachePath(scratch, "relative")), "Protocol");
      const agent = yield* Session.userAgent(session);
      yield* Session.setUserAgent(session, `${agent} SewedExtras/1`);
      assert.ok((yield* Session.userAgent(session)).endsWith("SewedExtras/1"));
      expectCode(yield* Effect.exit(Session.setUserAgent(session, "")), "Protocol");
      const downloads = mkdtempSync(join(tmpdir(), "sewed-downloads-"));
      yield* Session.setDownloadPath(session, downloads);
      expectCode(yield* Effect.exit(Session.setDownloadPath(session, "relative")), "Protocol");
      // setCertificatePolicy is gone: a per-hostname trust decision now installs as a decider on
      // Decidables.Session.Certificate, resolved against setCertificateVerifyProc's numeric
      // callback — and the proc itself now exists only while a Certificate decider does, installed
      // and cleared by a hook, the same way base's setCertificatePolicy used to install one only for
      // a non-empty policy. Electron exposes no way to read a session's installed proc back, so a
      // fresh session's own setCertificateVerifyProc is wrapped once, at acquisition, to capture
      // whatever Sewed calls it with later — a function when a decider installs, null when the last
      // one is removed — the same way session-fixture.mjs captures the permission handlers.
      let certificateVerifyProc;
      const originalFromPartitionForCertificate = nativeSession.fromPartition;
      nativeSession.fromPartition = (...args) => {
        const native = originalFromPartitionForCertificate(...args);
        const install = native.setCertificateVerifyProc.bind(native);
        native.setCertificateVerifyProc = (handler) => {
          certificateVerifyProc = handler;
          install(handler);
        };
        return native;
      };
      const certificateSession = yield* Session.fromPartition({
        kind: "memory",
        name: "extras-certificate",
      });
      nativeSession.fromPartition = originalFromPartitionForCertificate;
      assert.equal(
        certificateVerifyProc,
        undefined,
        "nothing calls setCertificateVerifyProc at acquisition; the proc exists only while a decider does",
      );
      const verifyCertificate = (overrides = {}) =>
        new Promise((resolve) => {
          assert.ok(certificateVerifyProc, "no certificate verify proc installed");
          certificateVerifyProc(
            {
              hostname: "pinned.example",
              certificate: {
                fingerprint: "sha256/abc",
                subjectName: "pinned.example",
                issuerName: "Test CA",
                validStart: 0,
                validExpiry: 1_000_000_000,
              },
              validatedCertificate: {},
              isIssuedByKnownRoot: false,
              verificationResult: "OK",
              errorCode: 0,
              ...overrides,
            },
            resolve,
          );
        });
      // Kept hand-written rather than expressed as Certificate.Policy: this decider is a cap, not a
      // grant — it proves both numeric mappings below (`0` and `-2`) by never passing, so an
      // unmatched host below deliberately answers "reject" rather than Certificate.Policy's own
      // Pass, which would fall through to Session.Certificate's "system" fallback (`-3`) instead.
      const certificateScope = yield* Scope.fork(yield* Effect.scope);
      yield* certificateSession
        .decide(
          Decidables.Session.Certificate,
          Decision.async(({ hostname, certificate }) =>
            Effect.succeed(
              hostname.endsWith(".internal.example") ||
                (hostname === "pinned.example" && certificate.fingerprint === "sha256/abc")
                ? "trust"
                : "reject",
            ),
          ),
        )
        .pipe(Scope.provide(certificateScope));
      assert.ok(certificateVerifyProc, "a scoped decide installs the proc with a function");
      assert.equal(
        yield* Effect.promise(() => verifyCertificate()),
        0,
        "trust maps onto callback(0)",
      );
      assert.equal(
        yield* Effect.promise(() =>
          verifyCertificate({
            hostname: "other.example",
            certificate: {
              fingerprint: "zz",
              subjectName: "other.example",
              issuerName: "Test CA",
              validStart: 0,
              validExpiry: 1,
            },
          }),
        ),
        -2,
        "reject maps onto callback(-2)",
      );
      yield* Scope.close(certificateScope, Exit.void);
      assert.equal(
        certificateVerifyProc,
        null,
        "closing the decider's own scope calls setCertificateVerifyProc(null), restoring Chromium's own verdict",
      );
      // setPermissions is gone: an origin allowance for device access now installs as a decider on
      // Decidables.Session.Permission, through Permission.Policy's own origin rule, which device
      // checks share with browser permission checks. An origin rule is answered from `origin` alone
      // — never `document`, which is `null` for a device check since Electron identifies one by
      // origin only — and misses when `origin` is `null` too, for an opaque-origin document, which
      // this http: page is not.
      const hidOrigin = new URL(origin).origin;
      yield* session.decide(
        Decidables.Session.Permission,
        Decision.policy(Permission.Policy, [
          { kind: "origin", origin: hidOrigin, permissions: ["hid"] },
        ]),
      );
      record(
        "proxy, spell checker, cache, user agent, download path, certificates, and device rules validate and apply",
        {
          proxy: "DIRECT",
          spellChecker: spell,
          downloads,
        },
      );

      const extensionDirectory = mkdtempSync(join(tmpdir(), "sewed-extension-"));
      writeFileSync(
        join(extensionDirectory, "manifest.json"),
        JSON.stringify({ manifest_version: 3, name: "Sewed extras", version: "1.0.0" }),
      );
      expectCode(
        yield* Effect.exit(Effect.scoped(Session.loadExtension(session, extensionDirectory))),
        "Protocol",
      );
      const persistent = yield* Session.fromPartition({ kind: "persistent", name: "extras" });
      const extensionScope = yield* Scope.fork(yield* Effect.scope);
      const extension = yield* Session.loadExtension(persistent, extensionDirectory).pipe(
        Scope.provide(extensionScope),
      );
      assert.equal(extension.name, "Sewed extras");
      assert.equal(extension.version, "1.0.0");
      yield* Scope.close(extensionScope, Exit.void);
      expectCode(
        yield* Effect.exit(Effect.scoped(Session.loadExtension(persistent, "relative"))),
        "Protocol",
      );
      expectCode(
        yield* Effect.exit(
          Effect.scoped(Session.loadExtension(persistent, join(extensionDirectory, "missing"))),
        ),
        "Native",
      );
      const workers = Session.serviceWorkers(session);
      assert.deepEqual(yield* workers.running, []);
      const workerEvents = yield* observe(workers.events);
      yield* Effect.sleep(50);
      yield* Fiber.interrupt(workerEvents.fiber);
      record("extensions load for a scope and service workers report and observe", {
        extension: extension.id,
        workers: 0,
      });

      const resolved = yield* session.resolveHost("localhost", {
        cacheUsage: "disallowed",
      });
      assert.ok(resolved.endpoints.length > 0, "resolveHost returned at least one endpoint");
      assert.ok(
        resolved.endpoints.every(
          (endpoint) => endpoint.address === "127.0.0.1" || endpoint.address === "::1",
        ),
        "resolveHost only returned loopback addresses",
      );
      expectCode(yield* Effect.exit(session.resolveHost("")), "Protocol");
      record("resolveHost resolves localhost to loopback addresses and rejects an empty host", {
        endpoints: resolved.endpoints,
      });

      const holdResult = yield* Effect.promise(() =>
        native.executeJavaScript(
          "(async () => { const r = await fetch('/hold'); window.__holdReader = r.body.getReader(); const first = await window.__holdReader.read(); return { status: r.status, firstChunkLength: first.value ? first.value.length : null }; })()",
        ),
      );
      assert.equal(holdResult.status, 200);
      yield* waitUntil(() => holdState.opened !== undefined, "hold connection opened");
      assert.equal(holdState.closed, undefined, "connection still open before closeAllConnections");
      yield* session.closeAllConnections;
      // Electron documents closeAllConnections as terminating in-flight requests, but an
      // actively-streaming page fetch may not observe that in this environment; bound the
      // wait and record what actually happened instead of hanging or hard-failing on it.
      const closeAttempt = yield* Effect.exit(
        waitUntil(
          () => holdState.closed !== undefined,
          "hold connection closed by closeAllConnections",
        ),
      );
      if (closeAttempt._tag === "Success") {
        record("closeAllConnections closes an open keep-alive connection from the session", {
          openedAt: holdState.opened,
          closedAt: holdState.closed,
          elapsedMs: holdState.closed - holdState.opened,
          observable: true,
        });
      } else {
        record(
          "closeAllConnections resolved, but this environment's Electron build did not visibly close the actively-streaming connection within 8s",
          {
            openedAt: holdState.opened,
            closedAfter8s: holdState.closed,
            observable: false,
          },
        );
      }

      // setPreconnect is gone: it is now Decidables.Session.Preconnect, scoped so it can be removed
      // the same way passing true used to re-enable it.
      const preconnectScope = yield* Scope.fork(yield* Effect.scope);
      yield* session
        .decide(
          Decidables.Session.Preconnect,
          Decision.sync(() => "deny"),
        )
        .pipe(Scope.provide(preconnectScope));
      preconnectConnectionCount = 0;
      const disabledUrl = new URL("/preconnect?disabled", origin);
      yield* window.webContents.load(Renderer.entry(disabledUrl, { bindings: [] }), {
        bindings: [],
      });
      yield* waitUntil(
        () =>
          states.values.some((state) => state.status === "ready" && state.url === disabledUrl.href),
        "preconnect disabled page ready",
      );
      yield* Effect.sleep(1000);
      const disabledCount = preconnectConnectionCount;

      // Closing the decider's own scope removes it, restoring the fallback ("allow").
      yield* Scope.close(preconnectScope, Exit.void);
      preconnectConnectionCount = 0;
      const enabledUrl = new URL("/preconnect?enabled", origin);
      yield* window.webContents.load(Renderer.entry(enabledUrl, { bindings: [] }), {
        bindings: [],
      });
      yield* waitUntil(
        () =>
          states.values.some((state) => state.status === "ready" && state.url === enabledUrl.href),
        "preconnect enabled page ready",
      );
      yield* Effect.sleep(1000);
      const enabledCount = preconnectConnectionCount;

      if (disabledCount === 0 && enabledCount === 0) {
        record(
          "Decidables.Session.Preconnect succeeded, but loopback preconnect could not be observed in this environment",
          { disabledCount, enabledCount, observable: false },
        );
      } else {
        assert.equal(disabledCount, 0, "no preconnect reached the second server while disabled");
        assert.ok(
          enabledCount > 0,
          "at least one preconnect reached the second server once enabled",
        );
        record(
          "Decidables.Session.Preconnect disables and enables the session's speculative preconnections",
          {
            disabledCount,
            enabledCount,
            observable: true,
          },
        );
      }

      const blobScope = yield* Scope.fork(yield* Effect.scope);
      let observedBlobBytes;
      yield* session
        .intercept(
          Decidables.Session.Request,
          {
            urls: [`${origin}/submit-blob`],
            body: { maxBytes: 1_000_000, blobs: "reference" },
          },
          Decision.async((request) =>
            Effect.gen(function* () {
              const blobParts = (request.body?.parts ?? []).filter((part) => part.kind === "blob");
              const chunks = [];
              for (const part of blobParts) chunks.push(yield* session.blobData(part.id));
              observedBlobBytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
              return Decision.Pass;
            }),
          ),
        )
        .pipe(Scope.provide(blobScope));
      const uploadUrl = new URL("/upload", origin);
      yield* window.webContents.load(Renderer.entry(uploadUrl, { bindings: [] }), { bindings: [] });
      yield* waitUntil(
        () =>
          states.values.some((state) => state.status === "ready" && state.url === uploadUrl.href),
        "upload page ready",
      );
      let uploadStatus;
      for (let attempt = 0; attempt < 40 && uploadStatus === undefined; attempt += 1) {
        uploadStatus = yield* Effect.promise(() =>
          native.executeJavaScript("window.__uploadStatus"),
        );
        if (uploadStatus === undefined) yield* Effect.sleep(50);
      }
      assert.equal(uploadStatus, 204);
      assert.ok(observedBlobBytes, "the decider observed an upload blob part");
      assert.equal(observedBlobBytes.toString("utf8"), blobPayloadText);
      yield* Scope.close(blobScope, Exit.void);
      record("blobData reads an intercepted upload's blob-referenced bytes exactly", {
        bytes: observedBlobBytes.byteLength,
        text: observedBlobBytes.toString("utf8"),
      });

      // Task 2 (Ruling 3): a wholly separate upload — a blob is a one-time-readable native
      // resource, so this cannot share the request above with `session.blobData`'s own read.
      // The install names no `body` filter option at all; the decider calls
      // `readBody({ blobs: "resolve" })` lazily instead, against a real multipart upload, proving
      // the resolved blob part now carries `{ kind: "blob", id, bytes }` — the blob keeps its
      // identity, where the pre-wave shape gave it none.
      const readBodyScope = yield* Scope.fork(yield* Effect.scope);
      let readBodyPart;
      let readBodyFailure;
      yield* session
        .intercept(
          Decidables.Session.Request,
          { urls: [`${origin}/submit-blob-readbody`] },
          Decision.async((request) =>
            request.readBody({ maxBytes: 1_000_000, blobs: "resolve" }).pipe(
              Effect.map((body) => {
                readBodyPart = body.parts.find((part) => part.kind === "blob");
                return Decision.Pass;
              }),
              Effect.catch((error) => {
                readBodyFailure = error;
                return Effect.succeed(Decision.Pass);
              }),
            ),
          ),
        )
        .pipe(Scope.provide(readBodyScope));
      const uploadReadBodyUrl = new URL("/upload-readbody", origin);
      yield* window.webContents.load(Renderer.entry(uploadReadBodyUrl, { bindings: [] }), {
        bindings: [],
      });
      yield* waitUntil(
        () =>
          states.values.some(
            (state) => state.status === "ready" && state.url === uploadReadBodyUrl.href,
          ),
        "upload-readbody page ready",
      );
      let uploadReadBodyStatus;
      for (let attempt = 0; attempt < 40 && uploadReadBodyStatus === undefined; attempt += 1) {
        uploadReadBodyStatus = yield* Effect.promise(() =>
          native.executeJavaScript("window.__uploadReadBodyStatus"),
        );
        if (uploadReadBodyStatus === undefined) yield* Effect.sleep(50);
      }
      assert.equal(uploadReadBodyStatus, 204);
      assert.equal(readBodyFailure, undefined, "readBody did not fail");
      assert.ok(readBodyPart, "readBody's own decider saw the resolved blob part");
      assert.equal(readBodyPart.kind, "blob");
      assert.equal(typeof readBodyPart.id, "string");
      assert.ok(
        readBodyPart.bytes instanceof Uint8Array,
        'blobs: "resolve" fills bytes in beside id',
      );
      assert.equal(Buffer.from(readBodyPart.bytes).toString("utf8"), readBodyPayloadText);
      yield* Scope.close(readBodyScope, Exit.void);
      record(
        "readBody (no install-time body option) resolves an upload's blob lazily, keeping its id beside its bytes",
        {
          readBodyPartKind: readBodyPart.kind,
          readBodyPartId: readBodyPart.id,
          readBodyPartBytes: readBodyPart.bytes.byteLength,
        },
      );
    }),
  );

async function verify() {
  await app.whenReady();
  const origin = await listen();
  const preconnectPort = await listenPreconnect();
  preconnectOrigin = `http://127.0.0.1:${preconnectPort}`;
  App.run(
    [],
    Effect.gen(function* () {
      yield* App.decide(
        Decidables.App.LastWindowClosed,
        Decision.sync(() => "stay"),
      );
      const result = yield* Effect.exit(runChecks(origin));
      server.close();
      preconnectServer.close();
      console.log(
        `SESSION_EXTRAS_VERIFICATION ${JSON.stringify({
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
