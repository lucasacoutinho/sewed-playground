import assert from "node:assert/strict";
import { app, crashReporter as nativeCrashReporter } from "electron";
import { Cause, Effect } from "effect";
import { CrashReporter, Updater } from "@sewed/forge";
import { makeConfig } from "@sewed/forge/config";
import { Decidables, Decision } from "sewed";
import { App } from "sewed/main";

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

const runChecks = Effect.scoped(
  Effect.gen(function* () {
    const parameters = yield* CrashReporter.parameters;
    assert.equal(parameters.channel, "playground");
    assert.equal(yield* CrashReporter.uploadToServer, false);
    yield* CrashReporter.setParameter("fixture", "forge");
    assert.equal((yield* CrashReporter.parameters).fixture, "forge");
    yield* CrashReporter.removeParameter("fixture");
    assert.equal((yield* CrashReporter.parameters).fixture, undefined);
    expectCode(yield* Effect.exit(CrashReporter.setParameter("k".repeat(40), "v")), "Protocol");
    assert.equal(yield* CrashReporter.lastReport, null);
    assert.deepEqual(yield* CrashReporter.uploadedReports, []);
    assert.deepEqual(nativeCrashReporter.getParameters().channel, "playground");
    record("the crash reporter starts before readiness with uploads off and edits its parameters", {
      parameters: yield* CrashReporter.parameters,
    });

    const config = makeConfig({
      name: "sewed-playground",
      makers: ["squirrel", "zip", "deb"],
      github: { owner: "sewed", repo: "playground" },
    });
    assert.equal(config.publishers[0].config.repository.name, "playground");
    const feed = yield* Updater.githubFeed({ owner: "sewed", repo: "playground" });
    assert.equal(
      feed.url,
      `https://update.electronjs.org/sewed/playground/${process.platform}-${process.arch}/${app.getVersion()}`,
    );
    expectCode(yield* Effect.exit(Updater.githubFeed({ owner: "", repo: "x" })), "Protocol");
    if (process.platform === "linux") {
      expectCode(yield* Effect.exit(Effect.scoped(Updater.make(feed))), "Native");
    } else {
      const updater = yield* Updater.make(feed);
      assert.equal((yield* updater.current).status, "idle");
      expectCode(yield* Effect.exit(updater.install), "Protocol");
      expectCode(yield* Effect.exit(Effect.scoped(Updater.make(feed))), "Limit");
    }
    expectCode(yield* Effect.exit(Effect.scoped(Updater.make({ url: "ftp://x" }))), "Protocol");
    record("the publisher repository feeds the updater and the updater gates by platform", {
      feed: feed.url,
      makers: config.makers.map((maker) => maker.name),
      platform: process.platform,
    });
  }),
);

// `App.run` is called synchronously, in this module's own first pass, with no `await` anywhere
// before it -- the entry rule from sewed-round-two's Task 3 (App.run refuses to declare after
// readiness): an `async function` awaited internally, but never awaited at this module's own top
// level, does not hold Electron's `ready`, so a call reached only after such an await is already
// too late. `App.run` itself awaits readiness before running the program below, so nothing here
// needs to await it a second time.
function main() {
  App.run(
    [
      CrashReporter.declare({
        productName: "Sewed playground",
        uploadToServer: false,
        extra: { channel: "playground" },
      }),
    ],
    Effect.gen(function* () {
      yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
      const result = yield* Effect.exit(runChecks);
      console.log(
        `FORGE_VERIFICATION ${JSON.stringify({
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
