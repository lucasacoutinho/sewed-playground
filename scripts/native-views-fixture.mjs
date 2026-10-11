import assert from "node:assert/strict";

import { BaseWindow as NativeBaseWindow, webContents as nativeWebContents } from "electron";
import { Binding, Decidables, Decision, Renderer } from "sewed";
import { Cause, Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import {
  App,
  BaseWindow,
  BrowserWindow,
  ImageView,
  Session,
  View,
  WebContentsView,
  host,
} from "sewed/main";
import { Protocol, Values } from "./dx-contract.mjs";

const checks = [];
const rendererUrl = new URL(
  "../.artifacts/native-views-production-renderer/index.html",
  import.meta.url,
);
const record = (name, evidence = {}) => {
  checks.push({ name, evidence });
  console.log(`PASS ${name}`);
};

const waitUntil = (read, description, timeout = 8_000) =>
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
      yield* Effect.sleep(20);
    }
    throw new Error(
      `Timed out: ${description}${lastError ? ` (${lastError.message || lastError})` : ""}`,
    );
  });

const waitForJavaScript = (native, read, description, accept = Boolean) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 8_000;
    let last;
    while (Date.now() < deadline) {
      last = yield* Effect.promise(() => native.executeJavaScript(read));
      if (accept(last)) return last;
      yield* Effect.sleep(20);
    }
    throw new Error(`Timed out: ${description}${last ? ` (${JSON.stringify(last)})` : ""}`);
  });

const waitForPageValue = (native, description) =>
  Effect.gen(function* () {
    const result = yield* waitForJavaScript(
      native,
      `(() => { const node = document.querySelector("[data-state]"); return node ? { state: node.dataset.state, text: node.textContent } : null; })()`,
      description,
      (value) => value?.state === "value",
    );
    return JSON.parse(result.text);
  });

const awaitFiber = (fiber, description) =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(Effect.timeout(8_000)(Fiber.await(fiber)));
    if (result._tag === "Success") return result.value;
    yield* Fiber.interrupt(fiber);
    throw new Error(`Timed out: ${description}: ${Cause.pretty(result.cause)}`);
  });

const nativeFor = (before, description) =>
  waitUntil(
    () => nativeWebContents.getAllWebContents().find((contents) => !before.has(contents)),
    description,
  );

const nativeWindowFor = (title) =>
  waitUntil(
    () => NativeBaseWindow.getAllWindows().find((window) => window.getTitle() === title),
    `native window ${title}`,
  );

const observe = (stream, values) =>
  stream.pipe(
    Stream.runForEach((value) => Effect.sync(() => values.push(value))),
    Effect.forkScoped,
  );

const load = (view, native, owner) =>
  Effect.gen(function* () {
    const url = new URL(rendererUrl);
    url.searchParams.set("view", view.id);
    yield* view.webContents.load(Renderer.entry(url, { bindings: [Values] }), {
      bindings: [Binding.to(Values, owner)],
    });
    const value = yield* waitForPageValue(native, `renderer value for ${view.id}`);
    return value;
  });

const makeOwner = (subscription) =>
  host(
    Protocol,
    Protocol.toLayer({
      values: ({ key }) => Stream.concat(Stream.make({ key, subscription }), Stream.never),
    }),
  );

