import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, webContents as nativeWebContents } from "electron";
import { Cause, Effect, Fiber, Schema, Stream } from "effect";
import { Decidables, Decision, Renderer, SewedError } from "sewed";
import { App, BrowserWindow, GuestView, Image, Session } from "sewed/main";

app.setPath("userData", mkdtempSync(join(tmpdir(), "sewed-guest-")));
const checks = [];
const record = (name, evidence = {}) => {
  checks.push({ name, evidence });
  console.log(`PASS ${name}`);
};
const codeOf = (exit) => {
  if (exit._tag !== "Failure") return undefined;
  const error = Cause.squash(exit.cause);
  return error instanceof SewedError ? error.code : `unexpected:${String(error)}`;
};

const page = (body) => `<!doctype html><title>Sewed guest</title><body>${body}</body>`;
let other;
const site = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  const html = (body) =>
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(body));
  if (url.pathname === "/")
    return html(
      `<a id="cross" href="${other}/">cross</a><a id="same" href="/second">same</a>` +
        `<button id="popup" onclick="window.open('${other}/')">popup</button>`,
    );
  if (url.pathname === "/second") return html("<p id='second'>second</p>");
  if (url.pathname === "/redirect") return response.writeHead(302, { location: `${other}/` }).end();
  if (url.pathname === "/webview") return html("<webview id='wv' src='about:blank'></webview>");
  if (url.pathname === "/form")
    return html(
      `<form id="f" method="post" enctype="multipart/form-data" action="/submit">` +
        `<input name="token" value="${url.searchParams.get("token") ?? ""}">` +
        `<input id="file" type="file" name="upload"><button id="send" type="submit">send</button></form>`,
    );
  if (url.pathname === "/submit") {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => html(`<p id="submitted">${body.length}</p>`));
    return;
  }
  if (url.pathname === "/input")
    return html(
      '<input id="field" type="text" style="position:absolute;top:10px;left:10px;width:120px;height:24px;">' +
        "<script>" +
        "window.__keys = 0; window.__clicks = 0;" +
        'const field = document.getElementById("field");' +
        'field.addEventListener("keydown", () => { window.__keys += 1; });' +
        'field.addEventListener("click", () => { window.__clicks += 1; });' +
        "</script>",
    );
  if (url.pathname === "/download")
    return response
      .writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="report.bin"',
      })
      .end(Buffer.alloc(2048, 7));
  response.writeHead(404).end();
});
const otherServer = createServer((_request, response) =>
  response
    .writeHead(200, { "content-type": "text/html" })
    .end(page("<p id='other'>other</p>")),
);
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "localhost", () => resolve(`http://localhost:${server.address().port}`)),
  );

const waitUntil = (read, description, timeout = 8_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = read();
      if (value) return value;
      yield* Effect.sleep(20);
    }
    throw new Error(`Timed out: ${description}`);
  });
const awaitFiber = (fiber, description, timeout = 8_000) =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(Effect.timeout(timeout)(Fiber.join(fiber)));
    if (result._tag === "Success") return result.value;
    yield* Fiber.interrupt(fiber);
    throw new Error(`Timed out: ${description}: ${Cause.pretty(result.cause)}`);
  });
const observe = (stream) =>
  Effect.gen(function* () {
    const values = [];
    const fiber = yield* stream.pipe(
      Stream.runForEach((value) => Effect.sync(() => values.push(value))),
      Effect.forkScoped,
    );
    return { values, fiber };
  });
const stateWhere = (guest, predicate, description) =>
  guest.webContents.state.pipe(
    Stream.filter(predicate),
    Stream.take(1),
    Stream.runCollect,
    Effect.map((states) => [...states][0]),
    Effect.timeoutOrElse({
      duration: 8_000,
      orElse: () => Effect.die(new Error(`Timed out: ${description}`)),
    }),
  );
const ready = (guest, url) =>
  stateWhere(
    guest,
    (state) => state.status === "ready" && (url === undefined || state.url === url),
    `ready at ${url ?? "any url"}`,
  );
