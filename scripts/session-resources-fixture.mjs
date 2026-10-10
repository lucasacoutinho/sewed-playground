import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { app, BrowserWindow as NativeBrowserWindow, session as nativeSession } from "electron";
import { Cause, Effect, Exit, Scope, Stream } from "effect";
import { HttpServerResponse } from "effect/http";
import { Decidables, Decision, Navigation, Permission, Renderer } from "sewed";
import { App, BrowserWindow, Download, Protocol, Session } from "sewed/main";

const marker = "SESSION_RESOURCES_VERIFICATION";
const checks = [];
const fixedBody = Buffer.from("sewed session resource completion\n");
const fixedHash = createHash("sha256").update(fixedBody).digest("hex");
const largeChunk = Buffer.alloc(256 * 1024, 71);
const largeBody = Buffer.concat(Array.from({ length: 48 }, () => largeChunk));
const largeHash = createHash("sha256").update(largeBody).digest("hex");
const proxyChunk = Buffer.alloc(64 * 1024, 89);
const proxyChunks = 6;
const proxyBody = Buffer.concat(Array.from({ length: proxyChunks }, () => proxyChunk));
const proxyHash = createHash("sha256").update(proxyBody).digest("hex");
// F3: a real local HTTP server a fetch-shaped handleWeb handler proxies, rather than the
// hand-rolled stream `/proxy` above answers with directly — 512 KiB over eight chunks, well past
// the 256 KiB floor the request asked for.
const bigChunk = Buffer.alloc(64 * 1024, 97);
const bigChunks = 8;
const bigBody = Buffer.concat(Array.from({ length: bigChunks }, () => bigChunk));
const bigHash = createHash("sha256").update(bigBody).digest("hex");
const textEncoder = new TextEncoder();

// F1: counts unhandled rejections across the whole fixture's lifetime, so the abort check below
// can assert none of them are the upstream fetch's own abort rejection leaking out of
// `internal/Protocol.ts`'s `close()` uncaught.
let unhandledRejections = 0;
process.on("unhandledRejection", (reason) => {
  unhandledRejections += 1;
  console.error("SESSION_RESOURCES_UNHANDLED_REJECTION", reason);
});
const protocolScheme = Protocol.scheme("sewedresource", {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  stream: true,
});

const record = (name, evidence = {}) => {
  checks.push({ name, evidence: structuredClone(evidence) });
  console.log(`PASS ${name}`);
};

const failure = (exit) => {
  assert.equal(exit._tag, "Failure");
  const error = Cause.findErrorOption(exit.cause);
  return error._tag === "Some" ? error.value : undefined;
};

const waitUntil = (read, description, timeout = 8_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = read();
      if (value) return value;
      yield* Effect.sleep(10);
    }
    throw new Error(`Timed out: ${description}`);
  });

const partitionKey = (name) =>
  `sewed-v1-${createHash("sha256").update(name, "utf16le").digest("hex")}`;

const makeHttpServer = () => {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/download/complete") {
      response.writeHead(200, {
        "content-length": fixedBody.byteLength,
        "content-type": "application/octet-stream",
      });
      response.end(fixedBody);
      return;
    }
    if (path === "/download/large") {
      const chunk = Buffer.alloc(256 * 1024, 71);
      let remaining = 48;
      response.writeHead(200, {
        "content-length": chunk.byteLength * remaining,
        "content-type": "application/octet-stream",
      });
      let timer;
      const write = () => {
        if (remaining === 0) {
          response.end();
          return;
        }
        remaining -= 1;
        if (!response.write(chunk)) {
          response.once("drain", write);
        } else {
          timer = setTimeout(write, 15);
        }
      };
      write();
      response.once("close", () => clearTimeout(timer));
      return;
    }
    if (path === "/download/cancel") {
      const chunk = Buffer.alloc(64 * 1024, 67);
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "transfer-encoding": "chunked",
      });
      const timer = setInterval(() => response.write(chunk), 20);
      response.once("close", () => clearInterval(timer));
      return;
    }
    if (path === "/big") {
      // F3: the upstream a fetch-shaped handleWeb handler proxies — eight 64 KiB chunks, paced
      // 10ms apart, so both the full-read and the abort-mid-body checks below have real chunk
      // boundaries to land on rather than one synchronous write.
      response.writeHead(200, { "content-type": "application/octet-stream" });
      let index = 0;
      let closed = false;
      response.once("close", () => {
        closed = true;
      });
      const tick = () => {
        if (closed) return;
        if (index >= bigChunks) {
          response.end();
          return;
        }
        response.write(bigChunk);
        index += 1;
        setTimeout(tick, 10);
      };
      tick();
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  return server;
};

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });

