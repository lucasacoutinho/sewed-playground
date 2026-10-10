import { Cause, Deferred, Effect, Exit, Fiber, Queue, Stream } from "effect";
import { Binary, Renderer } from "sewed";
import { MainBytes, Rejected, slots, surrogatesJson } from "../binary-contract.mjs";

// The same sampled checksum the unit suite and main's handler use.
const checksum = (bytes) => {
  let sum = 0;
  for (let index = 0; index < bytes.byteLength; index += 4093) sum = (sum + bytes[index]) % 65521;
  return sum;
};
const pattern = (size) => {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index++) bytes[index] = (index * 31) % 251;
  return bytes;
};

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
Renderer.run(
  Renderer.entry(new URL(location.href), { bindings: slots }),
  Effect.gen(function* () {
    const commands = yield* Queue.make();
    const state = {
      ready: true,
      result: null,
      phase: "ready",
      start: () => Queue.offerUnsafe(commands, undefined),
    };
    window.binaryFixture = state;
    yield* Queue.take(commands);
    const result = yield* Effect.exit(
      Effect.gen(function* () {
        const rows = [];
        for (const slot of slots) {
          state.phase = slot.key;
          const client = yield* slot();
          const stats = yield* slot();
          const before = yield* stats.stats();
          const input = new Uint8Array(Binary.chunkBytes).fill(83);
          const echo = yield* client.echo({ bytes: input });
          check(
            echo instanceof Uint8Array &&
              echo.length === input.length &&
              echo[0] === 83 &&
              echo.at(-1) === 83,
            "echo bytes changed across preload",
          );
          const error = yield* client.reject().pipe(Effect.flip);
          check(error instanceof Rejected && error.value === 7, "declared binary failure changed");
          let chunks = 0;
          const started = performance.now();
          const bytes = yield* client.bytes({ count: 256 }).pipe(
            Stream.runFold(
              () => 0,
              (total, chunk) => {
                check(
                  chunk instanceof Uint8Array && chunk.length === Binary.chunkBytes,
                  "native byte chunk changed",
                );
                check(
                  chunk[0] === chunks % 251 && chunk.at(-1) === chunks % 251,
                  "native byte stream order changed",
                );
                chunks++;
                return total + chunk.byteLength;
              },
            ),
          );
          check(bytes === 16 * 1024 * 1024 && chunks === 256, "bulk stream size changed");
          const milliseconds = performance.now() - started;
          const after = yield* stats.stats();
          const first = yield* Deferred.make();
          const hold = yield* Deferred.make();
          const consumer = yield* client.bytes({ count: 4096 }).pipe(
            Stream.runForEach(() =>
              Deferred.succeed(first, undefined).pipe(Effect.andThen(Deferred.await(hold))),
            ),
            Effect.forkScoped,
          );
          yield* Deferred.await(first);
          yield* Effect.sleep(100);
          const stalled = yield* stats.stats();
          yield* Effect.sleep(100);
          const stable = yield* stats.stats();
          check(
            stable.produced === stalled.produced,
            "stalled consumer did not stop native production",
          );
          check(
            stalled.produced - after.produced < 128,
            "native buffering exceeded 128 source chunks",
          );
          yield* Fiber.interrupt(consumer);
          for (let attempt = 0; attempt < 100 && (yield* stats.stats()).active !== 0; attempt++)
            yield* Effect.sleep(10);
          const closed = yield* stats.stats();
          check(
            closed.active === 0 && closed.released >= before.released + 2,
            "native byte producer leaked after interruption",
          );
          const repeat = yield* client.echo({ bytes: input });
          check(repeat.length === input.length, "cancellation poisoned binding");
          rows.push({
            binding: slot.key,
            bytes,
            chunks,
            milliseconds,
            mibPerSecond: (16 * 1000) / milliseconds,
            bufferedChunks: stalled.produced - after.produced,
            before,
            after,
            closed,
            rendererHeapBytes: performance.memory?.usedJSHeapSize ?? null,
          });
        }

        // Renderer to main only: a bulk request over the real contextBridge clone, preload
        // MessagePort, and MainBridge per-packet decode, assembled by the owner before its
        // handler runs. Twelve MiB, the declared bound, must succeed; one byte over must fail
        // Limit locally, naming the field and the bound, with nothing sent to the handler.
        state.phase = "bulk";
        const main = yield* MainBytes();
        const twelveMiB = 12 * 1024 * 1024;
        const content = pattern(twelveMiB);
        const bulkStarted = performance.now();
        const ingested = yield* main.ingest({ content });
        const bulkMilliseconds = performance.now() - bulkStarted;
        check(
          ingested.length === twelveMiB && ingested.sum === checksum(content),
          "bulk ingest length or checksum changed",
        );
        const over = yield* main
          .ingest({ content: new Uint8Array(twelveMiB + 1) })
          .pipe(Effect.flip);
        check(
          over.code === "Limit" && over.message.includes("content"),
          "bulk bound failure changed",
        );
        const bulk = {
          length: ingested.length,
          sum: ingested.sum,
          milliseconds: bulkMilliseconds,
          overLimit: { code: over.code, message: over.message },
        };

        // Main to renderer, declared with Binary.bulkAnswer: a Core-shaped search result (a JSON
        // array of small objects, not bytes) whose encoded Exit exceeds one envelope, carried in
        // acknowledged AnswerPart frames over the real contextBridge/MessagePort/MainBridge path
        // and assembled here before this Effect ever sees it. Received whole means every item
        // survived the trip, in order, none dropped or duplicated by the split.
        state.phase = "bulkAnswer";
        const queryCount = 63000;
        const queryValueSize = 200;
        const queryStarted = performance.now();
        const queried = yield* main.query({ count: queryCount, size: queryValueSize });
        const queryMilliseconds = performance.now() - queryStarted;
        check(queried.length === queryCount, "bulk answer item count changed");
        check(
          queried.every((item, index) => item.index === index && item.value.length === queryValueSize),
          "bulk answer item order or shape changed",
        );
        const bulkAnswer = {
          count: queried.length,
          approximateBytes: queryCount * queryValueSize,
          milliseconds: queryMilliseconds,
        };

        // JSON-shaped data with an own "__proto__" key, as main gets it from JSON.parse: an
        // ordinary answer and a bulk answer in parts arrive exactly as sent, while an ordinary
        // call runs beside them on the same connection. On every binding, the ordinary answer too.
        state.phase = "proto";
        const protoJson = '{"__proto__":{"x":1},"a":2}';
        const exact = (value) =>
          typeof value === "object" &&
          value !== null &&
          Object.getPrototypeOf(value) === Object.prototype &&
          Object.hasOwn(value, "__proto__") &&
          JSON.stringify(value) === protoJson;
        const protoRows = 20000;
        const [answer, rowsAnswer, besideEcho] = yield* Effect.all(
          [
            main.json(),
            main.jsonRows({ count: protoRows }),
            main.echo({ bytes: new Uint8Array([4, 2]) }),
          ],
          { concurrency: "unbounded" },
        );
        check(exact(answer), `the __proto__ answer changed: ${JSON.stringify(answer)}`);
        check(rowsAnswer.length === protoRows, "the __proto__ bulk answer count changed");
        check(
          rowsAnswer.every((row, index) => row.index === index && exact(row.data)),
          "the __proto__ bulk answer changed",
        );
        check(besideEcho[0] === 4 && besideEcho[1] === 2, "the call beside the __proto__ answers failed");
        const perBinding = [];
        for (const slot of slots) {
          const client = yield* slot();
          check(exact(yield* client.json()), `${slot.key}: the __proto__ answer changed`);
          perBinding.push(slot.key);
        }
        const proto = { answer: JSON.stringify(answer), rows: rowsAnswer.length, beside: [...besideEcho], perBinding };

        // Lone surrogates, short and long, values and keys: an ordinary answer and a bulk answer
        // in parts arrive with the same UTF-16 code units. `JSON.stringify` escapes a lone
        // surrogate, so an equal string means every code unit arrived as sent. On every binding,
        // the ordinary answer too.
        state.phase = "surrogates";
        const expected = JSON.parse(surrogatesJson);
        const sameUnits = (value) =>
          typeof value === "object" &&
          value !== null &&
          JSON.stringify(value) === surrogatesJson &&
          value.short === expected.short &&
          value.long === expected.long &&
          value.longLow === expected.longLow &&
          Object.keys(value.keys).every((key, index) => key === Object.keys(expected.keys)[index]);
        const surrogateCount = 1000;
        const [single, surrogateRows] = yield* Effect.all(
          [main.surrogates(), main.surrogateRows({ count: surrogateCount })],
          { concurrency: "unbounded" },
        );
        check(sameUnits(single), `the lone-surrogate answer changed: ${JSON.stringify(single)}`);
        check(surrogateRows.length === surrogateCount, "the lone-surrogate bulk answer count changed");
        check(
          surrogateRows.every((row, index) => row.index === index && sameUnits(row.data)),
          "the lone-surrogate bulk answer changed",
        );
        const surrogateBindings = [];
        for (const slot of slots) {
          const client = yield* slot();
          check(sameUnits(yield* client.surrogates()), `${slot.key}: the lone-surrogate answer changed`);
          surrogateBindings.push(slot.key);
        }
        const surrogates = {
          answer: JSON.stringify(single),
          rows: surrogateRows.length,
          perBinding: surrogateBindings,
          rendererIsWellFormed: typeof "".isWellFormed,
          userAgent: navigator.userAgent,
        };

        return { rows, bulk, bulkAnswer, proto, surrogates };
      }),
    );
    state.result = Exit.isSuccess(result)
      ? {
          success: true,
          rows: result.value.rows,
          bulk: result.value.bulk,
          bulkAnswer: result.value.bulkAnswer,
          proto: result.value.proto,
          surrogates: result.value.surrogates,
        }
      : { success: false, error: Cause.pretty(result.cause), phase: state.phase };
  }),
);
