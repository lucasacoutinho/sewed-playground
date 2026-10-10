import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  app,
  contentTracing as nativeTracing,
  Notification as NativeNotification,
  powerSaveBlocker as nativeBlocker,
} from "electron";
import { Cause, Effect, Exit, Scope } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Decidables, Decision } from "sewed";
import {
  App,
  ContentTracing,
  Net,
  NetLog,
  Notification,
  PowerSaveBlocker,
  Session,
} from "sewed/main";

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

const requests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    requests.push({
      path: url.pathname,
      method: request.method,
      cookie: request.headers.cookie ?? null,
      body,
    });
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify({
          path: url.pathname,
          method: request.method,
          cookie: request.headers.cookie ?? null,
          body,
        }),
      );
  });
});
const listen = () =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });

const runChecks = (origin) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fetchJson = (url, init) =>
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient;
          const response = yield* init === undefined ? http.get(url) : http.execute(init(url));
          return yield* response.json;
        }).pipe(Effect.scoped);
      const direct = yield* fetchJson(`${origin}/direct`).pipe(Effect.provide(Net.layer()));
      assert.equal(direct.path, "/direct");
      const posted = yield* fetchJson(`${origin}/post`, (url) =>
        HttpClientRequest.post(url).pipe(HttpClientRequest.bodyText("payload", "text/plain")),
      ).pipe(Effect.provide(Net.layer()));
      assert.equal(posted.method, "POST");
      assert.equal(posted.body, "payload");
      const session = yield* Session.fromPartition({ kind: "memory", name: "operations" });
      yield* session.cookies.set({ url: origin, name: "ops", value: "yes" });
      const viaSession = yield* fetchJson(`${origin}/session`).pipe(
        Effect.provide(Net.layer({ session })),
      );
      assert.equal(viaSession.cookie, "ops=yes");
      assert.equal(direct.cookie, null);
      const transport = yield* Effect.exit(
        fetchJson("http://127.0.0.1:1/unreachable").pipe(Effect.provide(Net.layer())),
      );
      assert.equal(transport._tag, "Failure");
      assert.equal(typeof (yield* Net.online), "boolean");
      const resolved = yield* Net.resolveHost("localhost");
      assert.ok(resolved.endpoints.length > 0);
      expectCode(yield* Effect.exit(Net.resolveHost("")), "Protocol");
      record("the net layer serves Effect's HTTP client directly and through a session's cookies", {
        requests: requests.map((request) => [request.path, request.cookie]),
        endpoints: resolved.endpoints.length,
      });

      const blockScope = yield* Scope.fork(yield* Effect.scope);
      const block = yield* PowerSaveBlocker.hold("prevent-display-sleep").pipe(
        Scope.provide(blockScope),
      );
      assert.equal(yield* block.active, true);
      yield* Scope.close(blockScope, Exit.void);
      assert.equal(yield* block.active, false);
      expectCode(
        yield* Effect.exit(Effect.scoped(PowerSaveBlocker.hold("prevent-everything"))),
        "Protocol",
      );
      record("a power save block holds for its scope and releases on close", { kind: block.kind });

      const directory = mkdtempSync(join(tmpdir(), "sewed-operations-"));
      const logScope = yield* Scope.fork(yield* Effect.scope);
      const log = yield* NetLog.record(join(directory, "net.json"), {
        captureMode: "default",
      }).pipe(Scope.provide(logScope));
      assert.equal(yield* log.active, true);
      expectCode(
        yield* Effect.exit(Effect.scoped(NetLog.record(join(directory, "second.json")))),
        "Limit",
      );
      yield* fetchJson(`${origin}/logged`).pipe(Effect.provide(Net.layer()));
      yield* Scope.close(logScope, Exit.void);
      assert.equal(yield* log.active, false);
      assert.ok(existsSync(log.path) && statSync(log.path).size > 0, "net log written");
      expectCode(yield* Effect.exit(Effect.scoped(NetLog.record("relative.json"))), "Protocol");
      record("a net log records for its scope, refuses a second recording, and writes on close", {
        bytes: statSync(log.path).size,
      });

      const categories = yield* ContentTracing.categories;
      assert.ok(categories.length > 0);
      const traceScope = yield* Scope.fork(yield* Effect.scope);
      const trace = yield* ContentTracing.record(join(directory, "trace.json"), {
        included: ["*"],
        mode: "record-until-full",
      }).pipe(Scope.provide(traceScope));
      yield* Effect.sleep(200);
      const usage = yield* ContentTracing.bufferUsage;
      const written = yield* trace.stop;
      assert.equal(written, join(directory, "trace.json"));
      assert.ok(existsSync(written) && statSync(written).size > 0, "trace written");
      expectCode(yield* Effect.exit(trace.stop), "Closed");
      yield* Scope.close(traceScope, Exit.void);
      expectCode(
        yield* Effect.exit(
          Effect.scoped(ContentTracing.record(join(directory, "x.json"), { mode: "forever" })),
        ),
        "Protocol",
      );
      record("a trace records categories and writes its file on stop", {
        categories: categories.length,
        usage,
        bytes: statSync(written).size,
      });

      const showFault = new Error("native notification show failed");
      const originalShow = NativeNotification.prototype.show;
      const originalClose = NativeNotification.prototype.close;
      let failedNotification;
      let notificationCloses = 0;
      const notificationScope = yield* Scope.fork(yield* Effect.scope);
      NativeNotification.prototype.show = function () {
        failedNotification = this;
        throw showFault;
      };
      NativeNotification.prototype.close = function () {
        notificationCloses++;
        return originalClose.call(this);
      };
      const showResult = yield* Effect.exit(
        Notification.show({ title: "Acquisition failure" }).pipe(Scope.provide(notificationScope)),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            NativeNotification.prototype.show = originalShow;
            NativeNotification.prototype.close = originalClose;
          }),
        ),
      );
      const showError = expectCode(showResult, "Native");
      assert.equal(showError.cause, showFault);
      assert.equal(notificationCloses, 1, "failed acquisition must close its notification");
      assert.equal(
        failedNotification.eventNames().length,
        0,
        "failed notification listeners must be removed",
      );
      yield* Scope.close(notificationScope, Exit.void);
      record(
        "a notification show failure releases its native object and listeners before returning",
      );

      const fault = new Error("trace completion failed after native stop");
      const originalStop = nativeTracing.stopRecording;
      const failedScope = yield* Scope.fork(yield* Effect.scope);
      yield* ContentTracing.record(join(directory, "cleanup-failure.json"), {
        included: ["*"],
      }).pipe(Scope.provide(failedScope));
      nativeTracing.stopRecording = (file) =>
        originalStop.call(nativeTracing, file).then(() => {
          throw fault;
        });
      const failedCleanup = yield* Effect.exit(Scope.close(failedScope, Exit.void)).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            nativeTracing.stopRecording = originalStop;
          }),
        ),
      );
      assert.equal(failedCleanup._tag, "Failure", "a rejected native stop must fail scope cleanup");
      const cleanupError = Cause.squash(failedCleanup.cause);
      assert.equal(cleanupError.code, "Native");
      assert.equal(cleanupError.cause, fault);
      record("trace scope cleanup preserves native stop failure after recording has ended");
    }),
  );

async function verify() {
  await app.whenReady();
  const origin = await listen();
  App.run(
    [],
    Effect.gen(function* () {
      yield* App.decide(
        Decidables.App.LastWindowClosed,
        Decision.sync(() => "stay"),
      );
      const result = yield* Effect.exit(runChecks(origin));
      server.close();
      console.log(
        `OPERATIONS_VERIFICATION ${JSON.stringify({
          success: result._tag === "Success",
          checks,
          error: result._tag === "Failure" ? Cause.pretty(result.cause) : undefined,
          blockers: nativeBlocker.isStarted(0),
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
