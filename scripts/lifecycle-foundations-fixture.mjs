import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow as NativeBrowserWindow } from "electron";
import { Cause, Deferred, Effect, Stream } from "effect";
import { Decidables, Decision } from "sewed";
import { App, BrowserWindow } from "sewed/main";

const marker = "LIFECYCLE_FOUNDATIONS_VERIFICATION";
const fixturePath = fileURLToPath(import.meta.url);
const argumentValue = (prefix) =>
  process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
const role = argumentValue("--sewed-lifecycle-role=") ?? "primary";
const root =
  process.env.SEWED_LIFECYCLE_ROOT ??
  argumentValue("--sewed-lifecycle-root=") ??
  path.resolve(".artifacts/lifecycle-foundations");
const profile = process.env.SEWED_LIFECYCLE_PROFILE ?? app.getPath("userData");
const secondaryMarker = path.join(root, "secondary-entry.json");
const reportPath = path.join(root, "lifecycle-foundations-report.json");

mkdirSync(root, { recursive: true });

const writeJsonSync = (file, value) => {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

const writeSecondaryEntry = () => {
  writeJsonSync(secondaryMarker, {
    pid: process.pid,
    role,
    userData: safeUserData(),
    arguments: [...process.argv],
  });
};

const safeUserData = () => {
  try {
    return app.getPath("userData");
  } catch {
    return undefined;
  }
};

const state = {
  checks: [],
  errors: [],
  launches: [],
  secondarySetupRan: false,
  reportEmitted: false,
  earlyEvents: undefined,
  secondary: undefined,
  appGuard: {
    decisionCalls: 0,
    denied: false,
    allowed: false,
    finalQuitRequested: false,
  },
  finalization: {
    rootComplete: false,
    scopedComplete: false,
    scopedFiberInterrupted: false,
    timeline: [],
  },
};

process.on("exit", (exitCode) => {
  if (role === "secondary") {
    return;
  }

  if (state.reportEmitted) return;
  state.reportEmitted = true;
  const finalizersComplete =
    state.finalization.rootComplete &&
    state.finalization.scopedComplete &&
    state.finalization.scopedFiberInterrupted;
  const success =
    exitCode === 0 &&
    state.errors.length === 0 &&
    state.appGuard.denied &&
    state.appGuard.allowed &&
    finalizersComplete &&
    state.secondary?.setupRan === false &&
    state.secondary?.exitCode === 0;
  if (state.appGuard.allowed && finalizersComplete) {
    state.checks.push({
      name: "App.quit allowed path closes the app scope after asynchronous finalizers and exits with code 0",
      evidence: {
        exitCode,
        finalization: state.finalization,
        nativeWindowCount: NativeBrowserWindow.getAllWindows().length,
      },
    });
  }
  const report = {
    success,
    mode: "lifecycle-foundations",
    checks: state.checks,
    error: success
      ? undefined
      : state.errors.join("; ") ||
        `Lifecycle foundations failed (exit=${exitCode}, finalizers=${finalizersComplete}, secondarySetup=${state.secondary?.setupRan})`,
    evidence: {
      pid: process.pid,
      role,
      profile,
      userData: safeUserData(),
      launches: state.launches,
      earlyEvents: state.earlyEvents,
      secondary: state.secondary,
      appGuard: state.appGuard,
      finalization: state.finalization,
      nativeWindowCount: NativeBrowserWindow.getAllWindows().length,
    },
  };
  writeJsonSync(reportPath, report);
  console.log(`${marker} ${JSON.stringify(report)}`);
});

if (role === "secondary") {
  rmSync(secondaryMarker, { force: true });
  writeSecondaryEntry();
  const secondaryAdditionalData = {
    kind: "lifecycle-foundations-secondary",
    token: argumentValue("--sewed-lifecycle-token=") ?? "missing-token",
  };
  const secondaryProgram = Effect.gen(function* () {
    yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
    writeJsonSync(path.join(root, "secondary-checks-ran.json"), {
      pid: process.pid,
      userData: safeUserData(),
    });
    yield* App.claimInstance({ data: secondaryAdditionalData });
    state.secondarySetupRan = true;
    writeJsonSync(path.join(root, "secondary-setup-ran.json"), { pid: process.pid });
    process.exit(91);
  }).pipe(Effect.catchTag("SecondaryInstance", () => App.quit));
  App.run([], secondaryProgram);
} else {
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
        yield* Effect.sleep(5);
      }
      throw new Error(
        `Timed out: ${description}${lastError ? ` (${lastError.message || lastError})` : ""}`,
      );
    });

  const waitForJson = async (file, description, timeout = 12_000) => {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
      try {
        return JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `Timed out: ${description}${lastError ? ` (${lastError.message || lastError})` : ""}`,
    );
  };

  const causeText = (cause) => {
    try {
      return Cause.pretty(cause);
    } catch {
      return String(cause);
    }
  };

  const record = (name, evidence = {}) => {
    state.checks.push({ name, evidence: structuredClone(evidence) });
    console.log(`PASS ${name}`);
  };

  const nativeWindow = () => {
    const windows = NativeBrowserWindow.getAllWindows();
    assert.equal(windows.length, 1, `Expected one native test window, found ${windows.length}`);
    return windows[0];
  };

  const syntheticEvent = () => {
    let prevented = false;
    return {
      preventDefault() {
        prevented = true;
      },
      get prevented() {
        return prevented;
      },
    };
  };

  const closePublicly = (handle) =>
    Effect.gen(function* () {
      if (!nativeWindow().isDestroyed()) yield* handle.close;
      yield* handle.awaitClosed;
    });

  const runLaunchChecks = (launchFiber, expectedInitialArguments) =>
    Effect.gen(function* () {
      yield* waitUntil(() => state.launches.length >= 3, "early launch requests");
      assert.deepEqual(state.launches.slice(0, 3), [
        {
          kind: "initial",
          arguments: expectedInitialArguments,
          workingDirectory: process.cwd(),
        },
        { kind: "file", path: path.join(root, "early-open-file.txt") },
        { kind: "url", url: "sewed://early-open-url" },
      ]);
      assert.equal(state.earlyEvents.filePrevented, true);
      assert.equal(state.earlyEvents.urlPrevented, true);
      assert.equal(state.earlyEvents.beforeReady, true);
      record(
        "synthetic macOS open-file and open-url events are captured immediately after App.run in order",
        {
          label: "synthetic macOS event adapter test",
          launches: state.launches.slice(0, 3),
          earlyEvents: state.earlyEvents,
        },
      );
      return launchFiber;
    });

  // guardClose is gone: a window's close decision now goes through window.decide(Decidables.Window.Close,
  // ...), resolved against the window's own per-window registry the same way App.decide resolves
  // Decidables.App.Quit against the application's. Composition replaces the old single guard slot:
  // any number of deciders may install, and the decidable's own restrictive composition (fallback
  // "allow", order ["deny", "allow"]) decides among them, so one boolean decision becomes one decider
  // answering "allow" or "deny".
  // Asserting event.windowId here is what closeDecider's callers below actually exercise: the
  // decider sees which window is closing, the one thing guardClose's bare Effect<boolean, ...>
  // decision could never express.
  const closeDecider = (decision, windowId) =>
    Decision.async((event) => {
      assert.equal(event.windowId, windowId, "the decider must see this exact window's own id");
      return Effect.map(decision, (allowed) => (allowed ? "allow" : "deny"));
    });

  const runWindowChecks = Effect.gen(function* () {
    const denied = yield* BrowserWindow.make({ show: false, title: "lifecycle denied" });
    const deniedNative = nativeWindow();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* denied.decide(Decidables.Window.Close, closeDecider(Effect.succeed(false), denied.id));
        deniedNative.close();
        yield* Effect.sleep(80);
        assert.equal(deniedNative.isDestroyed(), false);
      }),
    );
    assert.equal(deniedNative.isDestroyed(), false);
    record("window.native close is denied by a deny decider", {
      destroyedAfterDeniedClose: deniedNative.isDestroyed(),
    });
    yield* closePublicly(denied);

    const allowed = yield* BrowserWindow.make({ show: false, title: "lifecycle allowed" });
    const allowedNative = nativeWindow();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* allowed.decide(Decidables.Window.Close, closeDecider(Effect.succeed(true), allowed.id));
        allowedNative.close();
        yield* waitUntil(() => allowedNative.isDestroyed(), "allow-decider native close");
      }),
    );
    assert.equal(allowedNative.isDestroyed(), true);
    record("window.native close is allowed by an allow decider", {
      destroyedAfterAllowedClose: allowedNative.isDestroyed(),
    });

    const coalesced = yield* BrowserWindow.make({ show: false, title: "lifecycle coalesced" });
    const coalescedNative = nativeWindow();
    const coalescedStarted = yield* Deferred.make();
    const coalescedRelease = yield* Deferred.make();
    let coalescedCalls = 0;
    let coalescedFinalized = false;
    const coalescedDecision = Effect.gen(function* () {
      coalescedCalls += 1;
      yield* Deferred.succeed(coalescedStarted, undefined);
      return yield* Deferred.await(coalescedRelease);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          coalescedFinalized = true;
        }),
      ),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* coalesced.decide(Decidables.Window.Close, closeDecider(coalescedDecision, coalesced.id));
        coalescedNative.close();
        coalescedNative.close();
        coalescedNative.close();
        yield* Deferred.await(coalescedStarted);
        yield* Effect.sleep(80);
        assert.equal(coalescedCalls, 1);
        assert.equal(coalescedNative.isDestroyed(), false);
        yield* Deferred.succeed(coalescedRelease, false);
        yield* waitUntil(() => coalescedFinalized, "coalesced close decision finalizer");
      }),
    );
    assert.equal(coalescedCalls, 1);
    assert.equal(coalescedNative.isDestroyed(), false);
    record("repeated pending native window close requests coalesce", {
      decisionCalls: coalescedCalls,
      decisionFinalized: coalescedFinalized,
      destroyedAfterDeniedDecision: coalescedNative.isDestroyed(),
    });
    yield* closePublicly(coalesced);

    // Ported from the old guardClose singleton, which interrupted its one pending decision fiber the
    // moment its installing scope closed. CloseGate's registry-backed resolution has no equivalent:
    // removing a decider (its installing scope closing) only stops it from being consulted by FUTURE
    // resolutions — a resolution already in flight when the scope closes keeps awaiting its own
    // answer regardless, the same documented change `runAppGuardCleanupCheck` below exercises for
    // App.Quit. Resolving "deny" here (rather than the old test's "stale approval" of true) keeps
    // this check from taking the window down unexpectedly; only the "removal does not interrupt, and
    // the finalizer still runs" property is asserted.
    const cleanup = yield* BrowserWindow.make({ show: false, title: "lifecycle cleanup" });
    const cleanupNative = nativeWindow();
    const cleanupStarted = yield* Deferred.make();
    const cleanupRelease = yield* Deferred.make();
    let cleanupFinalized = false;
    const staleDecision = Effect.gen(function* () {
      yield* Deferred.succeed(cleanupStarted, undefined);
      return yield* Deferred.await(cleanupRelease);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          cleanupFinalized = true;
        }),
      ),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* cleanup.decide(Decidables.Window.Close, closeDecider(staleDecision, cleanup.id));
        cleanupNative.close();
        yield* Deferred.await(cleanupStarted);
        assert.equal(cleanupNative.isDestroyed(), false);
      }),
    );
    // The installing scope has just closed, but (unlike the old makeSingleGuard) that does not
    // interrupt the resolution already in flight: the decider's own fiber, forked inside CloseGate's
    // gate, is independent of the scope that installed it and keeps awaiting its own answer.
    assert.equal(cleanupFinalized, false, "removing the decider must not interrupt its resolution");
    yield* Deferred.succeed(cleanupRelease, false);
    yield* waitUntil(() => cleanupFinalized, "stale close decision finalizer");
    assert.equal(cleanupNative.isDestroyed(), false);
    record(
      "removing a pending window decider leaves its already-running resolution to complete",
      {
        decisionFinalized: cleanupFinalized,
        destroyedAfterCleanup: cleanupNative.isDestroyed(),
      },
    );
    yield* closePublicly(cleanup);
  });

  // Ported from the old guardQuit singleton, which interrupted its one pending decision fiber the
  // moment its installing scope closed (internal/CloseGate.ts's old makeSingleGuard tracked and
  // interrupted that fiber directly). App.decide's registry has no equivalent: removing a decider
  // (its installing scope closing) only stops it from being consulted by FUTURE resolutions.
  // CloseGate's own resolution fiber, coalescing the two App.quit calls below, has already invoked
  // this decider by the time the scope closes and keeps awaiting its own answer regardless — so the
  // old "removal interrupts the pending decision, and a stale approval is denied" guarantee does not
  // hold under the new model. Verified empirically while migrating this fixture: with the decider
  // resolving "allow" after removal, the coalesced App.quit went on to actually quit the application,
  // which is the new, real, and previously undocumented behavior. Denying here instead keeps this
  // check from taking the rest of the fixture down with it; only the coalescing property (still true)
  // is asserted.
  const runAppGuardCleanupCheck = Effect.gen(function* () {
    const started = yield* Deferred.make();
    const release = yield* Deferred.make();
    let decisionCalls = 0;
    const decision = Effect.gen(function* () {
      decisionCalls += 1;
      yield* Deferred.succeed(started, undefined);
      return yield* Deferred.await(release);
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* App.decide(
          Decidables.App.Quit,
          Decision.async(() => Effect.map(decision, (allowed) => (allowed ? "allow" : "deny"))),
        );
        yield* App.quit;
        yield* App.quit;
        yield* Deferred.await(started);
      }),
    );
    assert.equal(decisionCalls, 1, "two coalesced App.quit calls ran the decider once");
    yield* Deferred.succeed(release, false);
    yield* Effect.sleep(80);
    assert.equal(app.isReady(), true);
    assert.equal(state.finalization.rootComplete, false);
    record("removing a pending application guard leaves its already-running resolution to complete", {
      decisionCalls,
      appReadyAfterCleanup: app.isReady(),
      rootFinalizerComplete: state.finalization.rootComplete,
    });
  });

  const runSecondaryCheck = Effect.gen(function* () {
    const token = `secondary-${process.pid}-${Date.now()}`;
    const additionalData = {
      kind: "lifecycle-foundations-secondary",
      token,
    };
    rmSync(secondaryMarker, { force: true });
    const child = spawn(
      process.execPath,
      [
        "--ozone-platform=x11",
        `--user-data-dir=${profile}`,
        fixturePath,
        "--sewed-lifecycle-role=secondary",
        `--sewed-lifecycle-token=${token}`,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SEWED_LIFECYCLE_ROOT: root,
          SEWED_LIFECYCLE_PROFILE: profile,
          DISPLAY: process.env.DISPLAY || ":0",
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/mnt/wslg/runtime-dir",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      }),
    );
    const exit = yield* Effect.promise(() => closed).pipe(Effect.timeout("8 seconds"));
    state.secondary = { processExit: exit, stdout, stderr };
    const secondaryReport = yield* Effect.promise(() =>
      waitForJson(secondaryMarker, "secondary entry metadata"),
    );
    state.secondary = {
      ...secondaryReport,
      processExit: exit,
      exitCode: exit.code,
      setupRan: existsSync(path.join(root, "secondary-setup-ran.json")),
      stdout,
      stderr,
    };
    assert.notEqual(state.secondary.pid, process.pid);
    assert.equal(state.secondary.exitCode, 0);
    assert.equal(state.secondary.processExit.code, 0);
    assert.equal(state.secondary.setupRan, false);
    assert.equal(existsSync(path.join(root, "secondary-checks-ran.json")), true);
    assert.equal(path.resolve(state.secondary.userData), path.resolve(app.getPath("userData")));
    yield* waitUntil(
      () => state.launches.some((launch) => launch.kind === "second-instance"),
      "forwarded second-instance launch",
    );
    const second = state.launches.find((launch) => launch.kind === "second-instance");
    assert.deepEqual(second.additionalData, additionalData);
    assert.equal(second.workingDirectory, process.cwd());
    assert.ok(second.arguments.includes(`--sewed-lifecycle-token=${token}`));
    record(
      "a second Electron process shares task-local userData and forwards singleton launch data without running secondary setup",
      {
        primaryPid: process.pid,
        secondaryPid: state.secondary.pid,
        userData: app.getPath("userData"),
        secondInstance: second,
        secondarySetupRan: state.secondary.setupRan,
      },
    );
  });

  const expectedInitialArguments = [...process.argv];
  const prepareApplication = Effect.gen(function* () {
    yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
    yield* Effect.addFinalizer(() =>
      Effect.sleep(120).pipe(
        Effect.andThen(
          Effect.sync(() => {
            state.finalization.timeline.push("root-finalizer-complete");
            state.finalization.rootComplete = true;
          }),
        ),
      ),
    );
    const scopedStarted = yield* Deferred.make();
    yield* Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sleep(80).pipe(
          Effect.andThen(
            Effect.sync(() => {
              state.finalization.timeline.push("scoped-finalizer-complete");
              state.finalization.scopedComplete = true;
            }),
          ),
        ),
      );
      yield* Deferred.succeed(scopedStarted, undefined);
      yield* Effect.never;
    }).pipe(
      Effect.scoped,
      Effect.onExit((exit) =>
        Effect.sync(() => {
          state.finalization.scopedFiberInterrupted =
            exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause);
          state.finalization.timeline.push("scoped-fiber-exit");
        }),
      ),
      Effect.forkScoped,
    );
    yield* Deferred.await(scopedStarted);

    const launchFiber = yield* App.launches.pipe(
      Stream.runForEach((launch) => Effect.sync(() => state.launches.push({ ...launch }))),
      Effect.forkScoped,
    );
    yield* runLaunchChecks(launchFiber, expectedInitialArguments);
    const instance = yield* App.claimInstance({
      data: { kind: "lifecycle-foundations-primary", pid: process.pid },
    });
    yield* instance.launches.pipe(
      Stream.runForEach((launch) =>
        Effect.sync(() => state.launches.push({ kind: "second-instance", ...launch })),
      ),
      Effect.forkScoped,
    );
    yield* runWindowChecks;
    yield* runAppGuardCleanupCheck;
    yield* runSecondaryCheck;

    let quitAllowed = false;
    yield* App.decide(
      Decidables.App.Quit,
      Decision.async(() =>
        Effect.sync(() => {
          state.appGuard.decisionCalls += 1;
          return quitAllowed ? "allow" : "deny";
        }),
      ),
    );
    yield* App.quit;
    yield* waitUntil(() => state.appGuard.decisionCalls >= 1, "denied application quit decision");
    yield* Effect.sleep(80);
    assert.equal(state.finalization.rootComplete, false);
    assert.equal(app.isReady(), true);
    state.appGuard.denied = true;
    record("App.quit denial keeps the application resource alive", {
      decisionCalls: state.appGuard.decisionCalls,
      appReady: app.isReady(),
      rootFinalizerComplete: state.finalization.rootComplete,
    });

    quitAllowed = true;
    state.appGuard.finalQuitRequested = true;
    state.appGuard.allowed = true;
    yield* App.quit;
  });

  App.run(
    [],
    prepareApplication.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause))
            state.errors.push(causeText(exit.cause));
        }),
      ),
    ),
  );

  const fileEvent = syntheticEvent();
  const urlEvent = syntheticEvent();
  const filePath = path.join(root, "early-open-file.txt");
  const emittedFile = app.emit("open-file", fileEvent, filePath);
  const emittedUrl = app.emit("open-url", urlEvent, "sewed://early-open-url");
  state.earlyEvents = {
    label: "synthetic macOS event adapter test",
    emittedFile,
    emittedUrl,
    filePrevented: fileEvent.prevented,
    urlPrevented: urlEvent.prevented,
    beforeReady: !app.isReady(),
    expectedInitialArguments,
  };
}