const run = Effect.gen(function* () {
  const session = yield* Session.fromPartition({
    kind: "memory",
    name: `native-views-${process.pid}-${Date.now()}`,
  });
  const ownerA = yield* makeOwner(101);
  const ownerB = yield* makeOwner(202);

  const base = yield* BaseWindow.make({
    title: "Sewed native views base",
    width: 1000,
    height: 700,
    show: false,
  });
  const baseNative = yield* nativeWindowFor("Sewed native views base");
  const baseStates = [];
  const baseObserver = yield* observe(base.state, baseStates);
  yield* waitUntil(() => baseStates[0], "BaseWindow state replay");

  const beforeA = new Set(nativeWebContents.getAllWebContents());
  const viewA = yield* WebContentsView.make({ session });
  const nativeA = yield* nativeFor(beforeA, "first native WebContents");
  const beforeB = new Set(nativeWebContents.getAllWebContents());
  const viewB = yield* WebContentsView.make({ session });
  const nativeB = yield* nativeFor(beforeB, "second native WebContents");
  const viewStates = [];
  const viewObserver = yield* observe(viewB.webContents.state, viewStates);
  yield* waitUntil(() => viewStates[0]?.status === "idle", "WebContentsView state replay");

  assert.equal(nativeA.session, nativeB.session);
  const valueA = yield* load(viewA, nativeA, ownerA);
  const security = yield* Effect.promise(() =>
    nativeA.executeJavaScript(`({
      bridge: typeof window.sewed === "object" && window.sewed !== null,
      processType: typeof process,
      requireType: typeof require
    })`),
  );
  assert.deepEqual(security, { bridge: true, processType: "undefined", requireType: "undefined" });
  record("fresh views share the selected session and secure Sewed preload", {
    sessionShared: nativeA.session === nativeB.session,
    security,
  });

  const valueB = yield* load(viewB, nativeB, ownerB);
  assert.deepEqual(valueA, { key: "first", subscription: 101 });
  assert.deepEqual(valueB, { key: "first", subscription: 202 });
  record("two views load through owner-specific bindings", { valueA, valueB });

  const boundsA = { x: 0, y: 0, width: 300, height: 700 };
  const boundsB = { x: 300, y: 0, width: 400, height: 700 };
  const attachmentA = yield* base.attach(viewA, { bounds: boundsA });
  const attachmentB = yield* base.attach(viewB, { bounds: boundsB, visible: false });
  assert.equal(baseNative.contentView.children.length, 2);
  assert.deepEqual(
    baseNative.contentView.children.map((child) => child.getBounds()),
    [boundsA, boundsB],
  );
  assert.deepEqual(
    baseNative.contentView.children.map((child) => child.getVisible()),
    [true, false],
  );
  {
    const seenBounds = [];
    const boundsFiber = yield* attachmentA.boundsChanges.pipe(
      Stream.runForEach((bounds) => Effect.sync(() => seenBounds.push(bounds))),
      Effect.forkScoped,
    );
    yield* Effect.sleep(20);
    const moved = { ...boundsA, width: boundsA.width - 10 };
    yield* attachmentA.setBounds(moved);
    yield* waitUntil(() => seenBounds.length > 0, "view bounds change");
    assert.deepEqual(seenBounds.at(-1), moved);
    yield* attachmentA.setBounds(boundsA);
    yield* Fiber.interrupt(boundsFiber);
    yield* attachmentA.setBackgroundBlur(4);
    yield* attachmentA.setBackgroundBlur(0);
    const refusedBlur = yield* Effect.exit(attachmentA.setBackgroundBlur(-1));
    assert.equal(refusedBlur._tag, "Failure", "a negative blur radius is refused");
  }
  record("BaseWindow attaches both native views with validated bounds and visibility", {
    children: baseNative.contentView.children.map((child) => ({
      bounds: child.getBounds(),
      visible: child.getVisible(),
    })),
  });

  // Task 3: `current` reads bounds/visible fresh, and `raise` draws an attachment above its
  // siblings — proven here against the real native `contentView.children` order, not a fake.
  const currentA = yield* attachmentA.current;
  assert.deepEqual(currentA, { bounds: boundsA, visible: true });
  const currentB = yield* attachmentB.current;
  assert.deepEqual(currentB, { bounds: boundsB, visible: false });
  yield* attachmentA.setVisible(true);
  yield* attachmentB.setVisible(true);
  assert.deepEqual(
    baseNative.contentView.children.map((child) => child.getBounds()),
    [boundsA, boundsB],
    "attach order: A then B, B topmost",
  );
  yield* attachmentA.raise;
  assert.deepEqual(
    baseNative.contentView.children.map((child) => child.getBounds()),
    [boundsB, boundsA],
    "raise reorders A's native child to the topmost (last) position",
  );
  const currentAAfterRaise = yield* attachmentA.current;
  record("current answers bounds/visible fresh, and raise draws an attachment above its siblings", {
    currentA,
    currentB,
    orderAfterRaise: baseNative.contentView.children.map((child) => child.getBounds()),
    currentAAfterRaise,
  });

  const duplicate = yield* base
    .attach(viewA, { bounds: { x: 10, y: 10, width: 280, height: 680 } })
    .pipe(Effect.flip);
  assert.equal(duplicate.code, "Protocol");
  assert.equal(baseNative.contentView.children.length, 2);
  const invalid = yield* base
    .attach(viewB, { bounds: { x: 0.5, y: 0, width: 400, height: 700 } })
    .pipe(Effect.flip);
  assert.equal(invalid.code, "Protocol");
  assert.equal(baseNative.contentView.children.length, 2);
  record("duplicate and invalid attachment requests leave the existing parent unchanged", {
    duplicate: duplicate.code,
    invalid: invalid.code,
    children: baseNative.contentView.children.length,
  });

  const browserBefore = new Set(NativeBaseWindow.getAllWindows());
  const browser = yield* BrowserWindow.make({
    title: "Sewed native views browser",
    show: false,
  });
  const browserNative = yield* waitUntil(
    () =>
      NativeBaseWindow.getAllWindows().find(
        (window) =>
          !browserBefore.has(window) && window.getTitle() === "Sewed native views browser",
      ),
    "native BrowserWindow",
  );
  const browserChildrenBefore = browserNative.contentView.children.length;
  const crossParent = yield* browser
    .attach(viewA, { bounds: { x: 0, y: 0, width: 500, height: 700 } })
    .pipe(Effect.flip);
  assert.equal(crossParent.code, "Protocol");
  assert.equal(browserNative.contentView.children.length, browserChildrenBefore);
  record("cross-window adoption is rejected without mutating the second parent", {
    error: crossParent.code,
    children: browserNative.contentView.children.length,
  });

  yield* attachmentA.setBounds({ ...boundsA, width: 280 });
  const movedBounds = { x: 20, y: 20, width: 260, height: 640 };
  yield* attachmentA.detach;
  yield* attachmentA.detach;
  assert.equal(baseNative.contentView.children.length, 1);
  const browserAttachment = yield* browser.attach(viewA, { bounds: movedBounds });
  const browserView = yield* waitUntil(
    () =>
      browserNative.contentView.children.find((child) =>
        Object.entries(movedBounds).every(([key, value]) => child.getBounds()[key] === value),
      ),
    "reparented native WebContentsView",
  );
  assert.deepEqual(browserView.getBounds(), movedBounds);
  const stale = yield* attachmentA.setBounds({ ...movedBounds, width: 250 }).pipe(Effect.flip);
  assert.equal(stale.code, "Closed");
  yield* attachmentA.detach;
  assert.deepEqual(browserView.getBounds(), movedBounds);
  record("detach permits reparenting and stale attachment operations stay closed", {
    stale: stale.code,
    bounds: browserView.getBounds(),
  });

  yield* viewA.close;
  yield* viewA.awaitClosed;
  assert.equal(nativeA.isDestroyed(), true);
  assert.equal(browserNative.contentView.children.length, browserChildrenBefore);
  const closedViewAttach = yield* browser.attach(viewA, { bounds: movedBounds }).pipe(Effect.flip);
  assert.equal(closedViewAttach.code, "Closed");
  record("closing a view clears its attachment and destroys its native WebContents", {
    nativeDestroyed: nativeA.isDestroyed(),
    attachAfterClose: closedViewAttach.code,
  });

  const beforeC = new Set(nativeWebContents.getAllWebContents());
  const viewC = yield* WebContentsView.make({ session });
  const nativeC = yield* nativeFor(beforeC, "scope cleanup native WebContents");
  const transient = yield* Effect.scoped(
    Effect.gen(function* () {
      return yield* base.attach(viewC, {
        bounds: { x: 0, y: 0, width: 300, height: 700 },
      });
    }),
  );
  assert.equal(baseNative.contentView.children.length, 1);
  const staleTransient = yield* transient.setVisible(true).pipe(Effect.flip);
  assert.equal(staleTransient.code, "Closed");
  const attachmentC = yield* base.attach(viewC, {
    bounds: { x: 0, y: 0, width: 300, height: 700 },
  });
  assert.equal(baseNative.contentView.children.length, 2);
  record("caller scope closure detaches while retaining a view for reattachment", {
    stale: staleTransient.code,
    childrenAfterReattach: baseNative.contentView.children.length,
  });

  const baseClosed = yield* Effect.forkChild(base.awaitClosed);
  yield* base.close;
  yield* base.awaitClosed;
  yield* awaitFiber(baseClosed, "BaseWindow awaitClosed");
  yield* viewB.awaitClosed;
  yield* viewC.awaitClosed;
  assert.equal(baseNative.isDestroyed(), true);
  assert.equal(nativeB.isDestroyed(), true);
  assert.equal(nativeC.isDestroyed(), true);
  yield* awaitFiber(baseObserver, "BaseWindow state observer completion");
  yield* awaitFiber(viewObserver, "WebContentsView state observer completion");
  record("closing a window closes attached views and completes observers and handles", {
    windowDestroyed: baseNative.isDestroyed(),
    viewBContentsDestroyed: nativeB.isDestroyed(),
    viewCContentsDestroyed: nativeC.isDestroyed(),
    baseStates: baseStates.length,
    viewStates: viewStates.length,
  });

  const beforeD = new Set(nativeWebContents.getAllWebContents());
  const viewD = yield* WebContentsView.make({ session });
  const nativeD = yield* nativeFor(beforeD, "BrowserWindow ownership native WebContents");
  const attachmentD = yield* browser.attach(viewD, {
    bounds: { x: 10, y: 10, width: 260, height: 640 },
  });
  const vetoUrl = new URL(
    "data:text/html,<script>window.onbeforeunload=() => 'keep-open';</script>",
  );
  yield* browser.webContents.load(Renderer.entry(vetoUrl, { bindings: [] }), { bindings: [] });
  yield* browser.close;
  yield* Effect.sleep(250);
  assert.equal(browserNative.isDestroyed(), false);
  assert.equal(nativeD.isDestroyed(), false);
  assert.equal(browserNative.contentView.children.length, browserChildrenBefore + 1);
  record("a BrowserWindow beforeunload veto keeps attached views alive", {
    windowDestroyed: browserNative.isDestroyed(),
    viewContentsDestroyed: nativeD.isDestroyed(),
    children: browserNative.contentView.children.length,
  });

  yield* Effect.promise(() =>
    browserNative.webContents.executeJavaScript("window.onbeforeunload = null"),
  );
  const browserClosed = yield* Effect.forkChild(browser.awaitClosed);
  yield* browser.close;
  yield* browser.awaitClosed;
  yield* awaitFiber(browserClosed, "BrowserWindow awaitClosed");
  yield* viewD.awaitClosed;
  assert.equal(browserNative.isDestroyed(), true);
  assert.equal(nativeD.isDestroyed(), true);
  yield* attachmentB.detach;
  yield* attachmentC.detach;
  yield* browserAttachment.detach;
  yield* attachmentD.detach;
  record("BrowserWindow shares the native window attachment and close lifecycle", {
    browserDestroyed: browserNative.isDestroyed(),
    viewContentsDestroyed: nativeD.isDestroyed(),
  });

  {
    const expectCode = (exit, code) => {
      assert.equal(exit._tag, "Failure", "expected a failure");
      const error = Cause.findErrorOption(exit.cause);
      assert.equal(error._tag, "Some", Cause.pretty(exit.cause));
      assert.equal(error.value.code, code, error.value.message);
      return error.value;
    };
    const host = yield* BaseWindow.make({ width: 800, height: 600, show: false });
    const hostNative = NativeBaseWindow.getAllWindows().find(
      (candidate) => !candidate.isDestroyed() && candidate.contentView.children.length === 0,
    );
    assert.ok(hostNative, "host window exists");
    const panelScope = yield* Scope.fork(yield* Effect.scope);
    const panel = yield* View.make({ backgroundColor: "#202020", borderRadius: 6 }).pipe(
      Scope.provide(panelScope),
    );
    const logo = yield* ImageView.make().pipe(Scope.provide(panelScope));
    const inner = yield* WebContentsView.make({ session }).pipe(Scope.provide(panelScope));
    const panelAttachment = yield* host.attach(panel, {
      bounds: { x: 0, y: 0, width: 300, height: 600 },
    });
    assert.equal(hostNative.contentView.children.length, 1);
    const logoAttachment = yield* panel.attach(logo, {
      bounds: { x: 16, y: 16, width: 48, height: 48 },
    });
    yield* panel.attach(inner, { bounds: { x: 0, y: 80, width: 300, height: 520 } });
    const panelNative = hostNative.contentView.children[0];
    assert.equal(panelNative.children.length, 2);
    expectCode(
      yield* Effect.exit(host.attach(panel, { bounds: { x: 0, y: 0, width: 1, height: 1 } })),
      "Protocol",
    );
    expectCode(yield* Effect.exit(logo.setImage("/nonexistent/logo.png")), "Protocol");
    expectCode(
      yield* Effect.exit(Effect.scoped(ImageView.make({ image: "/nonexistent/logo.png" }))),
      "Protocol",
    );
    expectCode(yield* Effect.exit(Effect.scoped(View.make({ borderRadius: -1 }))), "Protocol");
    yield* panel.setBackgroundColor("#101010");
    yield* logoAttachment.setBounds({ x: 16, y: 16, width: 64, height: 64 });
    assert.deepEqual(panelNative.children[0].getBounds(), { x: 16, y: 16, width: 64, height: 64 });
    yield* logoAttachment.detach;
    assert.equal(panelNative.children.length, 1);
    expectCode(yield* Effect.exit(logoAttachment.setVisible(false)), "Closed");
    yield* host.attach(logo, { bounds: { x: 400, y: 0, width: 48, height: 48 } });
    assert.equal(hostNative.contentView.children.length, 2);
    record("container and image views attach, nest, reparent, and validate their inputs", {
      hostChildren: hostNative.contentView.children.length,
      panelChildren: panelNative.children.length,
    });

    const pngBytes = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const bytesScope = yield* Scope.fork(yield* Effect.scope);
    const bytesLogo = yield* ImageView.make({ image: pngBytes }).pipe(Scope.provide(bytesScope));
    yield* host.attach(bytesLogo, { bounds: { x: 460, y: 0, width: 32, height: 32 } });
    assert.equal(hostNative.contentView.children.length, 3);
    const invalidBytes = new Uint8Array([1, 2, 3]);
    expectCode(yield* Effect.exit(bytesLogo.setImage(invalidBytes)), "Protocol");
    record("an image view shows a PNG decoded from bytes and rejects unreadable image bytes", {
      pngBytes: pngBytes.byteLength,
      hostChildren: hostNative.contentView.children.length,
    });
    yield* Scope.close(bytesScope, Exit.void);
    yield* bytesLogo.awaitClosed;
    assert.equal(hostNative.contentView.children.length, 2);

    yield* Scope.close(panelScope, Exit.void);
    yield* panel.awaitClosed;
    yield* inner.awaitClosed;
    yield* logo.awaitClosed;
    assert.equal(hostNative.contentView.children.length, 0);
    expectCode(yield* Effect.exit(panelAttachment.setVisible(false)), "Closed");
    expectCode(yield* Effect.exit(panel.setBackgroundColor("#000")), "Closed");
    yield* host.close;
    yield* host.awaitClosed;
    record("closing a container closes the views nested inside it and detaches everything", {
      hostDestroyed: hostNative.isDestroyed(),
    });
  }
  {
    const scope = yield* Scope.fork(yield* Effect.scope);
    const owner = yield* BaseWindow.make({ title: "Closing container", show: false });
    const nativeOwner = NativeBaseWindow.getAllWindows().find(
      (value) => value.getTitle() === "Closing container",
    );
    assert.ok(nativeOwner);
    const panel = yield* View.make().pipe(Scope.provide(scope));
    const pane = yield* WebContentsView.make();
    const replacement = yield* View.make();
    const bounds = { x: 0, y: 0, width: 100, height: 100 };
    const attachment = yield* owner.attach(panel, { bounds });
    yield* panel.attach(pane, { bounds });
    const nativePanel = nativeOwner.contentView.children[0];
    const nativePane = nativePanel.children[0].webContents;
    const close = nativePane.close;
    const started = Deferred.makeUnsafe();
    nativePane.close = () => {
      Deferred.doneUnsafe(started, Effect.void);
    };
    const closing = yield* Effect.forkChild(panel.close);
    yield* Effect.gen(function* () {
      yield* Deferred.await(started);
      const attempt = yield* Effect.exit(panel.attach(replacement, { bounds }));
      assert.equal(attempt._tag, "Failure", "closing panel must reject another child");
      assert.equal(Cause.squash(attempt.cause).code, "Closed");
      const read = yield* Effect.exit(attachment.current);
      assert.equal(read._tag, "Failure", "attachment cannot remain usable during parent cleanup");
      assert.equal(Cause.squash(read.cause).code, "Closed");
      const setting = yield* Effect.exit(panel.setBackgroundColor("#000"));
      assert.equal(setting._tag, "Failure");
      assert.equal(Cause.squash(setting.cause).code, "Closed");
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          nativePane.close = close;
          close.call(nativePane);
        }),
      ),
    );
    const closed = yield* Fiber.await(closing);
    assert.equal(closed._tag, "Success");
    yield* panel.awaitClosed;
    yield* pane.awaitClosed;
    assert.equal(nativePanel.children.length, 0);
    assert.equal(nativeOwner.contentView.children.length, 0);
    yield* replacement.setBackgroundColor("#333");
    yield* replacement.close;
    yield* Scope.close(scope, Exit.void);
    yield* owner.close;
    yield* owner.awaitClosed;
    record(
      "a closing container refuses new children and operations while native destruction waits",
    );
  }
  {
    const owner = yield* BaseWindow.make({ show: false });
    const observing = yield* Effect.forkScoped(Stream.runDrain(owner.touchBar.interactions));
    yield* Effect.sleep(10);
    yield* owner.close;
    yield* owner.awaitClosed;
    const ended = yield* Effect.exit(Fiber.await(observing).pipe(Effect.timeout(1000)));
    assert.equal(ended._tag, "Success", "touch bar observation must end with its window");
    record("touch bar observation ends with native window closure");
  }
});

App.run(
  [],
  Effect.gen(function* () {
    yield* App.decide(
      Decidables.App.LastWindowClosed,
      Decision.sync(() => "stay"),
    );
    const result = yield* Effect.exit(run);
    console.log(
      `NATIVE_VIEWS_VERIFICATION ${JSON.stringify({
        success: result._tag === "Success",
        checks,
        error: result._tag === "Failure" ? Cause.pretty(result.cause) : undefined,
      })}`,
    );
    if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
    yield* App.quit;
  }),
);
