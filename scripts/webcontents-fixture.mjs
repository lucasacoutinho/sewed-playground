import assert from "node:assert/strict";
import { createServer } from "node:http";

import { app, BrowserWindow as NativeBrowserWindow } from "electron";
import { App, BrowserWindow, host } from "sewed/main";
import { Binding, Decidables, Decision, Navigation, Renderer } from "sewed";
import { Cause, Effect, Exit, Fiber, Schema, Scope, Stream } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

const checks = [];
const historyReports = [];
const HistoryProbe = RpcGroup.make(Rpc.make("probe", { success: Schema.String }));
const HistorySlot = Binding.slot("history-probe", HistoryProbe);
const historyScript = `
(async () => {
  const report = (entry) =>
    fetch("/history/report", { method: "POST", body: JSON.stringify(entry), keepalive: true });
  const bridge = window.sewed;
  const attempt = async (label, run) => {
    try {
      const ok = await run();
      await report({ label, ok });
      return ok;
    } catch (error) {
      await report({ label, ok: false, error: String(error && error.message) });
      return false;
    }
  };
  const hello = async () => {
    const reply = await bridge.hello();
    return typeof reply.session === "string" ? reply.session : undefined;
  };
  const open = async (session) => {
    const id = crypto.randomUUID();
    return (await bridge.open(session, "sewed/binding/history-probe", id)) === id;
  };
  if (location.pathname === "/history/routed") {
    await attempt("hello-after-reload", async () => (await hello()) !== undefined);
    await report({ label: "done" });
    return;
  }
  let session;
  await attempt("hello", async () => {
    session = await hello();
    return session !== undefined;
  });
  await attempt("open-before-push-state", () => open(session));
  history.pushState({}, "", "/history/routed" + location.search);
  await attempt("open-after-push-state", () => open(session));
  let renewed;
  await attempt("hello-after-push-state", async () => {
    renewed = await hello();
    return renewed !== undefined;
  });
  await attempt("open-after-second-hello", () => open(renewed));
  location.reload();
})();
`;
const sockets = new Set();
const server = createServer((request, response) => {
  void handleRequest(request, response);
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});

let origin;

const page = (title, body = "", script = "") => `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body>
</html>`;

const sendPage = (response, body, status = 200) => {
  if (response.destroyed) return;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  response.end(body);
};

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url ?? "/", origin ?? "http://127.0.0.1/");
  const path = requestUrl.pathname;

  if (path === "/main-failure" || path === "/missing-subframe") {
    request.socket.destroy();
    return;
  }
  if (path === "/redirect") {
    response.writeHead(302, { location: "/redirected" });
    response.end();
    return;
  }
  if (request.method === "POST" && path === "/history/report") {
    let body = "";
    for await (const chunk of request) body += chunk;
    historyReports.push(JSON.parse(body));
    response.writeHead(204);
    response.end();
    return;
  }
  if (path === "/history" || path === "/history/routed") {
    sendPage(response, page("history", "history api", historyScript));
    return;
  }

  const delayMilliseconds = Number(requestUrl.searchParams.get("delay") ?? 0);
  if (delayMilliseconds > 0) await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
  if (response.destroyed) return;

  if (path === "/hash") {
    sendPage(
      response,
      page("hash", "same document", `setTimeout(() => { location.hash = "same-document"; }, 700);`),
    );
    return;
  }
  if (path === "/subframe") {
    sendPage(response, page("subframe", `<iframe src="${origin}/missing-subframe"></iframe>`));
    return;
  }
  sendPage(response, page(path.slice(1) || "root", path.slice(1) || "root"));
}

const stateCopy = (state) => ({ ...state });
const stateFacts = (states) => states.map(stateCopy);
const causeText = (cause) => {
  try {
    return Cause.pretty(cause);
  } catch {
    return String(cause);
  }
};

const record = (name, evidence) => {
  checks.push({ name, evidence });
  console.log(`PASS ${name}`);
};

const waitUntil = (read, description, timeout = 6_000) =>
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
      yield* Effect.sleep(25);
    }
    throw new Error(
      `Timed out: ${description}${lastError ? ` (${lastError.message || lastError})` : ""}`,
    );
  });

const waitForState = (observer, offset, predicate, description, timeout = 8_000) =>
  waitUntil(() => observer.values.slice(offset).find(predicate), description, timeout);