const failed = (guest, url) =>
  stateWhere(guest, (state) => state.status === "failed" && state.url === url, `failed at ${url}`);
const evaluate = (guest, script, schema = Schema.Unknown) =>
  guest.automation.evaluate(script, schema);
const click = (guest, id) => evaluate(guest, `document.getElementById(${JSON.stringify(id)}).click(); true`, Schema.Boolean);
const bodyText = (body) =>
  body === undefined
    ? ""
    : body.parts
        .filter((part) => part.kind === "bytes")
        .map((part) => Buffer.from(part.bytes).toString("utf8"))
        .join("");
const bounds = { x: 0, y: 0, width: 900, height: 700 };
const pngHeader = [137, 80, 78, 71];
const pixelAt = (bitmap, x, y) => {
  const offset = (y * bitmap.width + x) * 4;
  return [...bitmap.bytes.subarray(offset, offset + 4)];
};

const runChecks = (origin) =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* Session.fromPartition({
        kind: "memory",
        name: `guest-${process.pid}-${Date.now()}`,
      });
      const window = yield* BrowserWindow.make({
        title: "Sewed guest",
        width: 900,
        height: 700,
        show: true,
      });
      // Captured before the guest attaches and covers the whole window: once a full-bounds guest
      // view sits on top, the window's own contents has no current display surface to capture (a
      // real Electron 44 limit, not a Sewed one). The composite check later reuses this base.
      yield* window.webContents.load(
        Renderer.inline("<!doctype html><body style='margin:0;background:#123456'></body>"),
        { bindings: [] },
      );
      let windowShot;
      for (let attempt = 0; attempt < 5 && windowShot === undefined; attempt++) {
        const captured = yield* Effect.exit(window.webContents.capture({}));
        if (captured._tag === "Success" && captured.value.bytes.byteLength > 0)
          windowShot = captured.value;
        else yield* Effect.sleep(200);
      }
      assert.ok(windowShot !== undefined, "window base capture for the composite check");
      const compositeBase = yield* Image.decode(windowShot.bytes);
      const guest = yield* GuestView.make({
        session,
        navigation: [`${origin}/*`],
        automation: {
          evaluate: true,
          devtools: ["DOM.getDocument", "DOM.querySelector", "DOM.setFileInputFiles"],
        },
      });
      yield* window.attach(guest, { bounds });
      const blocked = yield* observe(guest.blocked);
      yield* guest.navigate(`${origin}/`);
      yield* ready(guest, `${origin}/`);
      const bridge = yield* evaluate(guest, "typeof window.sewed", Schema.String);
      assert.equal(bridge, "undefined");
      record("a guest page has no bridge", { bridge });

      yield* click(guest, "cross");
      yield* waitUntil(
        () => blocked.values.some((value) => value.kind === "navigation" && value.url.startsWith(other)),
        "cross-origin navigation blocked",
      );
      yield* click(guest, "same");
      yield* ready(guest, `${origin}/second`);
      const redirect = yield* Effect.exit(guest.navigate(`${origin}/redirect`));
      yield* waitUntil(
        () => blocked.values.some((value) => value.kind === "redirect" && value.url.startsWith(other)),
        "redirect blocked",
      );
      const reported = blocked.values.length;
      const outside = yield* Effect.exit(guest.navigate(`${other}/`));
      assert.equal(codeOf(outside), "Protocol");
      yield* Effect.sleep("200 millis");
      assert.equal(blocked.values.length, reported, "main's own navigate is not reported as blocked");
      record("the navigation policy blocks and allows navigations and redirects", {
        blocked: blocked.values.map((value) => value.kind),
        redirect: redirect._tag,
      });

      yield* guest.navigate(`${origin}/`);
      yield* ready(guest, `${origin}/`);
      yield* click(guest, "popup");
      yield* waitUntil(() => blocked.values.some((value) => value.kind === "popup"), "popup denied");
      yield* guest.navigate(`${origin}/webview`);
      yield* ready(guest, `${origin}/webview`);
      const webview = yield* evaluate(
        guest,
        "(() => { const el = document.querySelector('webview'); return { present: el !== null, attached: el !== null && typeof el.getWebContentsId === 'function' }; })()",
        Schema.Struct({ present: Schema.Boolean, attached: Schema.Boolean }),
      );
      assert.equal(webview.present, true);
      assert.equal(webview.attached, false);
      record("popups and webviews are denied", {
        popup: true,
        webviewEvent: blocked.values.some((value) => value.kind === "webview"),
      });

      const twin = yield* GuestView.make({
        session,
        navigation: [`${origin}/*`],
        automation: { evaluate: true },
      });
      yield* window.attach(twin, { bounds: { x: 0, y: 0, width: 10, height: 10 }, visible: false });
      const seen = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* session.intercept(
            Decidables.Session.Request,
            {
              urls: [`${origin}/submit*`],
              types: ["mainFrame"],
              body: { maxBytes: 4096, blobs: "resolve" },
            },
            Decision.sync((request) => {
              const text = bodyText(request.body);
              const ok = /name="token"\r\n\r\nok\r\n/.test(text);
              seen.push({ sourceId: request.sourceId, bytes: request.body?.bytes, ok });
              return request.sourceId === guest.id && !ok ? { kind: "block" } : Decision.Pass;
            }),
          );
          yield* guest.navigate(`${origin}/form?token=bad`);
          yield* ready(guest, `${origin}/form?token=bad`);
          yield* click(guest, "send");
          const rejected = yield* failed(guest, `${origin}/submit`);
          yield* guest.navigate(`${origin}/form?token=ok`);
          yield* ready(guest, `${origin}/form?token=ok`);
          yield* click(guest, "send");
          yield* ready(guest, `${origin}/submit`);
          const submitted = yield* evaluate(guest, "document.getElementById('submitted').textContent", Schema.String);
          yield* twin.navigate(`${origin}/form?token=bad`);
          yield* ready(twin, `${origin}/form?token=bad`);
          yield* click(twin, "send");
          yield* ready(twin, `${origin}/submit`);
          assert.equal(seen.length, 3);
          assert.deepEqual(
            seen.map((entry) => entry.sourceId),
            [guest.id, guest.id, twin.id],
          );
          assert.ok(seen.every((entry) => entry.bytes > 0));
          record("body-aware interception blocks a mismatched submission and scopes by sourceId", {
            rejected: rejected.description,
            submitted,
            bodies: seen.map((entry) => entry.bytes),
          });
        }),
      );

      const downloads = mkdtempSync(join(tmpdir(), "sewed-guest-downloads-"));
      yield* guest.navigate(`${origin}/`);
      yield* ready(guest, `${origin}/`);
      yield* evaluate(guest, "location.href = '/download'; true", Schema.Boolean);
      // The guest's own registry denies downloads by default from construction now
      // (Decidables.WebContents.Download's per-owner fallback, installed unconditionally): this first
      // attempt is denied before any decider exists at all, not because `entry.decide` is undefined
      // while nothing is subscribed to `downloads` — that mechanism is gone.
      yield* waitUntil(() => blocked.values.some((value) => value.kind === "download"), "download denied");
      yield* guest.webContents.decide(
        Decidables.WebContents.Download,
        Decision.sync((offer) => ({ kind: "save", path: join(downloads, offer.filename) })),
      );
      const accepted = yield* guest.downloads.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.sleep(100);
      yield* evaluate(guest, "location.href = '/download'; true", Schema.Boolean);
      const handles = [...(yield* awaitFiber(accepted, "accepted download"))];
      assert.equal(handles.length, 1);
      const outcome = yield* handles[0].awaitDone;
      assert.deepEqual(outcome, { kind: "completed" });
      const size = statSync(join(downloads, "report.bin")).size;
      assert.equal(size, 2048);
      record("a guest's own fallback denies downloads until a decider is installed, then completes", {
        size,
      });

      // Two subscribers to one guest's `downloads`, in the ordinary order: subscribe the
      // replacement, then end the old one. A guest used to keep a single `onAccepted` slot that
      // each subscription overwrote and each ending subscription reset, so the survivor received
      // nothing again, permanently, and an accepted download ran with nobody holding its handle.
      // `internal/GuestView.ts` cannot be imported by the library's unit suite, so this is where
      // the line that registers each subscription beside the guest's own entry is proven.
      const startDownloadUntil = (received, description) =>
        Effect.gen(function* () {
          const deadline = Date.now() + 8_000;
          while (Date.now() < deadline) {
            yield* evaluate(guest, "location.href = '/download'; true", Schema.Boolean);
            const attempt = Date.now() + 1_000;
            while (Date.now() < attempt) {
              if (received()) return;
              yield* Effect.sleep(20);
            }
          }
          throw new Error(`Timed out: ${description}`);
        });
      const firstSubscriber = yield* observe(guest.downloads);
      yield* startDownloadUntil(
        () => firstSubscriber.values.length > 0,
        "the first subscriber receives a download",
      );
      const firstBeforeOverlap = firstSubscriber.values.length;
      const secondSubscriber = yield* observe(guest.downloads);
      // A download received by the second is what proves its subscription is engaged, so ending it
      // below is ordered rather than raced.
      yield* startDownloadUntil(
        () => secondSubscriber.values.length > 0,
        "the second subscriber receives a download",
      );
      yield* waitUntil(
        () => firstSubscriber.values.length > firstBeforeOverlap,
        "both subscribers receive the same download while both are subscribed",
      );
      const firstAfterOverlap = firstSubscriber.values.length;
      yield* Fiber.interrupt(secondSubscriber.fiber);
      yield* startDownloadUntil(
        () => firstSubscriber.values.length > firstAfterOverlap,
        "the surviving subscriber still receives a download after the other one ended",
      );
      const survivingOutcome = yield* firstSubscriber.values.at(-1).awaitDone;
      assert.deepEqual(survivingOutcome, { kind: "completed" });
      yield* Fiber.interrupt(firstSubscriber.fiber);
      record("a guest's downloads reach both subscribers, and the survivor keeps receiving", {
        first: firstSubscriber.values.length,
        second: secondSubscriber.values.length,
        survivingOutcome,
      });

      const value = yield* evaluate(guest, "({ n: 1 })", Schema.Struct({ n: Schema.Number }));
      assert.deepEqual(value, { n: 1 });
      const mismatch = yield* Effect.exit(evaluate(guest, "({ n: 1 })", Schema.String));
      assert.equal(codeOf(mismatch), "Protocol");
      const thrown = yield* Effect.exit(evaluate(guest, "(() => { throw new Error('page'); })()"));
      assert.equal(codeOf(thrown), "Native");
      record("evaluate decodes results and fails Protocol on a schema mismatch", { value });

      const upload = join(downloads, "upload.txt");
      writeFileSync(upload, "hello");
      yield* guest.navigate(`${origin}/form`);
      yield* ready(guest, `${origin}/form`);
      const document = yield* guest.automation.devtools(
        "DOM.getDocument",
        { depth: 1 },
        Schema.Struct({ root: Schema.Struct({ nodeId: Schema.Number }) }),
      );
      const input = yield* guest.automation.devtools(
        "DOM.querySelector",
        { nodeId: document.root.nodeId, selector: "#file" },
        Schema.Struct({ nodeId: Schema.Number }),
      );
      yield* guest.automation.devtools(
        "DOM.setFileInputFiles",
        { nodeId: input.nodeId, files: [upload] },
        Schema.Unknown,
      );
      const chosen = yield* evaluate(guest, "document.getElementById('file').files[0].name", Schema.String);
      assert.equal(chosen, "upload.txt");
      const outsideAllowlist = yield* Effect.exit(
        guest.automation.devtools("Runtime.evaluate", { expression: "1" }, Schema.Unknown),
      );
      assert.equal(codeOf(outsideAllowlist), "Protocol");
      record("allowlisted DevTools calls set a file input and other methods fail Protocol", {
        chosen,
      });

      const probe = yield* GuestView.make({
        session,
        navigation: [`${origin}/*`],
        automation: { devtools: ["DOM.getDocument"] },
      });
      yield* window.attach(probe, { bounds: { x: 0, y: 0, width: 10, height: 10 }, visible: false });
      yield* probe.navigate(`${origin}/second`);
      yield* ready(probe, `${origin}/second`);
      yield* probe.webContents.openDevTools({ mode: "detach" });
      yield* Effect.sleep(500);
      const held = yield* Effect.exit(
        probe.automation.devtools(
          "DOM.getDocument",
          { depth: 0 },
          Schema.Struct({ root: Schema.Struct({ nodeId: Schema.Number }) }),
        ),
      );
      yield* probe.webContents.closeDevTools;
      assert.equal(held._tag, "Success");
      record("an open DevTools front-end coexists with the guest's debugger session", {
        devtoolsOpen: true,
        attached: held._tag === "Success",
      });

      let shot;
      for (let attempt = 0; attempt < 5 && shot === undefined; attempt++) {
        const captured = yield* Effect.exit(guest.webContents.capture({}));
        if (captured._tag === "Success" && captured.value.bytes.byteLength > 0)
          shot = captured.value;
        else yield* Effect.sleep(200);
      }
      assert.ok(shot !== undefined);
      assert.deepEqual([...shot.bytes.subarray(0, 4)], pngHeader);
      // No rect was given: the guest's own attached bounds (900x700 DIP) times the display's
      // scale factor give the capture's pixel size, exactly as a window's own capture would.
      assert.equal(shot.width, bounds.width * shot.scaleFactor);
      assert.equal(shot.height, bounds.height * shot.scaleFactor);
      record("capture answers pixel size and scale factor for a guest with no rect", {
        bytes: shot.bytes.byteLength,
        width: shot.width,
        height: shot.height,
        scaleFactor: shot.scaleFactor,
      });

      // A composite screenshot: `compositeBase` (captured before the guest attached, above) as
      // the base, the guest's own tab resized to its attached bounds (in pixels) and composed at
      // its offset, encoded back to PNG.
      const overlay = yield* Image.resize(yield* Image.decode(shot.bytes), {
        width: Math.round(bounds.width * windowShot.scaleFactor),
        height: Math.round(bounds.height * windowShot.scaleFactor),
      });
      const offsetX = Math.round(bounds.x * windowShot.scaleFactor);
      const offsetY = Math.round(bounds.y * windowShot.scaleFactor);
      const composite = Image.compose(compositeBase, [{ bitmap: overlay, x: offsetX, y: offsetY }]);
      const compositePng = yield* Image.encode(composite, { format: "png" });
      const decodedComposite = yield* Image.decode(compositePng);
      const sampleX = offsetX + 5;
      const sampleY = offsetY + 5;
      assert.deepEqual(
        pixelAt(decodedComposite, sampleX, sampleY),
        pixelAt(overlay, sampleX - offsetX, sampleY - offsetY),
      );
      record("a composite screenshot lays the guest's capture over the window's at its attached bounds", {
        baseWidth: compositeBase.width,
        baseHeight: compositeBase.height,
        overlayWidth: overlay.width,
        overlayHeight: overlay.height,
        compositeWidth: composite.width,
        compositeHeight: composite.height,
        compositePngBytes: compositePng.byteLength,
        sampledPixel: pixelAt(decodedComposite, sampleX, sampleY),
      });

      // Image.decode takes an Image.Source, a path or bytes, through the same nativeImageOf
      // resolution every icon door already uses — not bytes alone.
      const decodeDir = mkdtempSync(join(tmpdir(), "sewed-image-decode-"));
      const compositePath = join(decodeDir, "composite.png");
      writeFileSync(compositePath, compositePng);
      const decodedFromPath = yield* Image.decode(compositePath);
      assert.deepEqual([...decodedFromPath.bytes], [...decodedComposite.bytes]);
      assert.equal(decodedFromPath.width, decodedComposite.width);
      assert.equal(decodedFromPath.height, decodedComposite.height);
      record("Image.decode reads a path the same way it reads bytes", {
        path: compositePath,
        width: decodedFromPath.width,
        height: decodedFromPath.height,
      });

      const unreadablePath = join(decodeDir, "not-an-image.txt");
      writeFileSync(unreadablePath, "not a png");
      const unreadableExit = yield* Effect.exit(Image.decode(unreadablePath));
      assert.equal(codeOf(unreadableExit), "Protocol");
      const unreadableError = Cause.squash(unreadableExit.cause);
      assert.ok(unreadableError.message.includes(unreadablePath), unreadableError.message);
      record("Image.decode fails Protocol naming the path for a path that is not a readable image", {
        path: unreadablePath,
        message: unreadableError.message,
      });

      const states = yield* guest.webContents.state.pipe(Stream.runDrain, Effect.forkScoped);
      yield* guest.close;
      yield* awaitFiber(states, "state stream ends on close");
      yield* awaitFiber(blocked.fiber, "blocked stream ends on close");
      yield* guest.awaitClosed;
      const afterClose = yield* Effect.exit(
        guest.automation.devtools("DOM.getDocument", undefined, Schema.Unknown),
      );
      assert.equal(codeOf(afterClose), "Closed");
      record("closing the view ends every stream and detaches the debugger");

      const inputSession = yield* Session.fromPartition({
        kind: "memory",
        name: `guest-input-${process.pid}-${Date.now()}`,
      });
      const inputWindow = yield* BrowserWindow.make({
        title: "Sewed guest input",
        width: 400,
        height: 300,
        show: true,
      });
      yield* inputWindow.focus;
      const inputGuest = yield* GuestView.make({
        session: inputSession,
        navigation: [`${origin}/*`],
        input: "block",
        automation: { evaluate: true, input: true },
      });
      yield* inputWindow.attach(inputGuest, { bounds: { x: 0, y: 0, width: 400, height: 300 } });
      yield* inputGuest.navigate(`${origin}/input`);
      yield* ready(inputGuest, `${origin}/input`);
      yield* evaluate(inputGuest, 'document.getElementById("field").focus(); true', Schema.Boolean);
      const nativeInputContents = () =>
        nativeWebContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === `${origin}/input`);
      assert.ok(nativeInputContents(), "native guest contents found by URL");
      // A guest installs its input gate at construction, because `input: "block"` is a posture with
      // no decider behind it. A window's gate is hooked to its first `Input` decider instead, and
      // `verify:windows` asserts the other side of that fork: 0 listeners there with no decider, 1
      // and 1 here with none either. Asserted rather than recorded, so a guest wired to
      // `ContentsInput.hook` by mistake fails here instead of passing quietly.
      const guestInputListeners = {
        key: nativeInputContents().listenerCount("before-input-event"),
        mouse: nativeInputContents().listenerCount("before-mouse-event"),
      };
      assert.deepEqual(
        guestInputListeners,
        { key: 1, mouse: 1 },
        "a guest gates input from construction, with no decider installed",
      );
      const counts = () =>
        evaluate(
          inputGuest,
          "({ keys: window.__keys, clicks: window.__clicks })",
          Schema.Struct({ keys: Schema.Number, clicks: Schema.Number }),
        );
      const sendViaAutomation = () =>
        Effect.gen(function* () {
          yield* inputGuest.automation.input({ type: "keyDown", keyCode: "a" });
          yield* inputGuest.automation.input({ type: "char", keyCode: "a" });
          yield* inputGuest.automation.input({ type: "keyUp", keyCode: "a" });
          yield* inputGuest.automation.input({
            type: "mouseDown",
            x: 20,
            y: 20,
            button: "left",
            clickCount: 1,
          });
          yield* inputGuest.automation.input({
            type: "mouseUp",
            x: 20,
            y: 20,
            button: "left",
            clickCount: 1,
          });
        });
      const sendViaNative = () =>
        Effect.sync(() => {
          const native = nativeInputContents();
          native.sendInputEvent({ type: "keyDown", keyCode: "a" });
          native.sendInputEvent({ type: "char", keyCode: "a" });
          native.sendInputEvent({ type: "keyUp", keyCode: "a" });
          native.sendInputEvent({ type: "mouseDown", x: 20, y: 20, button: "left", clickCount: 1 });
          native.sendInputEvent({ type: "mouseUp", x: 20, y: 20, button: "left", clickCount: 1 });
        });

      const beforeAnyInput = yield* counts();
      assert.deepEqual(beforeAnyInput, { keys: 0, clicks: 0 });
      yield* sendViaAutomation();
      yield* Effect.sleep(300);
      const blockedViaAutomation = yield* counts();
      yield* sendViaNative();
      yield* Effect.sleep(300);
      const blockedViaNative = yield* counts();

      // `input: "block"` above is a per-owner fallback now, not a latched policy: it governs only
      // while no decider is installed. Loosening it means installing a decider that answers "allow",
      // which composes over the fallback under restrictive composition — but only while no *other*
      // installed decider answers "block", since a denial always outranks an allowance regardless of
      // install order. setInputPolicy is gone, and so is the runtime validation of an input-policy
      // string with it: the answer is checked against Decidables.WebContents.Input's own schema at
      // compile time now, covered by the library's own unit suite rather than a runtime operation
      // this fixture calls against a real Electron process — the same reason
      // session-fixture.mjs's setNavigationPolicy migration dropped its own invalid-input assertion.
      yield* inputGuest.webContents.decide(
        Decidables.WebContents.Input,
        Decision.sync(() => "allow"),
      );
      yield* sendViaAutomation();
      yield* Effect.sleep(300);
      const allowedViaAutomation = yield* counts();
      yield* sendViaNative();
      yield* Effect.sleep(300);
      const allowedViaNative = yield* counts();

      // Both blocked readings are asserted, not merely recorded. The one comparison that used to
      // stand here is cumulative, so a gate that let every key through would still have satisfied
      // it as long as the allowed phase added one more — which is exactly what a guest wired like a
      // window would look like.
      assert.deepEqual(
        blockedViaAutomation,
        { keys: 0, clicks: 0 },
        "the guest's block fallback stops automation input",
      );
      assert.deepEqual(
        blockedViaNative,
        { keys: 0, clicks: 0 },
        "the guest's block fallback stops sendInputEvent input too",
      );
      assert.ok(
        allowedViaAutomation.keys > blockedViaAutomation.keys ||
          allowedViaNative.keys > blockedViaNative.keys,
        "allowing the input policy let at least one input path reach the page",
      );
      record(
        "a guest's input fallback blocks by default, and an installed decider looses it by composing over the fallback",
        {
          guestInputListeners,
          beforeAnyInput,
          blockedViaAutomation,
          blockedViaNative,
          allowedViaAutomation,
          allowedViaNative,
        },
      );

      yield* inputWindow.close;
      yield* inputGuest.awaitClosed.pipe(
        Effect.timeoutOrElse({
          duration: 8_000,
          orElse: () => Effect.die(new Error("Timed out: input guest closed with its window")),
        }),
      );

      const second = yield* BrowserWindow.make({ title: "Sewed guest second", show: false });
      const child = yield* GuestView.make({ session, navigation: [] });
      yield* second.attach(child, { bounds: { x: 0, y: 0, width: 100, height: 100 } });
      yield* second.close;
      yield* child.awaitClosed.pipe(
        Effect.timeoutOrElse({
          duration: 8_000,
          orElse: () => Effect.die(new Error("Timed out: attached guest closes with its window")),
        }),
      );
      record("closing the window closes an attached guest");
    }),
  );

async function verify() {
  await app.whenReady();
  other = await listen(otherServer);
  const origin = await listen(site);
  App.run(
    [],
    Effect.gen(function* () {
      yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
      const result = yield* Effect.exit(runChecks(origin));
      site.close();
      otherServer.close();
      console.log(
        `GUEST_VERIFICATION ${JSON.stringify({
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