const closeServer = (server) =>
  new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });

const runChecks = ({ origin, artifactRoot }) =>
  Effect.gen(function* () {
    const alpha = yield* Session.fromPartition({ kind: "memory", name: "resource-alpha" });
    const beta = yield* Session.fromPartition({ kind: "memory", name: "resource-beta" });
    const alphaNative = nativeSession.fromPartition(partitionKey("resource-alpha"));
    const betaNative = nativeSession.fromPartition(partitionKey("resource-beta"));
    const protocolScope = yield* Scope.fork(yield* Effect.scope);
    let finalized = 0;
    let waitingStarted = 0;
    const handler = (request) =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => (finalized += 1)));
        const path = new URL(request.originalUrl).pathname;
        if (path === "/stream") {
          return HttpServerResponse.stream(
            Stream.fromIterable([textEncoder.encode("first\n"), textEncoder.encode("second\n")]),
          );
        }
        if (path === "/empty") return HttpServerResponse.empty({ status: 204 });
        if (path === "/infinite") {
          return HttpServerResponse.stream(
            Stream.fromEffectRepeat(Effect.succeed(textEncoder.encode("loop\n"))),
          );
        }
        if (path === "/waiting") {
          yield* Effect.sync(() => (waitingStarted += 1));
          return yield* Effect.never;
        }
        return HttpServerResponse.text(`session-alpha:${path}`);
      });
    yield* Protocol.handle(alpha, protocolScheme, handler).pipe(Scope.provide(protocolScope));

    const response = yield* Effect.promise(() => alphaNative.fetch("sewedresource://unit/stream"));
    assert.equal(response.status, 200);
    assert.equal(yield* Effect.promise(() => response.text()), "first\nsecond\n");
    yield* waitUntil(() => finalized === 1, "protocol body scope cleanup");
    record("protocol response body completion closes its request scope", { finalized });

    const emptyResponse = yield* Effect.promise(() =>
      alphaNative.fetch("sewedresource://unit/empty"),
    );
    assert.equal(emptyResponse.status, 204);
    assert.equal(yield* Effect.promise(() => emptyResponse.text()), "");
    yield* waitUntil(() => finalized === 2, "protocol no-body scope cleanup");
    record("protocol no-body responses settle before request scope cleanup", {
      status: emptyResponse.status,
      finalized,
    });

    const betaExit = yield* Effect.promise(() =>
      betaNative.fetch("sewedresource://unit/stream").then(
        () => ({ _tag: "Success" }),
        (error) => ({ _tag: "Failure", error: String(error) }),
      ),
    );
    assert.equal(betaExit._tag, "Failure");
    record("protocol handlers are isolated by native session identity", {
      alphaStatus: response.status,
      beta: betaExit,
    });

    // Protocol.handleWeb: the same registration, over a plain (request) => Response | Promise<Response>
    // handler, with no HttpServerRequest/HttpServerResponse wrapping.
    const webSession = yield* Session.fromPartition({ kind: "memory", name: "resource-web" });
    const webNative = nativeSession.fromPartition(partitionKey("resource-web"));
    const webScope = yield* Scope.fork(yield* Effect.scope);
    let holdStarted = false;
    let webAborted = false;
    yield* Protocol.handleWeb(webSession, protocolScheme, (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/echo") {
        return request
          .text()
          .then((body) => new globalThis.Response(`web:${request.method}:${body}`, { status: 200 }));
      }
      if (path === "/boom") throw new Error("web handler boom");
      if (path === "/proxy") {
        // Z1: request.signal used to abort the instant this Response was answered — the very
        // next line below, before the page ever pulled a byte — cancelling a real proxy's own
        // chained upstream fetch mid-body every time. A hand-rolled multi-chunk body plays the
        // same role a proxied upstream's own body would (six 64 KiB chunks, paced 15ms apart,
        // well over 256 KiB, checking request.signal.aborted on every pull the way the guide's
        // own fetch(upstream, { signal: request.signal }) would react to it): the Response is
        // answered here, synchronously, long before the loop below has produced anything, so a
        // premature abort truncates the body the page goes on to read.
        let index = 0;
        const stream = new globalThis.ReadableStream({
          async pull(controller) {
            if (request.signal.aborted) {
              controller.error(new Error("proxy body aborted before every chunk left"));
              return;
            }
            if (index >= proxyChunks) {
              controller.close();
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 15));
            controller.enqueue(proxyChunk);
            index += 1;
          },
        });
        return new globalThis.Response(stream);
      }
      if (path === "/fetch-proxy") {
        // F3: the consumer's own exact shape — chaining a real `fetch` straight onto
        // `request.signal` — proxying the local HTTP server's `/big` above rather than a
        // hand-rolled stream. `close()`'s `controller.abort()` (Protocol.ts) reaches this fetch's
        // own signal, so a page cancelling the body errors this fetch's read; F1's fix is what
        // keeps that rejection from leaking as unhandled.
        return fetch(`${origin}/big`, { signal: request.signal });
      }
      if (path === "/hold") {
        holdStarted = true;
        // Held open until something aborts it: only the registration's own teardown can do that
        // here, proving `request.signal` reaches a plain handler the way the ruling asks for.
        return new Promise((resolve) => {
          request.signal.addEventListener("abort", () => {
            webAborted = true;
            resolve(new globalThis.Response("aborted", { status: 499 }));
          });
        });
      }
      return new globalThis.Response(`web:${path}`, { status: 200 });
    }).pipe(Scope.provide(webScope));

    const webGet = yield* Effect.promise(() => webNative.fetch("sewedresource://unit/hello"));
    assert.equal(webGet.status, 200);
    assert.equal(yield* Effect.promise(() => webGet.text()), "web:/hello");

    const webPost = yield* Effect.promise(() =>
      webNative.fetch("sewedresource://unit/echo", { method: "POST", body: "payload" }),
    );
    assert.equal(webPost.status, 200);
    assert.equal(yield* Effect.promise(() => webPost.text()), "web:POST:payload");

    const webThrow = yield* Effect.promise(() => webNative.fetch("sewedresource://unit/boom"));
    assert.equal(webThrow.status, 500);
    assert.equal(yield* Effect.promise(() => webThrow.text()), "Internal Server Error");

    // Z1: request.signal used to abort the instant the handler's promise resolved, before the
    // page ever read a byte of the Response it was handed. Reading the whole body here, and
    // checking its byte count and checksum, is what catches that: a premature abort truncates it
    // or rejects outright.
    const proxyResponse = yield* Effect.promise(() => webNative.fetch("sewedresource://unit/proxy"));
    assert.equal(proxyResponse.status, 200);
    const proxyBytes = yield* Effect.promise(() => proxyResponse.arrayBuffer());
    const proxyBuffer = Buffer.from(proxyBytes);
    assert.equal(proxyBuffer.byteLength, proxyBody.byteLength);
    assert.equal(createHash("sha256").update(proxyBuffer).digest("hex"), proxyHash);
    record(
      "Protocol.handleWeb keeps a handler's response body alive until the page reads it all, whatever the handler's own promise already resolved to",
      { byteLength: proxyBuffer.byteLength, hash: proxyHash },
    );

    // F3: the consumer's exact shape — fetch(upstream, { signal: request.signal }) — read to
    // completion through handleWeb against a real local HTTP server, not the hand-rolled stream
    // `/proxy` above answers with.
    const fetchProxyResponse = yield* Effect.promise(() =>
      webNative.fetch("sewedresource://unit/fetch-proxy"),
    );
    assert.equal(fetchProxyResponse.status, 200);
    const fetchProxyBytes = yield* Effect.promise(() => fetchProxyResponse.arrayBuffer());
    const fetchProxyBuffer = Buffer.from(fetchProxyBytes);
    assert.equal(fetchProxyBuffer.byteLength, bigBody.byteLength);
    assert.equal(createHash("sha256").update(fetchProxyBuffer).digest("hex"), bigHash);
    record(
      "Protocol.handleWeb serves a handler chaining fetch(upstream, { signal: request.signal }) onto a real local server, read to completion",
      { byteLength: fetchProxyBuffer.byteLength, hash: bigHash },
    );

    // F1: a page cancelling that same fetch-proxied body, mid-stream, must not leave an
    // unhandled rejection in main — close()'s controller.abort() runs before reader.cancel(),
    // and the upstream fetch's own body read rejects on that abort.
    const abortedFetchProxy = yield* Effect.promise(() =>
      webNative.fetch("sewedresource://unit/fetch-proxy"),
    );
    const abortedReader = abortedFetchProxy.body.getReader();
    yield* Effect.promise(() => abortedReader.read());
    const unhandledBefore = unhandledRejections;
    yield* Effect.promise(() => abortedReader.cancel("page navigated away"));
    // Bounded, not a fixed sleep tied to server timing: gives the upstream fetch's own abort
    // rejection every chance to surface as an unhandled rejection before asserting that none did.
    for (let attempt = 0; attempt < 30 && unhandledRejections === unhandledBefore; attempt++) {
      yield* Effect.sleep(10);
    }
    assert.equal(
      unhandledRejections,
      unhandledBefore,
      "the page cancelling a fetch-proxied body must not leak an unhandled rejection in main",
    );
    record("a page cancelling a fetch-proxied body leaves no unhandled rejection in main", {
      unhandledRejections: unhandledRejections - unhandledBefore,
    });

    const holdPromise = webNative.fetch("sewedresource://unit/hold");
    yield* waitUntil(() => holdStarted, "hold request reached the web handler");
    yield* Scope.close(webScope, Exit.void);
    const held = yield* Effect.promise(() => holdPromise);
    assert.equal(held.status, 499);
    assert.ok(webAborted, "the handler's own request.signal aborted when the registration closed");
    record(
      "Protocol.handleWeb serves the web's own Request/Response shape: a GET, an echoed POST body, a thrown handler's 500, and an abort when its registration's scope closes",
      {
        webGetStatus: webGet.status,
        webPostStatus: webPost.status,
        webThrowStatus: webThrow.status,
        heldStatus: held.status,
        webAborted,
      },
    );

    // "sewedresource" was registered with `standard: true` through Protocol.declare, so origin and
    // document rules over it resolve to a canonical, non-opaque origin instead of failing as
    // Node otherwise reports custom-scheme origins as opaque ("null"). A dedicated session and
    // handler keep this page's requests out of alpha's `finalized` bookkeeping above.
    const permissionUrl = new URL("sewedresource://unit/permission");
    const permissionSession = yield* Session.fromPartition({
      kind: "memory",
      name: "resource-permission",
    });
    const schemeScope = yield* Scope.fork(yield* Effect.scope);
    yield* Protocol.handle(permissionSession, protocolScheme, () =>
      Effect.succeed(
        HttpServerResponse.html(
          "<!doctype html><title>pending</title><script>" +
            "Notification.requestPermission().then((result) => { document.title = result; });" +
            "</script>",
        ),
      ),
    ).pipe(Scope.provide(schemeScope));
    // setPermissions is gone: a document-scoped grant now installs as a decider on
    // Decidables.Session.Permission, through Permission.Policy's own document rule, scoped to this
    // same fixture's schemeScope.
    yield* permissionSession
      .decide(
        Decidables.Session.Permission,
        Decision.policy(Permission.Policy, [
          { kind: "document", url: permissionUrl.href, permissions: ["notifications"] },
        ]),
      )
      .pipe(Scope.provide(schemeScope));
    const beforeSchemeWindow = new Set(NativeBrowserWindow.getAllWindows());
    const schemeWindow = yield* BrowserWindow.make({
      session: permissionSession,
      show: false,
      width: 320,
      height: 240,
    }).pipe(Scope.provide(schemeScope));
    // The page's own <title> becomes the OS window title once it loads, so the native window is
    // captured by identity here rather than by title.
    const schemeNativeWindow = NativeBrowserWindow.getAllWindows().find(
      (candidate) => !beforeSchemeWindow.has(candidate),
    );
    assert.ok(schemeNativeWindow, "native scheme window exists");
    // Sewed now gates every page-set title behind Decidables.WebContents.TitleUpdate, whose fallback
    // ("keep") is fail-closed the same way navigation and popups are: a page cannot silently rename
    // the window unless something accepts it. This fixture's own signal depends on the title change
    // going through, so it opts in explicitly.
    yield* schemeWindow.webContents.decide(
      Decidables.WebContents.TitleUpdate,
      Decision.sync(() => "accept"),
    );
    // setNavigationPolicy is gone: an origin allowance for a registered custom scheme now installs
    // as a decider on Decidables.WebContents.Navigation, through Navigation.Policy itself — Sewed's
    // own compile, which correctly resolves a registered scheme's non-opaque origin, the same one
    // Task 6b restored after the plan's own three-argument policy briefly required a hand-written one.
    yield* schemeWindow.webContents.decide(
      Decidables.WebContents.Navigation,
      Decision.policy(Navigation.Policy, [{ kind: "origin", origin: "sewedresource://unit" }]),
    );
    yield* schemeWindow.webContents.load(Renderer.entry(permissionUrl, { bindings: [] }), {
      bindings: [],
    });
    let permissionResult;
    for (let attempt = 0; attempt < 40 && permissionResult === undefined; attempt += 1) {
      const title = schemeNativeWindow.getTitle();
      if (title === "granted" || title === "denied") permissionResult = title;
      else yield* Effect.sleep(50);
    }
    assert.equal(permissionResult, "granted");
    yield* Scope.close(schemeScope, Exit.void);
    record(
      "a registered standard scheme's origin and document rules accept permissions and navigation, and a permission request from its page is granted",
      {
        scheme: "sewedresource",
        origin: "sewedresource://unit",
        document: permissionUrl.href,
        permissionResult,
      },
    );

    const requestAbort = new AbortController();
    const infiniteResponse = yield* Effect.promise(() =>
      alphaNative.fetch("sewedresource://unit/infinite", { signal: requestAbort.signal }),
    );
    const infiniteReader = infiniteResponse.body?.getReader();
    assert.ok(infiniteReader);
    yield* Effect.promise(() => infiniteReader.read());
    yield* Effect.sync(() => requestAbort.abort());
    yield* Effect.promise(() => infiniteReader.cancel("fixture cancellation").catch(() => {}));
    yield* waitUntil(() => finalized === 3, "protocol body cancellation cleanup");
    record("protocol body cancellation closes its request scope", { finalized });

    const waitingPromise = alphaNative.fetch("sewedresource://unit/waiting").then(
      (value) => ({ _tag: "Response", status: value.status }),
      (error) => ({ _tag: "Failure", error: String(error) }),
    );
    yield* Effect.sleep(30);
    yield* waitUntil(() => waitingStarted === 1, "waiting protocol handler admission");
    const beforeHeadersAbort = new AbortController();
    const abortedWaiting = alphaNative
      .fetch("sewedresource://unit/waiting?abort", {
        signal: beforeHeadersAbort.signal,
      })
      .then(
        (value) => ({ _tag: "Response", status: value.status }),
        (error) => ({ _tag: "Failure", error: String(error) }),
      );
    yield* waitUntil(() => waitingStarted === 2, "abortable waiting handler admission");
    yield* Effect.sync(() => beforeHeadersAbort.abort());
    assert.equal((yield* Effect.promise(() => abortedWaiting))._tag, "Failure");
    yield* Effect.sleep(50);
    const finalizedAfterClientAbort = finalized;
    yield* Scope.close(protocolScope, Exit.void);
    const waitingResult = yield* Effect.promise(() => waitingPromise);
    assert.equal(waitingResult._tag, "Response");
    assert.equal(waitingResult.status, 500);
    yield* waitUntil(() => finalized === 5, "registration close request cleanup");
    record("protocol registration close interrupts a waiting handler", {
      waitingResult,
      finalized,
    });
    record("registration scope releases requests aborted before response headers", {
      clientAbortFinalizedHandler: finalizedAfterClientAbort > 3,
      finalizedAfterClientAbort,
      finalizedAfterScopeClose: finalized,
    });

    const afterProtocol = yield* Effect.promise(() =>
      alphaNative.fetch("sewedresource://unit/stream").then(
        () => ({ _tag: "Success" }),
        (error) => ({ _tag: "Failure", error: String(error) }),
      ),
    );
    assert.equal(afterProtocol._tag, "Failure");
    record("protocol scope cleanup removes the handler", {
      afterProtocol,
    });

    const completeScope = yield* Scope.fork(yield* Effect.scope);
    const completeA = yield* Download.start(alpha, {
      url: `${origin}/download/complete`,
      savePath: join(artifactRoot, "complete-a.bin"),
    }).pipe(Scope.provide(completeScope));
    const completeB = yield* Download.start(alpha, {
      url: `${origin}/download/complete`,
      savePath: join(artifactRoot, "complete-b.bin"),
    }).pipe(Scope.provide(completeScope));
    const outcomes = yield* Effect.all([completeA.awaitDone, completeB.awaitDone], {
      concurrency: "unbounded",
    });
    assert.deepEqual(outcomes, [{ kind: "completed" }, { kind: "completed" }]);
    const [bytesA, bytesB] = yield* Effect.promise(() =>
      Promise.all([
        readFile(join(artifactRoot, "complete-a.bin")),
        readFile(join(artifactRoot, "complete-b.bin")),
      ]),
    );
    assert.equal(createHash("sha256").update(bytesA).digest("hex"), fixedHash);
    assert.equal(createHash("sha256").update(bytesB).digest("hex"), fixedHash);
    const lateStates = Array.from(yield* completeA.progress.pipe(Stream.runCollect));
    assert.equal(lateStates.length, 1);
    assert.equal(lateStates[0]?.status, "terminal");
    const terminalPause = yield* Effect.exit(completeA.pause);
    const terminalResume = yield* Effect.exit(completeA.resume);
    assert.equal(failure(terminalPause)?.code, "Closed");
    assert.equal(failure(terminalResume)?.code, "Closed");
    record("same-URL simultaneous downloads stay independent and hash correctly", {
      outcomes,
      hashes: [
        createHash("sha256").update(bytesA).digest("hex"),
        createHash("sha256").update(bytesB).digest("hex"),
      ],
      lateProgress: lateStates,
      terminalControlErrors: [failure(terminalPause)?.code, failure(terminalResume)?.code],
    });
    yield* Scope.close(completeScope, Exit.void);

    const pauseScope = yield* Scope.fork(yield* Effect.scope);
    const pausable = yield* Download.start(beta, {
      url: `${origin}/download/large`,
      savePath: join(artifactRoot, "pause-resume.bin"),
    }).pipe(Scope.provide(pauseScope));
    const activeStates = yield* pausable.progress.pipe(Stream.take(2), Stream.runCollect);
    assert.equal(activeStates.at(-1)?.status, "active");
    yield* pausable.pause;
    yield* Effect.gen(function* () {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const state = yield* pausable.snapshot;
        if (state.status === "active" && state.paused) return;
        yield* Effect.sleep(10);
      }
      throw new Error("Timed out: native download pause");
    });
    yield* pausable.resume;
    const resumed = yield* pausable.snapshot;
    assert.equal(resumed.status, "active");
    assert.equal(resumed.paused, false);
    assert.deepEqual(yield* pausable.awaitDone, { kind: "completed" });
    const largeBytes = yield* Effect.promise(() =>
      readFile(join(artifactRoot, "pause-resume.bin")),
    );
    assert.equal(largeBytes.byteLength, largeBody.byteLength);
    assert.equal(createHash("sha256").update(largeBytes).digest("hex"), largeHash);
    record("download pause and resume reflect native state", {
      before: activeStates.at(-1),
      afterResume: resumed,
      byteLength: largeBytes.byteLength,
      hash: largeHash,
    });
    yield* Scope.close(pauseScope, Exit.void);

    const cancelScope = yield* Scope.fork(yield* Effect.scope);
    const cancellable = yield* Download.start(alpha, {
      url: `${origin}/download/cancel`,
      savePath: join(artifactRoot, "cancel.bin"),
    }).pipe(Scope.provide(cancelScope));
    yield* cancellable.progress.pipe(Stream.take(2), Stream.runDrain);
    yield* cancellable.cancel;
    assert.deepEqual(yield* cancellable.awaitDone, { kind: "cancelled" });
    record("explicit cancellation resolves the native terminal outcome", {
      outcome: yield* cancellable.awaitDone,
    });
    yield* Scope.close(cancelScope, Exit.void);

    const staleScope = yield* Scope.fork(yield* Effect.scope);
    const stale = yield* Download.start(alpha, {
      url: `${origin}/download/cancel`,
      savePath: join(artifactRoot, "scope-close.bin"),
    }).pipe(Scope.provide(staleScope));
    yield* stale.progress.pipe(Stream.take(2), Stream.runDrain);
    yield* Scope.close(staleScope, Exit.void);
    const staleDone = yield* Effect.exit(stale.awaitDone);
    const staleSnapshot = yield* Effect.exit(stale.snapshot);
    const staleProgress = yield* Effect.exit(Stream.runCollect(stale.progress));
    assert.equal(failure(staleDone)?.code, "Closed");
    assert.equal(failure(staleSnapshot)?.code, "Closed");
    assert.equal(failure(staleProgress)?.code, "Closed");
    record("scope close cancels ownership and makes stale operations Closed", {
      awaitDone: failure(staleDone)?.code,
      snapshot: failure(staleSnapshot)?.code,
      progress: failure(staleProgress)?.code,
    });

    yield* waitUntil(
      () =>
        alphaNative.listenerCount("will-download") === 0 &&
        betaNative.listenerCount("will-download") === 0,
      "download listener cleanup",
    );
    const finalListeners = {
      alpha: alphaNative.listenerCount("will-download"),
      beta: betaNative.listenerCount("will-download"),
    };
    assert.equal(finalListeners.alpha, 0);
    assert.equal(finalListeners.beta, 0);
    assert.equal(NativeBrowserWindow.getAllWindows().length, 0);
    record("private download contents leave no windows or will-download listeners", {
      finalListeners,
      windows: NativeBrowserWindow.getAllWindows().length,
    });
  });

