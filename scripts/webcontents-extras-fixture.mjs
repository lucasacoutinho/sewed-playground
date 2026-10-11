import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow as NativeBrowserWindow } from "electron";
import { Cause, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { Binding, Decidables, Decision, Navigation, Renderer } from "sewed";
import { App, BrowserWindow, Capability, WindowControls } from "sewed/main";

const Controls = WindowControls.capability.slot;
// `--sewed-expect-scale=<n>` lets a second run under a forced device scale factor tell this
// fixture what its own capture's `scaleFactor` (and doubled pixel dimensions) should read.
const expectedScale = Number(
  process.argv
    .find((arg) => arg.startsWith("--sewed-expect-scale="))
    ?.slice("--sewed-expect-scale=".length) ?? 1,
);
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
const pngIconBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const pages = {
  "/one": "<!doctype html><title>Sewed extras one</title><body><p>needle one</p></body>",
  "/two":
    "<!doctype html><title>Sewed extras two</title><body><p>needle two needle three</p></body>",
  "/console":
    '<!doctype html><title>Sewed console</title><body><script>console.warn("sewed console probe")</script></body>',
  "/leave":
    '<!doctype html><title>Sewed leave</title><body><script>window.open("https://popup.invalid/child"); setTimeout(() => { location.href = "https://away.invalid/next"; }, 100);</script></body>',
  "/favicon-page":
    '<!doctype html><title>Sewed favicon</title><link rel="icon" href="/icon.png"><body><p>favicon page</p></body>',
};
const server = createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/five") {
    response
      .writeHead(500, { "content-type": "text/html; charset=utf-8" })
      .end("<!doctype html><title>Sewed extras five</title><body><p>server error</p></body>");
    return;
  }
  if (pathname === "/report.pdf") {
    response
      .writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="report.pdf"',
      })
      .end("%PDF-1.4 sewed download probe\n");
    return;
  }
  if (pathname === "/icon.png") {
    response.writeHead(200, { "content-type": "image/png" }).end(pngIconBytes);
    return;
  }
  const body = pages[pathname];
  if (body === undefined) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
});
const listen = () =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
const entry = (url) => Renderer.entry(url, { bindings: [] });
const awaitReady = (states, url) =>
  waitUntil(
    () => states.values.some((state) => state.status === "ready" && state.url === url.href),
    `ready ${url.href.slice(0, 40)}`,
  );

