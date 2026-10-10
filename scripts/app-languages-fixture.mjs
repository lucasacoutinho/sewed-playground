import assert from "node:assert/strict";
import { app, BrowserWindow as NativeBrowserWindow } from "electron";
import { Cause, Effect } from "effect";
import { App, BrowserWindow, CommandLine } from "sewed/main";

const windowTitle = "Sewed app languages";

const checks = [];
const record = (name, evidence = {}) => {
  checks.push({ name, evidence: structuredClone(evidence) });
  console.log(`PASS ${name}`);
};

// Task 4, ruling 7: `App.preferredSystemLanguages()` runs synchronously inside the declaration
// thunk -- before Electron is ready and before any Effect runs -- so its first entry can become
// the `--lang` switch `CommandLine.declare` applies before readiness. The verifier sets
// `LANGUAGE=fr` on this process's own environment (see verify-app.mjs), so the OS-reported
// preferred language is "fr" (ruling 7's own probe: `getPreferredSystemLanguages()` answers
// `["fr"]` under `LANGUAGE=fr`).
let declaredLanguage;

const runChecks = Effect.gen(function* () {
  yield* BrowserWindow.make({ show: false, width: 200, height: 200, title: windowTitle });
  const native = NativeBrowserWindow.getAllWindows().find(
    (candidate) => candidate.getTitle() === windowTitle,
  );
  assert.ok(native, "the native window backing the Sewed handle");
  // A fresh BrowserWindow has never navigated, and `executeJavaScript` never settles against a
  // document that has not: an explicit `loadURL` gives the renderer a real document and a
  // `did-finish-load` to attach to before evaluating anything in it.
  yield* Effect.promise(() => native.webContents.loadURL("about:blank"));
  const rendererLanguage = yield* Effect.promise(() =>
    native.webContents.executeJavaScript("navigator.language"),
  );
  assert.equal(declaredLanguage, "fr", "the declaration thunk must have read the OS's own value");
  assert.ok(
    rendererLanguage.toLowerCase().startsWith("fr"),
    `expected navigator.language to reflect --lang=${declaredLanguage}, got ${rendererLanguage}`,
  );
  record("App.preferredSystemLanguages(), read before readiness, reaches the renderer's --lang", {
    declaredLanguage,
    rendererLanguage,
    commandLineSwitch: app.commandLine.getSwitchValue("lang"),
  });
});

// `App.run` is called synchronously, in this module's own first pass, with no `await` anywhere
// before it: the declaration list here is non-empty (`CommandLine.declare`), so the entry rule
// from sewed-round-two's Task 3 applies for real -- reached only after an await, this would be
// refused outright once Electron is already ready.
function main() {
  App.run(
    [
      () => {
        declaredLanguage = App.preferredSystemLanguages()[0];
        return CommandLine.declare({ name: "lang", value: declaredLanguage });
      },
    ],
    Effect.gen(function* () {
      const result = yield* Effect.exit(runChecks);
      console.log(
        `APP_LANGUAGES_VERIFICATION ${JSON.stringify({
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

try {
  main();
} catch (error) {
  console.error(error);
  app.exit(1);
}
