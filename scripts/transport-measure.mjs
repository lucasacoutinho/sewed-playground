import { Effect, Stream } from "effect";
import { Binding } from "sewed";

const warmups = 5;
const samples = 40;
const chunks = 32;
const percentile = (values, fraction) => values[Math.ceil(values.length * fraction) - 1];

const connectionBytes = 1024;

export const measureConnections = (name, slot, progress = () => {}) =>
  Effect.gen(function* () {
    const value = "x".repeat(connectionBytes);
    const rows = [];
    for (const connection of ["per-call", "shared"]) {
      const client = yield* Binding.deferred(slot, { connection });
      const call = Effect.scoped(client.echo({ value }));
      progress({ path: name, connection, phase: "warmup" });
      let owner;
      for (let index = 0; index < warmups; index++) owner = yield* call;
      const latencies = [];
      progress({ path: name, connection, phase: "unary" });
      for (let index = 0; index < samples; index++) {
        const start = performance.now();
        const response = yield* call;
        latencies.push(performance.now() - start);
        if (response.value !== value || response.thread !== owner.thread)
          throw new Error("Deferred client changed payload or owner");
      }
      latencies.sort((left, right) => left - right);
      rows.push({
        path: `${name}-${connection}`,
        bytes: connectionBytes,
        warmups,
        samples,
        p50Ms: percentile(latencies, 0.5),
        p95Ms: percentile(latencies, 0.95),
        maxMs: latencies.at(-1),
        owner: { thread: owner.thread, via: owner.via },
      });
    }
    return rows;
  });

export const measure = (name, acquire, progress = () => {}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* acquire;
      const rows = [];
      for (const bytes of [1024, 64 * 1024, 192 * 1024]) {
        const value = "x".repeat(bytes);
        let owner;
        progress({ path: name, bytes, phase: "warmup" });
        for (let index = 0; index < warmups; index++) owner = yield* client.echo({ value });
        const latencies = [];
        progress({ path: name, bytes, phase: "unary" });
        for (let index = 0; index < samples; index++) {
          const start = performance.now();
          const response = yield* client.echo({ value });
          latencies.push(performance.now() - start);
          if (
            response.value !== value ||
            response.thread !== owner.thread ||
            JSON.stringify(response.via) !== JSON.stringify(owner.via)
          )
            throw new Error("Transport changed payload or owner");
        }
        latencies.sort((left, right) => left - right);
        let received = 0;
        progress({ path: name, bytes, phase: "stream" });
        const start = performance.now();
        yield* Stream.runForEach(client.repeat({ value, count: chunks }), (response) =>
          Effect.sync(() => {
            if (
              response.value !== value ||
              response.thread !== owner.thread ||
              JSON.stringify(response.via) !== JSON.stringify(owner.via)
            )
              throw new Error("Stream changed payload or owner");
            received += 1;
          }),
        );
        const streamMs = performance.now() - start;
        if (received !== chunks) throw new Error("Stream did not complete");
        rows.push({
          path: name,
          bytes,
          warmups,
          samples,
          p50Ms: percentile(latencies, 0.5),
          p95Ms: percentile(latencies, 0.95),
          maxMs: latencies.at(-1),
          stream: {
            values: chunks,
            sourceValuesPerChunk: chunks,
            milliseconds: streamMs,
            payloadMiBPerSecond: (bytes * chunks) / (1024 * 1024) / (streamMs / 1000),
          },
          owner: { thread: owner.thread, via: owner.via },
        });
      }
      return rows;
    }),
  );