const observe = (window, onExit) =>
  Effect.gen(function* () {
    const observer = { values: [], exit: undefined };
    const stream = window.webContents.state.pipe(
      Stream.runForEach((state) =>
        Effect.sync(() => {
          observer.values.push(stateCopy(state));
        }),
      ),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          observer.exit = exit;
          onExit?.(exit);
        }),
      ),
    );
    observer.fiber = yield* Effect.forkScoped(stream);
    return observer;
  });

const awaitFiber = (fiber, description, timeout = 8_000) =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(Effect.timeout(timeout)(Fiber.await(fiber)));
    if (result._tag === "Success") return result.value;
    yield* Fiber.interrupt(fiber);
    throw new Error(`Timed out: ${description}: ${causeText(result.cause)}`);
  });

const nativeWindow = () => {
  const windows = NativeBrowserWindow.getAllWindows();
  assert.equal(windows.length, 1, `Expected one native test window, found ${windows.length}`);
  return windows[0];
};

const loadEffect = (window, url) =>
  window.webContents.load(Renderer.entry(url, { bindings: [] }), { bindings: [] });

const startLoad = (window, url) => Effect.forkChild(loadEffect(window, url));

const exitFacts = (exit) => ({
  tag: exit._tag,
  error: exit._tag === "Failure" ? causeText(exit.cause) : undefined,
});