const runChecks = (origin) =>
  Effect.scoped(
  Effect.gen(function* () {
    const window = yield* BrowserWindow.make({
      show: false,
      width: 640,
      height: 480,
      title: "Sewed extras",
    });
    const web = window.webContents;
    const states = yield* observe(web.state);
    const first = new URL("/one", origin);
    const second = new URL("/two", origin);
    yield* web.load(entry(first), { bindings: [] });
    yield* awaitReady(states, first);

    const pdf = yield* web.pdf({ pageSize: "A4" });
    assert.equal(Buffer.from(pdf.subarray(0, 4)).toString("latin1"), "%PDF");
    // Software rendering on the test display makes page capture flaky; retry before judging it.
    let capture;
    let captureFailure;
    for (let attempt = 0; attempt < 5 && capture === undefined; attempt += 1) {
      const captured = yield* Effect.exit(
        web.capture({ rect: { x: 0, y: 0, width: 32, height: 32 }, stayHidden: true }),
      );
      if (captured._tag === "Success") capture = captured.value;
      else {
        captureFailure = expectCode(captured, "Native");
        yield* Effect.sleep(200);
      }
    }
    assert.ok(capture, `capture failed: ${captureFailure?.message}`);
    assert.deepEqual([...capture.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    // The captured rect is fixed in DIPs (32x32); at a forced device scale factor the image's own
    // pixel dimensions double while scaleFactor reports the same forced value.
    assert.equal(capture.scaleFactor, expectedScale);
    assert.equal(capture.width, 32 * expectedScale);
    assert.equal(capture.height, 32 * expectedScale);
    expectCode(yield* Effect.exit(web.pdf({ pageSize: "B5" })), "Protocol");
    record("pdf and capture return bytes with their format signatures", {
      pdfBytes: pdf.byteLength,
      pngBytes: capture.bytes.byteLength,
      captureWidth: capture.width,
      captureHeight: capture.height,
      captureScaleFactor: capture.scaleFactor,
    });
    // Find in page needs a visible document; page capture on this display needs a hidden one.
    const windowState = yield* observe(window.state);
    yield* window.show;
    yield* waitUntil(() => windowState.values.some((state) => state.visible), "window visible");
    yield* Fiber.interrupt(windowState.fiber);

    const zoom = yield* observe(web.zoom);
    yield* waitUntil(() => zoom.values.length === 1, "zoom replay");
    yield* web.setZoom(1.5);
    yield* waitUntil(() => zoom.values.some((value) => value.factor === 1.5), "zoom change");
    expectCode(yield* Effect.exit(web.setZoom(9)), "Protocol");
    yield* web.setZoom(1);
    const audio = yield* observe(web.audio);
    yield* waitUntil(() => audio.values.length === 1, "audio replay");
    yield* web.setAudioMuted(true);
    yield* waitUntil(() => audio.values.some((value) => value.muted), "audio muted");
    yield* web.setAudioMuted(false);
    const agent = yield* web.userAgent;
    yield* web.setUserAgent(`${agent} SewedExtras/1`);
    assert.ok((yield* web.userAgent).endsWith("SewedExtras/1"));
    yield* Fiber.interrupt(zoom.fiber);
    yield* Fiber.interrupt(audio.fiber);
    record("zoom and audio streams replay and follow commands; the user agent round-trips", {
      zoom: zoom.values.map((value) => value.factor),
      audio: audio.values,
    });

    {
      const native = NativeBrowserWindow.getAllWindows()[0].webContents;
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "sewed-save-page-")));
      const archive = join(directory, "page.mhtml");
      yield* web.savePage(archive, "MHTML");
      const archived = yield* Effect.promise(() => readFile(archive, "latin1"));
      assert.ok(archived.includes("multipart/related"), "an MHTML archive was written");
      expectCode(yield* Effect.exit(web.savePage("page.mhtml", "MHTML")), "Protocol");
      expectCode(yield* Effect.exit(web.savePage(archive, "PDF")), "Protocol");
      yield* web.setBackgroundThrottling(false);
      assert.equal(native.getBackgroundThrottling(), false);
      yield* web.setBackgroundThrottling(true);
      assert.equal(native.getBackgroundThrottling(), true);
      expectCode(yield* Effect.exit(web.setBackgroundThrottling("no")), "Protocol");
      yield* web.setIgnoreMenuShortcuts(true);
      yield* web.setIgnoreMenuShortcuts(false);
      yield* Effect.promise(() =>
        native.executeJavaScript(
          `(() => { const field = document.createElement("input"); field.id = "typed"; document.body.append(field); field.focus(); })()`,
        ),
      );
      native.focus();
      yield* web.insertText("sewed");
      const typed = yield* Effect.promise(() =>
        native.executeJavaScript(`document.getElementById("typed").value`),
      );
      assert.equal(typed, "sewed");
      // Nothing is loading, so stopping is a no-op that must still succeed.
      yield* web.stopLoading;
      const before = states.values.length;
      yield* web.reloadIgnoringCache;
      yield* waitUntil(
        () => states.values.length > before && states.values.at(-1).status === "ready",
        "document ready after a cache-bypassing reload",
      );
      record("a page saves as an archive, takes typed text, and reloads past the cache", {
        archiveBytes: archived.length,
        typed,
      });
    }

    {
      const native = NativeBrowserWindow.getAllWindows()[0].webContents;
      const pageEvents = yield* observe(web.events);
      yield* Effect.sleep(50);
      yield* Effect.promise(() =>
        native.executeJavaScript(
          `(() => { const meta = document.createElement("meta"); meta.name = "theme-color"; meta.content = "#123456"; document.head.append(meta); })()`,
        ),
      );
      yield* waitUntil(
        () => pageEvents.values.some((event) => event.kind === "theme-color" && event.color !== null),
        "theme color event",
      );
      native.focus();
      native.sendInputEvent({ type: "mouseDown", x: 12, y: 12, button: "right", clickCount: 1 });
      native.sendInputEvent({ type: "mouseUp", x: 12, y: 12, button: "right", clickCount: 1 });
      const menu = yield* waitUntil(
        () => pageEvents.values.find((event) => event.kind === "context-menu"),
        "context menu event",
      );
      assert.equal(menu.pageUrl, native.getURL());
      assert.equal(typeof menu.editFlags.canCopy, "boolean");
      const activity = yield* web.activity;
      assert.equal(activity.crashed, false);
      assert.equal(activity.loading, native.isLoading());
      const devTools = yield* web.devTools;
      assert.equal(devTools.opened, false);
      yield* web.edit("selectAll");
      const selected = yield* Effect.promise(() =>
        native.executeJavaScript(`String(getSelection())`),
      );
      assert.ok(selected.length > 0, "selectAll selected the document");
      yield* web.edit("unselect");
      const widthBefore = yield* Effect.promise(() => native.executeJavaScript(`innerWidth`));
      yield* web.enableDeviceEmulation({
        screenPosition: "mobile",
        screenSize: { width: 320, height: 480 },
        viewPosition: { x: 0, y: 0 },
        deviceScaleFactor: 2,
        viewSize: { width: 320, height: 480 },
        scale: 1,
      });
      const emulated = yield* Effect.gen(function* () {
        let last;
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          const seen = yield* Effect.promise(() =>
            native.executeJavaScript(`({ inner: innerWidth, screen: screen.width, ratio: devicePixelRatio })`),
          );
          if (seen.inner === 320 || seen.screen === 320 || seen.ratio === 2) return seen;
          last = seen;
          yield* Effect.sleep(20);
        }
        throw new Error(`Timed out: emulated width ${JSON.stringify(last)}`);
      });
      yield* web.disableDeviceEmulation;
      const tree = yield* web.frameTree;
      assert.ok(tree.length >= 1 && tree[0].isMainFrame && tree[0].parent === null, "main frame first");
      assert.equal(tree[0].url, native.getURL());
      assert.equal(tree[0].osProcessId, native.getOSProcessId());
      assert.equal(yield* web.rendererProcessId, native.getProcessId());
      assert.deepEqual(yield* web.sharedWorkers, []);
      assert.equal(typeof (yield* web.devToolsTargetId), "string");
      // Listing printers asks the system's print service. This Linux machine has none, and the
      // unanswered native call was seen to keep the process from quitting, so it is made only
      // where the platform always has one.
      const printerList =
        process.platform === "linux"
          ? "not asked: no print service here"
          : yield* web.printers.pipe(
              Effect.timeoutOption("10 seconds"),
              Effect.map((found) => (found._tag === "Some" ? found.value.length : "no answer")),
            );
      const rtc = yield* web.webRtc;
      assert.equal(typeof rtc.ipHandlingPolicy, "string");
      yield* web.setWebRtcIpHandlingPolicy("default_public_interface_only");
      assert.equal((yield* web.webRtc).ipHandlingPolicy, "default_public_interface_only");
      yield* web.setWebRtcIpHandlingPolicy("default");
      yield* web.setWebRtcUdpPortRange({ min: 20000, max: 20100 });
      assert.deepEqual((yield* web.webRtc).udpPortRange, { min: 20000, max: 20100 });
      yield* web.setWebRtcUdpPortRange({ min: 0, max: 0 });
      expectCode(yield* Effect.exit(web.setWebRtcUdpPortRange({ min: 2, max: 1 })), "Protocol");
      yield* web.setCaretBrowsing(true);
      assert.equal(yield* web.caretBrowsing, true);
      yield* web.setCaretBrowsing(false);
      expectCode(yield* Effect.exit(web.addDevToolsWorkspace("relative")), "Protocol");
      assert.equal(yield* web.opener, null);
      assert.equal(yield* web.hostId, null);
      assert.equal(yield* web.devToolsContentsId, null);
      const focusedFrame = yield* web.focusedFrame;
      assert.ok(focusedFrame === null || typeof focusedFrame.routingId === "number");
      assert.equal(yield* web.zoomMode, native.getZoomMode());
      yield* web.setZoomLevel(1);
      assert.equal(native.getZoomLevel(), 1);
      assert.equal(yield* web.zoomLevel, 1);
      yield* web.setZoomLevel(0);
      expectCode(yield* Effect.exit(web.setZoomLevel(40)), "Protocol");
      expectCode(yield* Effect.exit(web.setZoomMode("page")), "Protocol");
      expectCode(yield* Effect.exit(web.edit("destroy")), "Protocol");
      expectCode(
        yield* Effect.exit(web.startDrag({ files: ["relative.txt"], icon: "/tmp/none.png" })),
        "Protocol",
      );
      expectCode(yield* Effect.exit(web.startDrag({ files: [], icon: "/tmp/none.png" })), "Protocol");
      expectCode(yield* Effect.exit(web.takeHeapSnapshot("page.heapsnapshot")), "Protocol");
      expectCode(
        yield* Effect.exit(web.setVisualZoomLimits({ minimum: 3, maximum: 1 })),
        "Protocol",
      );
      yield* web.setVisualZoomLimits({ minimum: 1, maximum: 3 });
      yield* web.setImageAnimationPolicy("animate");
      yield* Fiber.interrupt(pageEvents.fiber);
      record("page events, activity, inspection reads, editing commands, and device emulation reach the native page", {
        frames: tree.length,
        printers: printerList,
        kinds: [...new Set(pageEvents.values.map((event) => event.kind))],
        themeColor: pageEvents.values.find((event) => event.kind === "theme-color")?.color,
        widthBefore,
        emulated,
      });
    }

    {
      const offscreenScope = yield* Scope.fork(yield* Effect.scope);
      const offscreen = yield* BrowserWindow.make({
        show: false,
        offscreen: true,
        width: 200,
        height: 120,
      }).pipe(Scope.provide(offscreenScope));
      const painted = yield* observe(offscreen.webContents.frames());
      yield* offscreen.webContents.load(entry(new URL("/one", origin)), { bindings: [] });
      yield* offscreen.webContents.setFrameRate(30);
      expectCode(yield* Effect.exit(offscreen.webContents.setFrameRate(0)), "Protocol");
      yield* offscreen.webContents.invalidate;
      const frame = yield* waitUntil(() => painted.values.at(-1), "an offscreen frame");
      assert.equal(frame.bitmap.bytes.byteLength, frame.bitmap.width * frame.bitmap.height * 4);
      assert.ok(frame.bitmap.width >= 200 && frame.bitmap.height >= 120, JSON.stringify([frame.bitmap.width, frame.bitmap.height]));
      const painting = yield* offscreen.webContents.painting;
      assert.equal(painting.offscreen, true);
      assert.equal(painting.frameRate, 30);
      yield* offscreen.webContents.setPainting(false);
      assert.equal((yield* offscreen.webContents.painting).painting, false);
      yield* Fiber.interrupt(painted.fiber);
      yield* offscreen.webContents.load(entry(new URL("/two", origin)), { bindings: [] });
      const historyBefore = (yield* offscreen.webContents.current).history;
      assert.ok(historyBefore.entries.length >= 2, JSON.stringify(historyBefore));
      expectCode(
        yield* Effect.exit(offscreen.webContents.removeHistoryEntry(historyBefore.index)),
        "Protocol",
      );
      expectCode(yield* Effect.exit(offscreen.webContents.removeHistoryEntry(99)), "Protocol");
      yield* offscreen.webContents.removeHistoryEntry(0);
      const historyAfter = (yield* offscreen.webContents.current).history;
      assert.equal(historyAfter.entries.length, historyBefore.entries.length - 1);
      yield* Scope.close(offscreenScope, Exit.void);
      assert.equal((yield* web.painting).offscreen, false);
      record("an offscreen window paints frames as bitmaps and obeys its painting controls", {
        width: frame.bitmap.width,
        height: frame.bitmap.height,
        dirty: frame.dirty,
        frameRate: painting.frameRate,
        historyEntries: [historyBefore.entries.length, historyAfter.entries.length],
      });
    }

    const searchScope = yield* Scope.fork(yield* Effect.scope);
    const search = yield* web.find("needle").pipe(Scope.provide(searchScope));
    const results = yield* observe(search.results);
    yield* waitUntil(() => results.values.some((value) => value.finalUpdate), "find results");
    assert.equal(results.values.at(-1).matches, 1);
    yield* web.findNext(true);
    yield* waitUntil(() => results.values.length >= 2, "find next");
    const replacement = yield* web.find("one").pipe(Scope.provide(searchScope));
    yield* waitUntil(() => results.values.length > 0 && results.exit !== undefined, "previous search ended");
    assert.equal(results.exit._tag, "Success");
    const replacementResults = yield* observe(replacement.results);
    yield* waitUntil(
      () => replacementResults.values.some((value) => value.finalUpdate),
      "replacement results",
    );
    yield* replacement.stop("keepSelection");
    expectCode(yield* Effect.exit(web.findNext()), "Protocol");
    yield* Scope.close(searchScope, Exit.void);
    expectCode(yield* Effect.exit(Effect.scoped(web.find(""))), "Protocol");
    record("a scoped search streams results, advances, and ends when replaced or stopped", {
      matches: results.values.map((value) => value.matches),
      replacement: replacementResults.values.map((value) => value.matches),
    });

    const styleScope = yield* Scope.fork(yield* Effect.scope);
    yield* web.style("body { background-color: rgb(1, 2, 3); }").pipe(Scope.provide(styleScope));
    yield* Scope.close(styleScope, Exit.void);
    record("a style sheet lives in its scope", {});

    const history = yield* observe(web.history);
    yield* waitUntil(() => history.values.length === 1, "history replay");
    yield* web.load(entry(second), { bindings: [] });
    yield* awaitReady(states, second);
    yield* waitUntil(
      () => history.values.some((value) => value.entries.length === 2 && value.index === 1),
      "history after second load",
    );
    assert.equal(history.values.at(-1).canGoBack, true);
    // No decider is installed yet: the entry exists, so the refusal is the policy's own denial,
    // not a missing entry — `reason` tells the two apart.
    const deniedBack = expectCode(yield* Effect.exit(web.back), "Protocol");
    assert.equal(deniedBack.reason, "policy/denied");
    const missingEntry = expectCode(yield* Effect.exit(web.go(5)), "Protocol");
    assert.equal(missingEntry.reason, "history/no-entry");
    // setNavigationPolicy is gone, and with it the runtime validation it used to perform on its own
    // input; an origin-scoped allowance now installs as a decider on Decidables.WebContents.Navigation,
    // through Navigation.Policy's own origin rule, composed restrictively with whatever else is
    // installed, so history moves within the origin succeed once it is in place.
    yield* web.decide(
      Decidables.WebContents.Navigation,
      Decision.policy(Navigation.Policy, [{ kind: "origin", origin }]),
    );
    // `back` and `forward` now wait for the move they started to settle and answer that state
    // directly, so the settled value is asserted here rather than only through the state stream.
    const backSettled = yield* web.back;
    assert.equal(backSettled.status, "ready");
    assert.equal(backSettled.url, first.href);
    yield* awaitReady(states, first);
    yield* waitUntil(() => history.values.some((value) => value.index === 0), "history back");
    const forwardSettled = yield* web.forward;
    assert.equal(forwardSettled.status, "ready");
    assert.equal(forwardSettled.url, second.href);
    yield* awaitReady(states, second);
    yield* Fiber.interrupt(history.fiber);
    record("history streams entries and applies the navigation policy before moving, and back/forward answer once settled", {
      indexes: history.values.map((value) => value.index),
      backSettled,
      forwardSettled,
      deniedBackReason: deniedBack.reason,
      missingEntryReason: missingEntry.reason,
    });

    const readyTail = () =>
      waitUntil(() => {
        const last = states.values.at(-1);
        return last?.status === "ready" ? last : undefined;
      }, "the most recent load settled ready");

    const fivePage = new URL("/five", origin);
    yield* web.load(entry(fivePage), { bindings: [] });
    const fiveReady = yield* readyTail();
    assert.equal(fiveReady.url, fivePage.href);
    assert.equal(fiveReady.httpStatus, 500, "a 500 document is still ready, with httpStatus 500");

    const dataDoc = new URL(
      `data:text/html,${encodeURIComponent("<!doctype html><title>Sewed extras data</title>")}`,
    );
    yield* web.load(entry(dataDoc), { bindings: [] });
    const dataReady = yield* readyTail();
    assert.equal(dataReady.httpStatus, 200, "a data: document reports a synthetic 200");

    const localDirectory = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "sewed-webcontents-extras-local-")),
    );
    const localPath = join(localDirectory, "local.html");
    yield* Effect.promise(() =>
      writeFile(localPath, "<!doctype html><title>Sewed extras local file</title>"),
    );
    const fileDoc = pathToFileURL(localPath);
    yield* web.load(entry(fileDoc), { bindings: [] });
    const fileReady = yield* readyTail();
    assert.equal(fileReady.url, fileDoc.href);
    assert.equal(fileReady.httpStatus, 200, "a file: document reports a synthetic 200");

    record(
      "ready reports the main frame's HTTP status: a server error stays ready, data: and file: report a synthetic 200",
      { five: fiveReady.httpStatus, data: dataReady.httpStatus, file: fileReady.httpStatus },
    );

    const nativeWindowForDocuments = NativeBrowserWindow.getAllWindows()[0];
    const documentTitle = () =>
      Effect.promise(() => nativeWindowForDocuments.webContents.executeJavaScript("document.title"));

    const localDoc = Renderer.local("documents/local.html", import.meta.url);
    yield* web.load(localDoc, { bindings: [] });
    const localReady = yield* readyTail();
    assert.equal(localReady.url, localDoc.url.href);
    assert.equal(localReady.httpStatus, 200);
    const localTitle = yield* documentTitle();
    assert.equal(localTitle, "Sewed extras local document");

    const missingDoc = Renderer.local("documents/missing.html", import.meta.url);
    const stateCountBeforeMissing = states.values.length;
    const missingLoad = yield* Effect.exit(web.load(missingDoc, { bindings: [] }));
    const missingError = expectCode(missingLoad, "Protocol");
    assert.ok(
      /documents[\\/]missing\.html/.test(missingError.message),
      `expected the missing path in the message: ${missingError.message}`,
    );
    assert.equal(
      states.values.length,
      stateCountBeforeMissing,
      "a failed local load leaves the window's state untouched",
    );
    assert.deepEqual(states.values.at(-1), localReady);

    // A well-formed URL (the URL constructor does not validate percent content in a path) that
    // fileURLToPath itself refuses: the encoded slash must surface as Protocol, not an unguarded
    // native TypeError, and must not touch the window's state either.
    const encodedSlashDoc = Renderer.local("cra%2Fsh/index.html", import.meta.url);
    const stateCountBeforeEncodedSlash = states.values.length;
    const encodedSlashLoad = yield* Effect.exit(web.load(encodedSlashDoc, { bindings: [] }));
    const encodedSlashError = expectCode(encodedSlashLoad, "Protocol");
    assert.ok(
      encodedSlashError.message.includes("cra%2Fsh"),
      `expected the encoded path in the message: ${encodedSlashError.message}`,
    );
    assert.equal(
      states.values.length,
      stateCountBeforeEncodedSlash,
      "a failed local load (encoded slash) leaves the window's state untouched",
    );
    record("a local path fileURLToPath itself refuses (an encoded slash) fails Protocol, not an unguarded native error", {
      encodedSlashMessage: encodedSlashError.message,
    });

    const inlineDoc = Renderer.inline("<!doctype html><title>inline</title>parked");
    yield* web.load(inlineDoc, { bindings: [] });
    const inlineReady = yield* readyTail();
    assert.equal(inlineReady.httpStatus, 200);
    const inlineTitle = yield* documentTitle();
    assert.equal(inlineTitle, "inline");

    record(
      "Renderer.local loads a shipped document and Renderer.inline loads a parked one; a missing local path fails Protocol naming it, without touching state",
      {
        localTitle,
        missingMessage: missingError.message,
        inlineHttpStatus: inlineReady.httpStatus,
        inlineTitle,
      },
    );

    // Restore the document the window-controls block below expects ("needle" appears twice on /two).
    yield* web.load(entry(second), { bindings: [] });
    yield* awaitReady(states, second);

    const controls = yield* Capability.serve(WindowControls.capability).pipe(
      Effect.provide(WindowControls.native(window)),
    );
    yield* Effect.gen(function* () {
      const client = yield* Controls();
      const bound = yield* observe(client.zoom());
      yield* client.setZoom({ factor: 2 });
      yield* waitUntil(() => bound.values.some((value) => value.factor === 2), "bound zoom");
      const boundHistory = yield* observe(client.history());
      yield* waitUntil(() => boundHistory.values.length === 1, "bound history replay");
      // Already on the last entry: forward has nowhere to go, and the reason crosses the RPC wire.
      const boundMissingEntry = expectCode(yield* Effect.exit(client.forward()), "Protocol");
      assert.equal(boundMissingEntry.reason, "history/no-entry");
      yield* client.setTitle({ title: "Sewed extras bound" });
      const state = yield* client.state();
      assert.equal(state.title, "Sewed extras bound");
      const boundSearch = yield* observe(client.find({ text: "needle" }));
      yield* waitUntil(() => boundSearch.values.some((value) => value.finalUpdate), "bound find");
      assert.equal(boundSearch.values.at(-1).matches, 2);
      yield* client.findNext({ forward: true });
      yield* Fiber.interrupt(boundSearch.fiber);
      expectCode(yield* Effect.exit(client.findNext({ forward: true })), "Protocol");
      yield* Fiber.interrupt(bound.fiber);
      yield* Fiber.interrupt(boundHistory.fiber);
      record("bound clients drive zoom, history, title, and find through the window controls", {
        zoom: bound.values.map((value) => value.factor),
        matches: boundSearch.values.map((value) => value.matches),
      });
    }).pipe(Effect.provide(Binding.layer([Binding.to(Controls, controls)])));
    yield* web.setZoom(1);

    const consoleMessages = yield* observe(web.console);
    const consolePage = new URL("/console", origin);
    yield* web.load(entry(consolePage), { bindings: [] });
    yield* awaitReady(states, consolePage);
    yield* waitUntil(
      () =>
        consoleMessages.values.some(
          (value) => value.level === "warning" && value.message === "sewed console probe",
        ),
      "console warning",
    );
    yield* Fiber.interrupt(consoleMessages.fiber);
    const probe = consoleMessages.values.find((value) => value.message === "sewed console probe");
    assert.equal(typeof probe.lineNumber, "number");
    assert.equal(probe.sourceId, consolePage.href);
    record("console messages stream from the page with level, text, line, and source", { probe });

    const nativeWindow = NativeBrowserWindow.getAllWindows()[0];
    const downloadDirectory = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "sewed-window-downloads-")),
    );
    // A scoped decider keeps native governance active independently of downloads observers.
    const listenersBeforeSave = nativeWindow.webContents.session.listenerCount("will-download");
    const offered = [];
    yield* web.decide(
      Decidables.WebContents.Download,
      Decision.sync((offer) => {
        offered.push(offer);
        return { kind: "save", path: join(downloadDirectory, offer.filename) };
      }),
    );
    assert.equal(
      nativeWindow.webContents.session.listenerCount("will-download"),
      listenersBeforeSave + 1,
      "the decider engages native governance before any observer",
    );
    const saved = yield* observe(web.downloads);
    yield* Effect.yieldNow;
    nativeWindow.webContents.downloadURL(new URL("/report.pdf", origin).href);
    yield* waitUntil(() => saved.values.length === 1, "window download accepted");
    const outcome = yield* saved.values[0].awaitDone;
    assert.equal(outcome.kind, "completed");
    const downloadDetails = yield* saved.values[0].details;
    assert.equal(downloadDetails.savePath, join(downloadDirectory, "report.pdf"));
    assert.ok(downloadDetails.startTime > 0, "a start time");
    assert.equal(typeof downloadDetails.initiatorOrigin, "string");
    const bytes = yield* Effect.promise(() => readFile(join(downloadDirectory, "report.pdf")));
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "%PDF");
    // The offer says how the download came about: its redirect chain and whether a user asked.
    assert.equal(offered.length, 1);
    assert.deepEqual(offered[0].urlChain, [new URL("/report.pdf", origin).href]);
    assert.equal(typeof offered[0].userGesture, "boolean");
    assert.equal(typeof offered[0].contentDisposition, "string");
    yield* Fiber.interrupt(saved.fiber);
    assert.equal(
      nativeWindow.webContents.session.listenerCount("will-download"),
      listenersBeforeSave + 1,
      "native governance remains after the last downloads observer ends",
    );

    const blockedEvents = yield* observe(web.blocked);
    // Deny outranks the existing save decider and must work with no downloads observer.
    yield* web.decide(
      Decidables.WebContents.Download,
      Decision.sync(() => ({ kind: "deny" })),
    );
    const seenItems = [];
    // Electron destroys a vetoed item once the event returns, so read it inside the event.
    const watch = (event, item) =>
      seenItems.push({ item, prevented: event.defaultPrevented, url: item.getURL() });
    nativeWindow.webContents.session.on("will-download", watch);
    nativeWindow.webContents.downloadURL(new URL("/report.pdf?denied", origin).href);
    yield* waitUntil(() => seenItems.length === 1, "denied download observed");
    const deniedUrl = new URL("/report.pdf?denied", origin).href;
    yield* waitUntil(
      () =>
        blockedEvents.values.some((value) => value.kind === "download" && value.url === deniedUrl),
      "denied download reported as blocked",
    );
    yield* Effect.sleep(500);
    nativeWindow.webContents.session.off("will-download", watch);
    assert.equal(seenItems[0].prevented, true, "the decider vetoed before later listeners ran");
    let destroyedAfterVeto = false;
    try {
      seenItems[0].item.getState();
    } catch {
      destroyedAfterVeto = true;
    }
    assert.equal(destroyedAfterVeto, true, "Electron destroyed the vetoed download item");
    record("a window download decider saves observed items and denies without downloads observers", {
      saved: outcome.kind,
      bytes: bytes.byteLength,
      deniedUrl: seenItems[0].url,
      prevented: seenItems[0].prevented,
      destroyedAfterVeto,
    });

    const leavePage = new URL("/leave", origin);
    const windowsBefore = NativeBrowserWindow.getAllWindows().length;
    yield* web.load(entry(leavePage), { bindings: [] });
    yield* awaitReady(states, leavePage);
    yield* waitUntil(
      () =>
        blockedEvents.values.some(
          (value) => value.kind === "popup" && value.url === "https://popup.invalid/child",
        ) &&
        blockedEvents.values.some(
          (value) => value.kind === "navigation" && value.url === "https://away.invalid/next",
        ),
      "renderer blocked popup and navigation",
    );
    yield* Effect.sleep(200);
    assert.equal(nativeWindow.webContents.getURL(), leavePage.href, "the document stayed put");
    assert.equal(NativeBrowserWindow.getAllWindows().length, windowsBefore, "no popup opened");
    yield* Fiber.interrupt(blockedEvents.fiber);
    record("a renderer window reports the downloads, popups, and navigations it denied", {
      blocked: blockedEvents.values,
      stateTail: states.values.slice(-3).map((value) => ({ status: value.status, url: value.url })),
    });

    const favicons = yield* observe(web.favicons);
    const faviconPage = new URL("/favicon-page", origin);
    const iconUrl = new URL("/icon.png", origin);
    yield* web.load(entry(faviconPage), { bindings: [] });
    yield* awaitReady(states, faviconPage);
    yield* waitUntil(
      () => favicons.values.some((list) => list.includes(iconUrl.href)),
      "favicon list includes the page's icon URL",
    );
    const withIcon = favicons.values.find((list) => list.includes(iconUrl.href));
    const noFaviconPage = new URL("/one", origin);
    yield* web.load(entry(noFaviconPage), { bindings: [] });
    yield* awaitReady(states, noFaviconPage);
    yield* waitUntil(
      () => favicons.values.at(-1)?.length === 0,
      "favicon list resets to empty for a page without an icon",
    );
    const afterNavigatingAway = favicons.values.at(-1);
    yield* Fiber.interrupt(favicons.fiber);
    record("favicons publishes a page's icon URL and resets to empty without one", {
      withIcon,
      afterNavigatingAway,
    });

    // Task 1: the title stream follows page-title-updated whatever TitleUpdate answers — the
    // decision governs only the native title-bar effect, not this observation — so it already
    // carries the favicon check's own page title here, with no decider installed at all. Task 3:
    // `current` answers the same six values fresh.
    const beforeAnyDecider = yield* web.current;
    yield* window.webContents.decide(
      Decidables.WebContents.TitleUpdate,
      Decision.sync(() => "accept"),
    );
    const titles = yield* observe(web.title);
    const titlePage = new URL("/two", origin);
    yield* web.load(entry(titlePage), { bindings: [] });
    yield* awaitReady(states, titlePage);
    yield* waitUntil(
      () => titles.values.includes("Sewed extras two"),
      "title follows the page's own <title>, decider installed or not",
    );
    yield* Fiber.interrupt(titles.fiber);
    const current = yield* web.current;
    assert.equal(
      beforeAnyDecider.title,
      "Sewed extras one",
      "the stream already followed the favicon check's own page title with no decider installed",
    );
    assert.equal(current.title, "Sewed extras two");
    assert.equal(current.state.status, "ready");
    assert.equal(current.state.url, titlePage.href);
    record("title follows page-title-updated whatever TitleUpdate answers, and current answers state/history/title/favicons/zoom/audio fresh", {
      titleBeforeAnyDecider: beforeAnyDecider.title,
      titles: titles.values,
      current,
    });

    // Installment 7, ruling 3: only the BROWSER WINDOW's own page-title-updated holds Electron's
    // native title bar — checked above is the title *stream*, which follows the page regardless
    // of the decision; this is the native effect the decision actually governs. Two fresh windows,
    // each with its own fixed title and its own decider, so neither registry sees the other's
    // answer.
    const kept = yield* Effect.scoped(
      Effect.gen(function* () {
        const keptWindow = yield* BrowserWindow.make({
          show: false,
          width: 320,
          height: 240,
          title: "Fixed title (keep)",
        });
        yield* keptWindow.webContents.decide(
          Decidables.WebContents.TitleUpdate,
          Decision.sync(() => "keep"),
        );
        const keptStates = yield* observe(keptWindow.webContents.state);
        const keepPage = new URL("/two", origin);
        yield* keptWindow.webContents.load(entry(keepPage), { bindings: [] });
        yield* awaitReady(keptStates, keepPage);
        yield* Effect.sleep(300);
        return (yield* keptWindow.current).title;
      }),
    );
    assert.equal(kept, "Fixed title (keep)", "a keep decider must hold the native title");
    const accepted = yield* Effect.scoped(
      Effect.gen(function* () {
        const acceptedWindow = yield* BrowserWindow.make({
          show: false,
          width: 320,
          height: 240,
          title: "Fixed title (accept)",
        });
        yield* acceptedWindow.webContents.decide(
          Decidables.WebContents.TitleUpdate,
          Decision.sync(() => "accept"),
        );
        const acceptedStates = yield* observe(acceptedWindow.webContents.state);
        const acceptPage = new URL("/two", origin);
        yield* acceptedWindow.webContents.load(entry(acceptPage), { bindings: [] });
        yield* awaitReady(acceptedStates, acceptPage);
        yield* Effect.sleep(300);
        return (yield* acceptedWindow.current).title;
      }),
    );
    assert.equal(
      accepted,
      "Sewed extras two",
      "an accept decider must let the native title follow the page",
    );
    record("a fixed native title is held under a keep decider and follows the page under accept", {
      kept,
      accepted,
    });

    if (process.env.SEWED_SKIP_CRASH_CHECKS === "1") {
      console.log(
        "SKIP webContents.terminate crashes the renderer without reloading it (SEWED_SKIP_CRASH_CHECKS)",
      );
    } else {
      const terminatePage = new URL("/one", origin);
      yield* web.load(entry(terminatePage), { bindings: [] });
      yield* awaitReady(states, terminatePage);
      const beforeTerminate = states.values.length;
      yield* web.terminate;
      yield* waitUntil(() => states.values.some((state) => state.status === "gone"), "renderer terminated");
      const goneIndex = states.values.findIndex((state) => state.status === "gone");
      const isCrashedAfterTerminate = nativeWindow.webContents.isCrashed();
      yield* Effect.sleep(500);
      const followedByLoading = states.values
        .slice(goneIndex + 1)
        .some((state) => state.status === "loading");
      assert.equal(followedByLoading, false, "terminate must not reload the renderer");
      record("webContents.terminate crashes the renderer without reloading it", {
        isCrashedAfterTerminate,
        statesBeforeTerminate: beforeTerminate,
        stateTail: states.values.slice(-3).map((value) => value.status),
      });
    }
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
        `WEB_CONTENTS_EXTRAS_VERIFICATION ${JSON.stringify({
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
