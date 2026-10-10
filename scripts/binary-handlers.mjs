import { threadId } from "node:worker_threads";
import { Effect, Stream } from "effect";
import { Binary } from "sewed";
import { Protocol, Rejected, surrogatesJson } from "./binary-contract.mjs";

// The same sampled checksum the unit suite measures a bulk field with (every 4093rd byte,
// modulo 65521), so main's answer and the renderer's own computation must agree exactly.
const checksum = (bytes) => {
  let sum = 0;
  for (let index = 0; index < bytes.byteLength; index += 4093) sum = (sum + bytes[index]) % 65521;
  return sum;
};

export const protoJson = '{"__proto__":{"x":1},"a":2}';

export const handlers = (runtime) =>
  Protocol.toLayer(
    Effect.gen(function* () {
      let active = 0;
      let released = 0;
      let produced = 0;
      return {
        echo: ({ bytes }) => Effect.succeed(bytes),
        reject: () => Effect.fail(new Rejected({ value: 7 })),
        ingest: ({ content }) =>
          Effect.succeed({ length: content.byteLength, sum: checksum(content) }),
        query: ({ count, size }) =>
          Effect.sync(() =>
            Array.from({ length: count }, (_, index) => ({ index, value: "x".repeat(size) })),
          ),
        json: () => Effect.sync(() => JSON.parse(protoJson)),
        surrogates: () => Effect.sync(() => JSON.parse(surrogatesJson)),
        surrogateRows: ({ count }) =>
          Effect.sync(() =>
            Array.from({ length: count }, (_, index) => ({
              index,
              data: JSON.parse(surrogatesJson),
            })),
          ),
        jsonRows: ({ count }) =>
          Effect.sync(() =>
            Array.from({ length: count }, (_, index) => ({ index, data: JSON.parse(protoJson) })),
          ),
        stats: () =>
          Effect.sync(() => ({
            runtime,
            thread: threadId,
            pid: process.pid,
            active,
            released,
            produced,
            rss: process.memoryUsage().rss,
            external: process.memoryUsage().external,
          })),
        bytes: ({ count }) =>
          Stream.unwrap(
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => {
                  active++;
                }),
                () =>
                  Effect.sync(() => {
                    active--;
                    released++;
                  }),
              );
              return Stream.range(0, count - 1).pipe(
                Stream.rechunk(1),
                Stream.map((index) => {
                  produced++;
                  return new Uint8Array(Binary.chunkBytes).fill(index % 251);
                }),
              );
            }),
          ),
      };
    }),
  );
