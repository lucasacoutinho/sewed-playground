import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, nativeTheme, powerMonitor } from "electron";
import { Cause, Effect, Exit, Fiber, Redacted, Schema, Scope, Stream } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import {
  Binding,
  Clipboard as ClipboardData,
  Decidables,
  Decision,
  NativeTheme as NativeThemeData,
  Notification as NotificationData,
  PowerMonitor as PowerMonitorData,
  Shell as ShellData,
} from "sewed";
import * as Testing from "sewed/testing";

const pngPixel = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

async function verifySurfaces() {
  await app.whenReady();
  const {
    App,
    Capability,
    Clipboard,
    NativeTheme,
    Notification,
    PowerMonitor,
    SafeStorage,
    Shell,
  } = await import("sewed/main");

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
        yield* Effect.sleep(5);
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
  const bound = (slot, owner, body) =>
    Effect.gen(function* () {
      const client = yield* slot();
      return yield* body(client);
    }).pipe(Effect.provide(Binding.layer([Binding.to(slot, owner)])));
  const hosted = (acquire) =>
    Effect.gen(function* () {
      const scope = yield* Scope.fork(yield* Effect.scope);
      const owner = yield* acquire.pipe(Scope.provide(scope));
      return { owner, close: Scope.close(scope, Exit.void) };
    });

  const Theme = NativeThemeData.capability.slot;
  const Power = PowerMonitorData.capability.slot;
  const Notifications = NotificationData.capability.slot;
  const Paste = ClipboardData.capability.slot;

  const theme = Effect.gen(function* () {
    const updatedListeners = nativeTheme.listenerCount("updated");
    nativeTheme.themeSource = "system";
    const initial = yield* NativeTheme.current;
    assert.equal(initial.source, "system");
    const states = yield* observe(NativeTheme.state);
    yield* waitUntil(() => states.values.length === 1, "replayed theme state");
    assert.deepEqual(states.values[0], initial);
    yield* NativeTheme.setSource("dark");
    yield* waitUntil(
      () => states.values.some((state) => state.source === "dark" && state.shouldUseDarkColors),
      "dark theme state",
    );
    yield* NativeTheme.setSource("light");
    yield* waitUntil(
      () => states.values.some((state) => state.source === "light" && !state.shouldUseDarkColors),
      "light theme state",
    );
    yield* Fiber.interrupt(states.fiber);
    assert.equal(nativeTheme.listenerCount("updated"), updatedListeners);
    record("theme state replays the current theme and follows source changes", {
      states: states.values.map((state) => state.source),
    });

    const readOnly = yield* hosted(
      Capability.serve(NativeThemeData.capability).pipe(Effect.provide(NativeTheme.native())),
    );
    yield* bound(Theme, readOnly.owner, (client) =>
      Effect.gen(function* () {
        const remote = yield* observe(client.state());
        yield* waitUntil(() => remote.values.length === 1, "bound theme state");
        assert.equal(remote.values[0].source, "light");
        const denied = expectCode(
          yield* Effect.exit(client.setSource({ source: "dark" })),
          "Protocol",
        );
        assert.equal(nativeTheme.themeSource, "light");
        yield* Fiber.interrupt(remote.fiber);
        record("a read-only theme host serves state and denies source changes", {
          message: denied.message,
        });
      }),
    );
    yield* readOnly.close;
    const writable = yield* hosted(
      Capability.serve(NativeThemeData.capability).pipe(
        Effect.provide(NativeTheme.native({ allowSetSource: true })),
      ),
    );
    yield* bound(Theme, writable.owner, (client) =>
      Effect.gen(function* () {
        const remote = yield* observe(client.state());
        yield* client.setSource({ source: "dark" });
        yield* waitUntil(
          () => remote.values.some((state) => state.source === "dark"),
          "bound dark theme state",
        );
        yield* writable.close;
        const ended = yield* Fiber.await(remote.fiber);
        expectCode(ended, "Unknown");
        record("closing a theme host ends sent bound observers with Unknown", {
          sources: remote.values.map((state) => state.source),
        });
      }),
    );
    nativeTheme.themeSource = "system";
    assert.equal(nativeTheme.listenerCount("updated"), updatedListeners);
  });

  const power = Effect.gen(function* () {
    const counts = () => ({
      suspend: powerMonitor.listenerCount("suspend"),
      thermal: powerMonitor.listenerCount("thermal-state-change"),
    });
    const baseline = counts();
    const state = yield* PowerMonitor.state(60);
    assert.equal(typeof state.onBattery, "boolean");
    assert.ok(["active", "idle", "locked", "unknown"].includes(state.idleState));
    assert.ok(["unknown", "nominal", "fair", "serious", "critical"].includes(state.thermal));
    expectCode(yield* Effect.exit(PowerMonitor.state(0)), "Protocol");
    const events = yield* observe(PowerMonitor.events);
    yield* waitUntil(() => counts().suspend === baseline.suspend + 1, "power listener");
    powerMonitor.emit("suspend");
    powerMonitor.emit("on-battery");
    powerMonitor.emit("thermal-state-change", { state: "fair" });
    yield* waitUntil(() => events.values.length === 3, "synthetic power events");
    assert.deepEqual(events.values, [
      { kind: "suspend" },
      { kind: "power-source", onBattery: true },
      { kind: "thermal", state: "fair" },
    ]);
    yield* Fiber.interrupt(events.fiber);
    assert.deepEqual(counts(), baseline);
    record("power events register listeners per observer and release them on interruption", {
      state,
      events: events.values,
    });

    const owner = yield* hosted(
      Capability.serve(PowerMonitorData.capability).pipe(Effect.provide(PowerMonitor.native())),
    );
    yield* bound(Power, owner.owner, (client) =>
      Effect.gen(function* () {
        const snapshot = yield* client.state({ idleThresholdSeconds: 30 });
        assert.equal(typeof snapshot.idleSeconds, "number");
        const remote = yield* observe(client.events());
        yield* waitUntil(() => counts().suspend === baseline.suspend + 1, "bound power listener");
        powerMonitor.emit("resume");
        yield* waitUntil(() => remote.values.length === 1, "bound power event");
        assert.deepEqual(remote.values[0], { kind: "resume" });
        yield* owner.close;
        expectCode(yield* Fiber.await(remote.fiber), "Unknown");
        record("bound power events cross the boundary and end with Unknown on owner closure", {
          snapshot,
        });
      }),
    );
    assert.deepEqual(counts(), baseline);
  });

  const notifications = Effect.gen(function* () {
    const supported = yield* Notification.supported;
    expectCode(yield* Effect.exit(Effect.scoped(Notification.show({ title: "" }))), "Protocol");
    const scope = yield* Scope.fork(yield* Effect.scope);
    const handle = yield* Notification.show({
      title: "Sewed",
      body: "Wave one",
      actions: [{ id: "open", text: "Open" }],
    }).pipe(Scope.provide(scope));
    const events = yield* observe(handle.events);
    yield* Effect.sleep(50);
    yield* Scope.close(scope, Exit.void);
    const ended = yield* Fiber.await(events.fiber);
    assert.equal(ended._tag, "Success", Cause.pretty(ended.cause ?? Cause.empty));
    expectCode(yield* Effect.exit(handle.close), "Closed");
    expectCode(yield* Effect.exit(Effect.scoped(Stream.runDrain(handle.events))), "Closed");
    record("a notification lives in its scope, ends observers on close, and rejects late access", {
      supported,
      events: events.values,
    });

    const owner = yield* hosted(
      Capability.serve(NotificationData.capability).pipe(Effect.provide(Notification.native())),
    );
    yield* bound(Notifications, owner.owner, (client) =>
      Effect.gen(function* () {
        const remote = yield* observe(client.show({ title: "Sewed", body: "Bound" }));
        yield* Effect.sleep(50);
        yield* Fiber.interrupt(remote.fiber);
        assert.ok(
          remote.exit._tag === "Success" ||
            Cause.findErrorOption(remote.exit.cause)._tag === "None",
          remote.exit._tag === "Success" ? "" : Cause.pretty(remote.exit.cause),
        );
        expectCode(
          yield* Effect.exit(Effect.scoped(Stream.runDrain(client.show({ title: "" })))),
          "Protocol",
        );
        record("a bound notification request is one notification that interruption closes", {
          events: remote.values,
        });
      }),
    );
    yield* owner.close;
  });

  const clipboard = Effect.gen(function* () {
    yield* Clipboard.clear;
    yield* Clipboard.write({ kind: "text", text: "sewed clipboard" });
    assert.deepEqual(yield* Clipboard.read("text"), { kind: "text", text: "sewed clipboard" });
    assert.ok((yield* Clipboard.formats).includes("text"));
    yield* Clipboard.write({ kind: "html", html: "<b>sewed</b>", text: "sewed" });
    const html = yield* Clipboard.read("html");
    assert.equal(html.kind, "html");
    assert.ok(html.html.includes("<b>sewed</b>"), html.html);
    yield* Clipboard.write({ kind: "image", png: pngPixel });
    const image = yield* Clipboard.read("image");
    assert.equal(image.kind, "image");
    assert.ok(image.png.byteLength > 0);
    assert.equal(yield* Clipboard.read("rtf"), null);
    expectCode(
      yield* Effect.exit(Clipboard.write({ kind: "image", png: new Uint8Array(4) })),
      "Protocol",
    );
    yield* Clipboard.clear;
    assert.equal(yield* Clipboard.read("text"), null);
    record("clipboard round-trips text, html, and png bytes and reports absent formats as null", {
      formats: yield* Clipboard.formats,
    });

    yield* Effect.gen(function* () {
      const client = yield* ClipboardData.capability;
      const content = { kind: "html", html: "<b>allowed</b>", text: "denied" };
      const write = client.write({ content });
      content.kind = "text";
      expectCode(yield* Effect.exit(write), "Protocol");
      assert.equal(yield* Clipboard.read("text"), null);
      record("clipboard writes authorize the format present when their Effect runs");
    }).pipe(Effect.provide(Clipboard.native({ read: [], write: ["html"] })));

    const owner = yield* hosted(
      Capability.serve(ClipboardData.capability).pipe(
        Effect.provide(Clipboard.native({ read: ["text"], write: ["text"] })),
      ),
    );
    yield* bound(Paste, owner.owner, (client) =>
      Effect.gen(function* () {
        yield* client.write({ content: { kind: "text", text: "bound" } });
        assert.deepEqual(yield* client.read({ format: "text" }), { kind: "text", text: "bound" });
        assert.deepEqual(yield* client.formats(), ["text"]);
        expectCode(
          yield* Effect.exit(client.write({ content: { kind: "html", html: "<i>no</i>" } })),
          "Protocol",
        );
        expectCode(yield* Effect.exit(client.read({ format: "image" })), "Protocol");
        yield* client.clear();
        assert.equal(yield* client.read({ format: "text" }), null);
        record("a clipboard host applies its format policy to bound clients", {
          formats: yield* client.formats(),
        });
      }),
    );
    yield* owner.close;
  });

  const shell = Effect.gen(function* () {
    const root = mkdtempSync(join(tmpdir(), "sewed-shell-"));
    const native = Shell.native({
      policy: [{ kind: "origin", origin: "https://docs.example.com" }],
      paths: [root],
    });
    yield* Effect.gen(function* () {
      const capability = yield* ShellData.capability;
      expectCode(
        yield* Effect.exit(capability.openExternal({ url: "https://evil.example.com/" })),
        "Protocol",
      );
      expectCode(yield* Effect.exit(capability.openExternal({ url: "not a url" })), "Protocol");
      expectCode(yield* Effect.exit(capability.openPath({ path: "/etc/passwd" })), "Protocol");
      expectCode(yield* Effect.exit(capability.trashItem({ path: "relative.txt" })), "Protocol");
      expectCode(
        yield* Effect.exit(capability.showItemInFolder({ path: join(root, "..", "x") })),
        "Protocol",
      );
      yield* capability.beep({});
    }).pipe(Effect.provide(native));
    expectCode(
      yield* Effect.exit(
        Effect.scoped(
          Effect.provide(
            ShellData.capability,
            Shell.native({
              policy: [{ kind: "origin", origin: "https://a.example" }],
              paths: ["relative"],
            }),
          ),
        ),
      ),
      "Protocol",
    );
    record("shell operations deny URLs and paths outside their policy before Electron runs", {
      root,
    });

    // A grant admits one more path for exactly the caller's scope, on top of `paths: [root]`.
    // `showItemInFolder` on the granted path is exercised over `Testing.Shell.memory` rather than
    // the native Layer above: a real `shell.showItemInFolder` would ask the OS to open a file
    // manager, which this block already avoids for the allowed case above (see the match-pattern
    // comment further down) by deferring to the unit suite instead. `Testing.Shell.memory` runs the
    // very same `ShellPolicy.operations` code `Shell.native` does (`docs/testing.md`), so the grant
    // proven here through the recorder is the grant `Shell.native` honours for real.
    const grantMemory = Testing.Shell.memory({ policy: [], paths: [root] });
    const grantTarget = join(mkdtempSync(join(tmpdir(), "sewed-shell-grant-")), "diagnostics.zip");
    const grantOutcome = yield* Effect.gen(function* () {
      const capability = yield* ShellData.capability;
      const grants = yield* ShellData.Grants;
      const before = expectCode(
        yield* Effect.exit(capability.showItemInFolder({ path: grantTarget })),
        "Protocol",
      );
      const scope = yield* Scope.make();
      yield* grants.allow(grantTarget).pipe(Scope.provide(scope));
      yield* capability.showItemInFolder({ path: grantTarget });
      const recorder = yield* Testing.Recorder;
      const calls = yield* recorder.calls;
      yield* Scope.close(scope, Exit.void);
      const after = expectCode(
        yield* Effect.exit(capability.showItemInFolder({ path: grantTarget })),
        "Protocol",
      );
      return { before: before.message, after: after.message, calls };
    }).pipe(Effect.provide(grantMemory));
    // The recorder notes every call asked for, denials included (the same "denials included"
    // behaviour the clipboard and theme hosts above already rely on), so the refused "before" call
    // is here too; only the middle one, made while the grant's scope was open, is not a denial.
    assert.equal(grantOutcome.calls.length, 2, JSON.stringify(grantOutcome.calls));
    record(
      "a path outside the configured root is refused, accepted once a scope grants it, and refused again once the scope closes",
      grantOutcome,
    );

    const mail = Shell.native({ policy: [{ kind: "mailto", address: "support@example.com" }] });
    const recipients = yield* Effect.gen(function* () {
      const capability = yield* ShellData.capability;
      const multiRecipient = expectCode(
        yield* Effect.exit(
          capability.openExternal({ url: "mailto:support@example.com,other@example.com" }),
        ),
        "Protocol",
      );
      const ccRecipient = expectCode(
        yield* Effect.exit(
          capability.openExternal({ url: "mailto:support@example.com?cc=other@example.com" }),
        ),
        "Protocol",
      );
      return { multiRecipient: multiRecipient.message, ccRecipient: ccRecipient.message };
    }).pipe(Effect.provide(mail));
    record(
      "a mailto rule matches only its exact recipient, so a second recipient or a cc parameter fails Protocol",
      recipients,
    );

    // A match-pattern policy grants every http(s) URL. The allowed case (a pattern letting
    // openExternal through to the real native call) is covered by the unit suite against
    // ShellPolicy.operations and a recording core, not here: this fixture has no existing stub for
    // shell.openExternal on an allowed URL, and this block only ever exercised denials, so it stays
    // that way rather than actually asking the OS to open a browser during verification.
    const patterned = Shell.native({
      policy: ["*://*/*", { kind: "mailto", address: "support@example.com" }],
    });
    const patternDenials = yield* Effect.gen(function* () {
      const capability = yield* ShellData.capability;
      const credentialed = expectCode(
        yield* Effect.exit(capability.openExternal({ url: "https://user:pass@example.com/" })),
        "Protocol",
      );
      const impersonated = expectCode(
        yield* Effect.exit(capability.openExternal({ url: "https://example.com@evil.example/" })),
        "Protocol",
      );
      const script = expectCode(
        yield* Effect.exit(capability.openExternal({ url: "javascript:alert(1)" })),
        "Protocol",
      );
      return {
        credentialed: credentialed.message,
        impersonated: impersonated.message,
        script: script.message,
      };
    }).pipe(Effect.provide(patterned));
    assert.match(patternDenials.credentialed, /credentials/);
    assert.match(patternDenials.impersonated, /credentials/);
    expectCode(
      yield* Effect.exit(
        Effect.scoped(
          Effect.provide(ShellData.capability, Shell.native({ policy: ["<all_urls>"] })),
        ),
      ),
      "Protocol",
    );
    // `file` is not a pattern scheme: its path would be matched against the URL as written, and a
    // percent-encoded separator reaches it undecoded, so it fails while the Layer builds too.
    expectCode(
      yield* Effect.exit(
        Effect.scoped(
          Effect.provide(ShellData.capability, Shell.native({ policy: ["file:///tmp/*"] })),
        ),
      ),
      "Protocol",
    );
    record(
      "a match-pattern shell policy refuses credentials whatever the rule and refuses <all_urls> and file schemes at Layer build",
      patternDenials,
    );

    // Serving the native Layer is what a renderer binds to, so the policy above is the policy here.
    const owner = yield* hosted(
      Capability.serve(ShellData.capability).pipe(Effect.provide(native)),
    );
    yield* bound(ShellData.capability.slot, owner.owner, (client) =>
      Effect.gen(function* () {
        const denied = expectCode(
          yield* Effect.exit(client.openExternal({ url: "https://evil.example.com/" })),
          "Protocol",
        );
        expectCode(yield* Effect.exit(client.openPath({ path: "/etc" })), "Protocol");
        record("a served shell capability carries the same policy to bound clients", {
          message: denied.message,
        });
      }),
    );

    // A served Shell has no `allow` operation. This file is plain JS — nothing here type-checks —
    // so `@ts-expect-error` cannot prove it; instead, a renderer whose own idea of the protocol
    // names an `allow` operation (a forged or stale generated client, say) tries to bind to the
    // very same owner. `Binding.to` refuses by protocol identity, not by inspecting each RPC, so a
    // minimal forged group naming just `allow` gets the identical, typed refusal a fuller one
    // would: the transport's own runtime check, not merely a type the compiler happens to reject.
    const forgedShell = Capability.define(
      "shell",
      RpcGroup.make(Rpc.make("allow", { payload: { path: Schema.String } })),
    );
    const bindRefusal = expectCode(
      yield* Effect.exit(
        Effect.try({
          try: () => Binding.to(forgedShell.slot, owner.owner),
          catch: (cause) => cause,
        }),
      ),
      "Protocol",
    );
    record("a renderer's protocol naming an allow operation cannot bind to the served shell", {
      message: bindRefusal.message,
    });

    yield* owner.close;
  });

  const safeStorage = Effect.gen(function* () {
    yield* SafeStorage.allowPlainText;
    const availability = yield* SafeStorage.availability;
    assert.equal(availability.available, true);
    if (process.platform === "linux") assert.equal(availability.backend, "basic_text");
    const sealed = yield* SafeStorage.encrypt(Redacted.make("wave one secret"));
    assert.equal(sealed.version, 1);
    assert.equal(sealed.backend, availability.backend);
    assert.ok(sealed.bytes.byteLength > 0);
    const opened = yield* SafeStorage.decrypt(sealed);
    assert.equal(Redacted.value(opened), "wave one secret");
    assert.equal(String(opened).includes("wave one"), false);
    expectCode(yield* Effect.exit(SafeStorage.decrypt({ ...sealed, version: 2 })), "Protocol");
    record("safe storage round-trips a redacted secret through a sealed value", {
      backend: sealed.backend,
      bytes: sealed.bytes.byteLength,
    });
  });

  const runChecks = Effect.scoped(
    Effect.gen(function* () {
      yield* theme;
      yield* power;
      yield* notifications;
      yield* clipboard;
      yield* shell;
      yield* safeStorage;
    }),
  );

  App.run(
    [],
    Effect.gen(function* () {
      yield* App.decide(
        Decidables.App.LastWindowClosed,
        Decision.sync(() => "stay"),
      );
      const result = yield* Effect.exit(runChecks);
      console.log(
        `SURFACES_VERIFICATION ${JSON.stringify({
          success: result._tag === "Success",
          checks,
          error: result._tag === "Failure" ? Cause.pretty(result.cause) : undefined,
          platform: { os: process.platform, ozone: "x11", passwordStore: "basic" },
        })}`,
      );
      if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
      yield* App.quit;
    }),
  );
}

void verifySurfaces().catch((error) => {
  console.error(error);
  app.exit(1);
});
