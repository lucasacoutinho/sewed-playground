import assert from "node:assert/strict";
import { BrowserWindow as NativeWindow, app } from "electron";
import { Cause, Effect } from "effect";
import { Binding, Decidables, Decision, Renderer } from "sewed";
import { App, BrowserWindow, Utility, Worker, host } from "sewed/main";
import {
  surrogatesJson,
  MainBytes,
  WorkerBytes,
  UtilityBytes,
  RelayBytes,
  Protocol,
  slots,
} from "./binary-contract.mjs";
import { handlers } from "./binary-handlers.mjs";

const checks = [];
App.run(
  [],
  Effect.gen(function* () {
    yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
    const main = yield* host(Protocol, handlers("main"));
    const worker = yield* Worker.spawn(
      Worker.entry(new URL("./binary-worker.mjs", import.meta.url), Protocol),
    );
    const utility = yield* Utility.spawn(
      Utility.entry(new URL("./binary-utility.mjs", import.meta.url), Protocol),
    );
    const relay = yield* Worker.spawn(
      Worker.entry(new URL("./binary-relay.mjs", import.meta.url), Protocol),
      { bindings: [Binding.to(UtilityBytes, utility)] },
    );
    const window = yield* BrowserWindow.make({
      title: "Sewed binary verification",
      width: 640,
      height: 360,
    });
    yield* window.webContents.load(
      Renderer.entry(new URL("../.artifacts/binary-renderer/index.html", import.meta.url), {
        bindings: slots,
      }),
      {
        bindings: [
          Binding.to(MainBytes, main),
          Binding.to(WorkerBytes, worker),
          Binding.to(UtilityBytes, utility),
          Binding.to(RelayBytes, relay),
        ],
      },
    );
    const native = NativeWindow.getAllWindows().find((value) =>
      value.webContents.getURL().includes("/binary-renderer/"),
    );
    assert.ok(native);
    const evaluate = (source) => Effect.promise(() => native.webContents.executeJavaScript(source));
    for (
      let attempt = 0;
      attempt < 500 && !(yield* evaluate("window.binaryFixture?.ready"));
      attempt++
    )
      yield* Effect.sleep(10);
    assert.equal(yield* evaluate("window.binaryFixture?.ready"), true);
    const before = app.getAppMetrics().map(({ pid, type, memory }) => ({ pid, type, memory }));
    yield* evaluate("window.binaryFixture.start()");
    let result;
    for (let attempt = 0; attempt < 3000; attempt++) {
      result = yield* evaluate("window.binaryFixture.result");
      if (result) break;
      yield* Effect.sleep(10);
    }
    assert.equal(result?.success, true, JSON.stringify(result));
    assert.equal(result.rows.length, 4);
    for (const row of result.rows)
      checks.push({
        name: `${row.binding}: bytes, typed failure, backpressure, cancellation and reuse`,
        evidence: row,
      });
    assert.equal(result.bulk.length, 12 * 1024 * 1024);
    checks.push({
      name: "renderer to main: a 12 MiB bulk request reaches the handler intact through Binary.bulk",
      evidence: {
        length: result.bulk.length,
        sum: result.bulk.sum,
        milliseconds: result.bulk.milliseconds,
      },
    });
    assert.equal(result.bulk.overLimit.code, "Limit");
    assert.ok(result.bulk.overLimit.message.includes("content"), result.bulk.overLimit.message);
    checks.push({
      name: "renderer to main: 12 MiB + 1 bytes fails Limit naming the field and its bound before anything is sent",
      evidence: result.bulk.overLimit,
    });
    assert.equal(result.bulkAnswer.count, 63000);
    assert.ok(
      result.bulkAnswer.approximateBytes > 12 * 1024 * 1024,
      `expected roughly 12 MiB of answer data, was ${result.bulkAnswer.approximateBytes}`,
    );
    checks.push({
      name: "main to renderer: a ~12 MiB Binary.bulkAnswer JSON result arrives whole, in order, over the real bridge",
      evidence: result.bulkAnswer,
    });
    assert.equal(result.proto.answer, '{"__proto__":{"x":1},"a":2}');
    assert.equal(result.proto.rows, 20000);
    assert.deepEqual(result.proto.beside, [4, 2]);
    assert.equal(result.proto.perBinding.length, 4);
    checks.push({
      name: 'main to renderer: an answer and a bulk answer carrying JSON.parse(\'{"__proto__":{"x":1},"a":2}\') arrive intact, own key and plain prototype, while a concurrent call on the same connection succeeds; the answer too over worker, utility and relay',
      evidence: result.proto,
    });
    assert.equal(result.surrogates.answer, surrogatesJson);
    assert.equal(result.surrogates.rows, 1000);
    assert.equal(result.surrogates.perBinding.length, 4);
    assert.equal(result.surrogates.rendererIsWellFormed, "function");
    checks.push({
      name: "main to renderer: an answer and a bulk answer carrying lone surrogates (short and long strings, values and keys) arrive with the same UTF-16 code units; the answer too over worker, utility and relay",
      evidence: result.surrogates,
    });
    checks.push({
      name: "actual runtime placement and native memory observations",
      evidence: {
        workerThread: result.rows[1].before.thread,
        utilityPid: result.rows[2].before.pid,
        before,
        after: app.getAppMetrics().map(({ pid, type, memory }) => ({ pid, type, memory })),
      },
    });
    assert.ok(result.rows[1].before.thread > 0);
    assert.equal(result.rows[2].before.pid, utility.processId);
    assert.notEqual(utility.processId, process.pid);
  }).pipe(
    Effect.onExit((exit) =>
      Effect.sync(() =>
        console.log(
          `BINARY_VERIFICATION ${JSON.stringify({
            success: exit._tag === "Success",
            checks,
            error: exit._tag === "Failure" ? Cause.pretty(exit.cause) : undefined,
          })}`,
        ),
      ),
    ),
    Effect.andThen(App.quit),
  ),
);