const runChecks = Effect.gen(function* () {
  const window = yield* BrowserWindow.make({
    show: false,
    title: "Sewed web contents verification",
  });
  const native = nativeWindow();
  const observer = yield* observe(window);
  yield* waitUntil(() => observer.values[0], "initial state replay");
  assert.deepEqual(observer.values[0], { status: "idle" });
  record("initial idle state replays to a first observer", {
    firstState: observer.values[0],
    nativeWindowCount: NativeBrowserWindow.getAllWindows().length,
  });

  const delayedUrl = new URL(`/delayed?delay=350&case=initial`, origin);
  const delayedOffset = observer.values.length;
  const delayedFiber = yield* startLoad(window, delayedUrl);
  yield* waitForState(
    observer,
    delayedOffset,
    (state) => state.status === "loading" && state.url === delayedUrl.href,
    "delayed navigation loading state",
  );
  const delayedReady = yield* waitForState(
    observer,
    delayedOffset,
    (state) => state.status === "ready" && state.url === delayedUrl.href,
    "delayed navigation ready state",
  );
  const delayedExit = yield* awaitFiber(delayedFiber, "delayed load effect");
  assert.equal(delayedExit._tag, "Success", exitFacts(delayedExit));
  assert.ok(delayedReady.processId > 0);
  assert.equal(native.webContents.getOSProcessId(), delayedReady.processId);
  record("delayed full navigation reports loading then ready with a native renderer PID", {
    states: stateFacts(observer.values.slice(delayedOffset)),
    processId: delayedReady.processId,
    nativeProcessId: native.webContents.getOSProcessId(),
  });

  const lateObserver = yield* observe(window);
  yield* waitUntil(() => lateObserver.values[0], "late ready replay");
  assert.deepEqual(lateObserver.values[0], delayedReady);
  record("late observer replays the current ready snapshot", {
    replay: lateObserver.values[0],
  });

  const redirectOffset = observer.values.length;
  // setNavigationPolicy is gone: an exact-document allowance now installs as a decider on
  // Decidables.WebContents.Navigation, through Navigation.Policy's own document rule, so the server
  // redirect's final document is allowed through.
  const redirectTarget = new URL("/redirected", origin).href;
  yield* window.webContents.decide(
    Decidables.WebContents.Navigation,
    Decision.policy(Navigation.Policy, [{ kind: "document", url: redirectTarget }]),
  );
  yield* loadEffect(window, new URL("/redirect", origin));
  const redirected = yield* waitForState(
    observer,
    redirectOffset,
    (state) => state.status === "ready" && state.url === `${origin}/redirected`,
    "redirected document ready state",
  );
  assert.equal(redirected.processId, native.webContents.getOSProcessId());
  assert.ok(
    observer.values
      .slice(redirectOffset)
      .some((state) => state.status === "loading" && state.url === `${origin}/redirected`),
  );
  record("server redirects report the final document URL", {
    states: stateFacts(observer.values.slice(redirectOffset)),
  });

  const hashUrl = new URL("/hash?case=same-document", origin);
  const hashLoadOffset = observer.values.length;
  const hashFiber = yield* startLoad(window, hashUrl);
  yield* waitForState(
    observer,
    hashLoadOffset,
    (state) => state.status === "loading" && state.url === hashUrl.href,
    "hash page loading state",
  );
  const hashReady = yield* waitForState(
    observer,
    hashLoadOffset,
    (state) => state.status === "ready" && state.url === hashUrl.href,
    "hash page ready state",
  );
  const hashExit = yield* awaitFiber(hashFiber, "hash page load effect");
  assert.equal(hashExit._tag, "Success", exitFacts(hashExit));
  const sameDocumentOffset = observer.values.length;
  const sameDocumentReady = yield* waitForState(
    observer,
    sameDocumentOffset,
    (state) => state.status === "ready" && state.url.endsWith("#same-document"),
    "same-document hash ready update",
    4_000,
  );
  const sameDocumentStates = observer.values.slice(sameDocumentOffset);
  assert.ok(sameDocumentStates.length > 0);
  assert.ok(sameDocumentStates.every((state) => state.status === "ready"));
  assert.equal(sameDocumentReady.processId, hashReady.processId);
  assert.equal(native.webContents.getOSProcessId(), hashReady.processId);
  record("same-document hash navigation updates ready URL without loading or changing PID", {
    states: stateFacts(sameDocumentStates),
    processId: sameDocumentReady.processId,
  });

  const probe = yield* host(
    HistoryProbe,
    HistoryProbe.toLayer({ probe: () => Effect.succeed("ok") }),
  );
  const historyUrl = new URL("/history?case=history-api", origin);
  const routedUrl = new URL("/history/routed?case=history-api", origin);
  const historyOffset = observer.values.length;
  historyReports.length = 0;
  yield* window.webContents.load(Renderer.entry(historyUrl, { bindings: [HistorySlot] }), {
    bindings: [Binding.to(HistorySlot, probe)],
  });
  const routedReady = yield* waitForState(
    observer,
    historyOffset,
    (state) => state.status === "ready" && state.url === routedUrl.href,
    "History API route change updates the ready URL",
  );
  yield* waitUntil(
    () => historyReports.some((entry) => entry.label === "done" || entry.ok === false),
    "History API probe reports completion or a failed step",
    10_000,
  );
  const historyOutcomes = Object.fromEntries(
    historyReports.filter((entry) => entry.label !== "done").map((entry) => [entry.label, entry]),
  );
  for (const label of [
    "hello",
    "open-before-push-state",
    "open-after-push-state",
    "hello-after-push-state",
    "open-after-second-hello",
    "hello-after-reload",
  ]) {
    const outcome = historyOutcomes[label];
    assert.equal(outcome?.ok, true, `${label}: ${outcome?.error ?? "not reported"}`);
  }
  const routedReloadOffset = observer.values.indexOf(routedReady) + 1;
  const reloadedRoutedReady = yield* waitForState(
    observer,
    routedReloadOffset,
    (state) => state.status === "ready" && state.url === routedUrl.href,
    "reload at the routed URL becomes ready",
  );
  assert.ok(
    observer.values
      .slice(routedReloadOffset)
      .some((state) => state.status === "loading" && state.url === routedUrl.href),
  );
  assert.equal(reloadedRoutedReady.processId, native.webContents.getOSProcessId());
  record("History API navigation keeps the bridge session and allows re-handshake and reload", {
    states: stateFacts(observer.values.slice(historyOffset)),
    reports: historyReports.slice(),
    processId: reloadedRoutedReady.processId,
  });

  const subframeFailures = [];
  const onSubframeFailure = (_event, code, description, url, mainFrame) => {
    if (!mainFrame) subframeFailures.push({ code, description, url });
  };
  native.webContents.on("did-fail-load", onSubframeFailure);
  const subframeUrl = new URL("/subframe?case=subframe", origin);
  const subframeOffset = observer.values.length;
  const subframeFiber = yield* startLoad(window, subframeUrl);
  yield* waitForState(
    observer,
    subframeOffset,
    (state) => state.status === "ready" && state.url === subframeUrl.href,
    "subframe page ready state",
  );
  const subframeExit = yield* awaitFiber(subframeFiber, "subframe page load effect");
  assert.equal(subframeExit._tag, "Success", exitFacts(subframeExit));
  yield* waitUntil(() => subframeFailures.length > 0, "actual native subframe failure");
  native.webContents.off("did-fail-load", onSubframeFailure);
  const subframeStates = observer.values.slice(subframeOffset);
  assert.ok(!subframeStates.some((state) => state.status === "failed"));
  record("subframe failure leaves the main document ready", {
    states: stateFacts(subframeStates),
    nativeUrl: native.webContents.getURL(),
    failures: subframeFailures,
  });

  const stopEvents = [];
  const stopFailure = (_event, code, description, url, mainFrame) => {
    if (mainFrame) stopEvents.push({ code, description, url });
  };
  native.webContents.on("did-fail-provisional-load", stopFailure);
  const stopUrl = new URL("/stop?delay=1200&case=stop", origin);
  const stopOffset = observer.values.length;
  const stopFiber = yield* startLoad(window, stopUrl);
  yield* waitForState(
    observer,
    stopOffset,
    (state) => state.status === "loading" && state.url === stopUrl.href,
    "stopped navigation loading state",
  );
  assert.equal(native.webContents.isLoadingMainFrame(), true);
  yield* Effect.sync(() => native.webContents.stop());
  const stopExit = yield* awaitFiber(stopFiber, "stopped navigation effect");
  assert.equal(stopExit._tag, "Failure", "cancelled load unexpectedly succeeded");
  const stoppedState = yield* waitForState(
    observer,
    stopOffset,
    (state) => state.status === "failed" && state.url === stopUrl.href,
    "cancelled navigation settles instead of remaining loading",
  );
  native.webContents.off("did-fail-provisional-load", stopFailure);
  assert.ok([-2, -3].includes(stoppedState.code));
  assert.equal(native.webContents.isLoadingMainFrame(), false);
  const stopStates = observer.values.slice(stopOffset);
  record("native stop rejects the pending load and settles its cancelled state", {
    states: stateFacts(stopStates),
    loadExit: exitFacts(stopExit),
    provisionalFailures: stopEvents,
  });

  const failureUrl = new URL("/main-failure?case=main", origin);
  const failureOffset = observer.values.length;
  const failureFiber = yield* startLoad(window, failureUrl);
  yield* waitForState(
    observer,
    failureOffset,
    (state) => state.status === "loading" && state.url === failureUrl.href,
    "main failure loading state",
  );
  const failureExit = yield* awaitFiber(failureFiber, "main load failure effect");
  assert.equal(failureExit._tag, "Failure", "main load unexpectedly succeeded");
  const failedState = yield* waitForState(
    observer,
    failureOffset,
    (state) => state.status === "failed" && state.url === failureUrl.href,
    "main failure state",
  );
  assert.notEqual(failedState.code, 0);
  assert.ok(failedState.description.length > 0);
  record("main-frame load failure rejects load and publishes native failure details", {
    state: failedState,
    loadExit: exitFacts(failureExit),
  });

  const recoveryUrl = new URL("/recovery?case=after-failure", origin);
  const recoveryOffset = observer.values.length;
  const recoveryFiber = yield* startLoad(window, recoveryUrl);
  yield* waitForState(
    observer,
    recoveryOffset,
    (state) => state.status === "loading" && state.url === recoveryUrl.href,
    "recovery loading state",
  );
  const recoveryReady = yield* waitForState(
    observer,
    recoveryOffset,
    (state) => state.status === "ready" && state.url === recoveryUrl.href,
    "recovery ready state",
  );
  const recoveryExit = yield* awaitFiber(recoveryFiber, "recovery load effect");
  assert.equal(recoveryExit._tag, "Success", exitFacts(recoveryExit));
  record("explicit load recovers a failed main document", {
    states: stateFacts(observer.values.slice(recoveryOffset)),
    processId: recoveryReady.processId,
  });

  const slowReplacementUrl = new URL("/replacement-slow?delay=1000&case=slow", origin);
  const fastReplacementUrl = new URL("/replacement-fast?case=fast", origin);
  const replacementOffset = observer.values.length;
  const slowReplacementFiber = yield* startLoad(window, slowReplacementUrl);
  yield* waitForState(
    observer,
    replacementOffset,
    (state) => state.status === "loading" && state.url === slowReplacementUrl.href,
    "replacement source loading state",
  );
  assert.equal(native.webContents.isLoadingMainFrame(), true);
  const fastReplacementFiber = yield* startLoad(window, fastReplacementUrl);
  const fastReplacementReady = yield* waitForState(
    observer,
    replacementOffset,
    (state) => state.status === "ready" && state.url === fastReplacementUrl.href,
    "replacement target ready state",
  );
  const fastReplacementExit = yield* awaitFiber(fastReplacementFiber, "replacement target load");
  const slowReplacementExit = yield* awaitFiber(slowReplacementFiber, "replacement source load");
  const replacementStates = observer.values.slice(replacementOffset);
  assert.equal(fastReplacementExit._tag, "Success", exitFacts(fastReplacementExit));
  assert.equal(slowReplacementExit._tag, "Failure", "replaced load unexpectedly succeeded");
  assert.match(causeText(slowReplacementExit.cause), /ERR_ABORTED/);
  assert.ok(!replacementStates.some((state) => state.status === "failed"));
  assert.equal(replacementStates.at(-1)?.url, fastReplacementUrl.href);
  assert.equal(fastReplacementReady.processId, native.webContents.getOSProcessId());
  record("rapid replacement suppresses stale aborted navigation failure", {
    states: stateFacts(replacementStates),
    replacedLoadExit: exitFacts(slowReplacementExit),
    replacementLoadExit: exitFacts(fastReplacementExit),
  });

  const sameUrl = new URL("/same-url?delay=350", origin);
  const sameUrlOffset = observer.values.length;
  const replacedSame = yield* startLoad(window, sameUrl);
  yield* waitForState(
    observer,
    sameUrlOffset,
    (state) => state.status === "loading" && state.url === sameUrl.href,
    "first navigation to repeated URL is loading",
  );
  assert.equal(native.webContents.isLoadingMainFrame(), true);
  const replacementSame = yield* startLoad(window, sameUrl);
  const sameExit = yield* awaitFiber(replacementSame, "replacement at the same URL");
  const replacedSameExit = yield* awaitFiber(replacedSame, "replaced navigation at the same URL");
  assert.equal(sameExit._tag, "Success", exitFacts(sameExit));
  yield* waitForState(
    observer,
    sameUrlOffset,
    (state) => state.status === "ready" && state.url === sameUrl.href,
    "replacement at the same URL becomes ready",
  );
  assert.ok(observer.values.slice(sameUrlOffset).every((state) => state.status !== "failed"));
  record("repeated loads of the same URL converge on a ready document", {
    states: stateFacts(observer.values.slice(sameUrlOffset)),
    firstLoadExit: exitFacts(replacedSameExit),
    secondLoadExit: exitFacts(sameExit),
  });

  const currentUrl = native.webContents.getURL();
  const crashNativeDetails = { value: undefined };
  native.webContents.once("render-process-gone", (_event, details) => {
    crashNativeDetails.value = { reason: details.reason, exitCode: details.exitCode };
  });
  const crashedProcessId = native.webContents.getOSProcessId();
  assert.ok(crashedProcessId > 0, "renderer process must have a live OS PID");
  assert.notEqual(crashedProcessId, process.pid, "refusing to signal the main process");
  assert.equal(process.kill(crashedProcessId, 0), true, "renderer process must be live");
  const crashOffset = observer.values.length;
  yield* Effect.sync(() => process.kill(crashedProcessId, "SIGKILL"));
  const goneState = yield* waitForState(
    observer,
    crashOffset,
    (state) => state.status === "gone",
    "renderer process gone state",
  );
  yield* waitUntil(() => crashNativeDetails.value, "native render-process-gone observation");
  assert.deepEqual(
    { reason: goneState.reason, exitCode: goneState.exitCode },
    crashNativeDetails.value,
  );
  assert.equal(native.isDestroyed(), false);
  assert.equal(NativeBrowserWindow.getAllWindows().length, 1);
  record("killed renderer publishes actual reason and exit while native window remains", {
    state: goneState,
    nativeDetails: crashNativeDetails.value,
    crashedProcessId,
    nativeWindowDestroyed: native.isDestroyed(),
    nativeWindowCount: NativeBrowserWindow.getAllWindows().length,
  });

  const reloadOffset = observer.values.length;
  yield* window.webContents.reload;
  yield* waitForState(
    observer,
    reloadOffset,
    (state) => state.status === "loading",
    "reload loading state after renderer loss",
  );
  const reloadedReady = yield* waitForState(
    observer,
    reloadOffset,
    (state) => state.status === "ready" && state.url === currentUrl,
    "reload ready state after renderer loss",
  );
  assert.ok(reloadedReady.processId > 0);
  assert.notEqual(reloadedReady.processId, crashedProcessId);
  assert.equal(nativeWindow(), native);
  assert.equal(reloadedReady.processId, native.webContents.getOSProcessId());
  record("explicit reload recovers the killed renderer on the same native window", {
    states: stateFacts(observer.values.slice(reloadOffset)),
    previousProcessId: crashedProcessId,
    processId: reloadedReady.processId,
    nativeWindowDestroyed: native.isDestroyed(),
  });

  const cancellationObserver = yield* observe(window);
  yield* waitUntil(() => cancellationObserver.values[0], "observer cancellation replay");
  const cancellationValueCount = cancellationObserver.values.length;
  const listenerCountBeforeCancellation = native.webContents.listenerCount("did-finish-load");
  yield* Fiber.interrupt(cancellationObserver.fiber);
  const cancellationExit = yield* Fiber.await(cancellationObserver.fiber);
  assert.equal(cancellationExit._tag, "Failure");
  const cancellationReloadOffset = observer.values.length;
  yield* window.webContents.reload;
  yield* waitForState(
    observer,
    cancellationReloadOffset,
    (state) => state.status === "loading",
    "remaining observer loading after cancellation",
  );
  yield* waitForState(
    observer,
    cancellationReloadOffset,
    (state) => state.status === "ready",
    "remaining observer ready after cancellation",
  );
  assert.equal(cancellationObserver.values.length, cancellationValueCount);
  assert.equal(
    native.webContents.listenerCount("did-finish-load"),
    listenerCountBeforeCancellation,
  );
  record("observer cancellation releases one subscription while another remains active", {
    cancelledExit: exitFacts(cancellationExit),
    cancelledValues: stateFacts(cancellationObserver.values),
    remainingObserverStates: stateFacts(observer.values.slice(cancellationReloadOffset)),
    listenerCountBeforeCancellation,
    listenerCountAfterCancellation: native.webContents.listenerCount("did-finish-load"),
  });

  const closeObserver = yield* observe(window);
  yield* waitUntil(() => closeObserver.values[0], "native close observer replay");
  yield* Effect.sync(() => native.close());
  yield* waitUntil(() => NativeBrowserWindow.getAllWindows().length === 0, "native window close");
  yield* waitUntil(() => closeObserver.exit, "state stream completion after native close");
  yield* waitUntil(() => observer.exit, "primary state stream completion after native close");
  assert.equal(app.isReady(), true);
  assert.equal(closeObserver.exit._tag, "Success", causeText(closeObserver.exit));
  record("native close completes state observers while the outer app remains alive", {
    closeObserverExit: exitFacts(closeObserver.exit),
    primaryObserverExit: exitFacts(observer.exit),
    appReady: app.isReady(),
    nativeWindowCount: NativeBrowserWindow.getAllWindows().length,
  });

  const ownership = yield* Scope.fork(yield* Effect.scope);
  const scopedWindow = yield* BrowserWindow.make({ show: false }).pipe(Scope.provide(ownership));
  const scopedNative = nativeWindow();
  const scopedObserver = yield* observe(scopedWindow);
  yield* waitUntil(() => scopedObserver.values[0], "outer observer sees owned window");
  yield* Scope.close(ownership, Exit.void);
  const ownedExit = yield* awaitFiber(
    scopedObserver.fiber,
    "owner closure completes outer observer",
  );
  assert.equal(ownedExit._tag, "Success", exitFacts(ownedExit));
  assert.equal(scopedNative.isDestroyed(), true);
  assert.equal(NativeBrowserWindow.getAllWindows().length, 0);
  assert.equal(app.isReady(), true);
  record("owning scope closure completes an observer running in the outer app scope", {
    observerExit: exitFacts(ownedExit),
    nativeDestroyed: scopedNative.isDestroyed(),
    appReady: app.isReady(),
  });

  return { checks };
});

const closeServer = () =>
  new Promise((resolve, reject) => {
    for (const socket of sockets) socket.destroy();
    server.close((error) => (error ? reject(error) : resolve()));
  });

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      reject(new Error("Loopback fixture server did not expose a TCP address"));
      return;
    }
    origin = `http://127.0.0.1:${address.port}`;
    resolve();
  });
});

App.run(
  [],
  Effect.gen(function* () {
    yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
    const result = yield* Effect.exit(runChecks);
    const report =
      result._tag === "Success"
        ? { success: true, origin, checks: result.value.checks }
        : { success: false, origin, checks, error: causeText(result.cause) };
    console.log(`WEB_CONTENTS_VERIFICATION ${JSON.stringify(report)}`);
    const closeResult = yield* Effect.exit(Effect.tryPromise(() => closeServer()));
    if (closeResult._tag === "Failure") {
      yield* Effect.sync(() => {
        process.exitCode = 1;
        console.error(`Fixture server close failed: ${causeText(closeResult.cause)}`);
      });
    }
    if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
    yield* Effect.sync(() => app.quit());
  }),
);
