import { Cause, Effect, Fiber, Stream } from "effect";
import { SewedError } from "sewed";

const limitFailure = (exit, code, reason) => {
  if (exit._tag !== "Failure") throw new Error("An oversized value unexpectedly succeeded");
  const error = Cause.squash(exit.cause);
  if (!(error instanceof SewedError) || error.code !== code || (reason !== undefined && error.reason !== reason))
    throw new Error(Cause.pretty(exit.cause));
  return { code: error.code, reason: error.reason ?? null };
};

export const checkLimits = (path, acquire) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* acquire;
      const before = yield* client.echo({ value: "before" });
      const outgoing = limitFailure(
        yield* Effect.exit(client.echo({ value: "x".repeat(256 * 1024) })),
        "Limit",
      );
      const concurrent = yield* client
        .echo({ value: "concurrent", milliseconds: 150 })
        .pipe(Effect.forkScoped);
      const incoming = limitFailure(
        yield* Effect.exit(Stream.runDrain(client.produce({ size: 256 * 1024, count: 1 }))),
        "Unknown",
        "transport/answer-over-limit",
      );
      const other = yield* Fiber.join(concurrent);
      if (other.value !== "concurrent")
        throw new Error("Oversized output affected another request");
      let count = 0;
      const value = '😀"\\\n'.repeat(10_000);
      yield* Stream.runForEach(client.repeat({ value, count: 8 }), (result) =>
        Effect.sync(() => {
          if (result.value !== value) throw new Error("Framing changed escaped UTF-8 data");
          count++;
        }),
      );
      if (count !== 8) throw new Error("A split stream lost values");
      yield* client.produce({ size: 64 * 1024, count: 64 }).pipe(Stream.take(1), Stream.runDrain);
      const after = yield* client.echo({ value: "after" });
      if (
        after.thread !== before.thread ||
        JSON.stringify(after.via) !== JSON.stringify(before.via)
      )
        throw new Error("A transport limit or cancellation replaced an owner");
      return {
        path,
        sameClient: true,
        owner: { thread: after.thread, via: after.via },
        escapedValues: count,
        outgoing,
        incoming,
      };
    }),
  );