const originalExit = app.exit;
const originalQuit = app.quit;
let duplicateExit;
app.exit = (code = 0) => {
  duplicateExit = code;
};
app.quit = () => {};

// Validation rejects duplicates before registration marks the process as used.
// The valid App.run follows synchronously, before Electron can emit ready.
App.run([Protocol.declare(protocolScheme, protocolScheme)], Effect.void);
App.run(
  [Protocol.declare(protocolScheme)],
  Effect.gen(function* () {
    yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
    const artifactRoot = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "sewed-session-resources-")),
    );
    const server = makeHttpServer();
    const port = yield* Effect.promise(() => listen(server));
    const result = yield* Effect.exit(
      Effect.gen(function* () {
        yield* Effect.sleep(10);
        assert.equal(duplicateExit, 1);
        record("duplicate privileged scheme registration fails before native setup", {
          exitCode: duplicateExit,
        });
        yield* runChecks({ origin: `http://127.0.0.1:${port}`, artifactRoot });
      }),
    );
    const report = {
      success: result._tag === "Success",
      checks,
      errors: result._tag === "Failure" ? [Cause.pretty(result.cause)] : [],
      platform: { os: process.platform, electron: process.versions.electron },
    };
    console.log(`${marker} ${JSON.stringify(report)}`);
    yield* Effect.promise(() => closeServer(server));
    yield* Effect.promise(() => rm(artifactRoot, { recursive: true, force: true }));
    yield* Effect.sync(() => {
      app.exit = originalExit;
      app.quit = originalQuit;
      originalQuit.call(app);
    });
    if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
  }),
);
