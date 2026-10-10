import { Cause, Effect, Stream } from "effect";
import { Renderer } from "sewed";
import { ConsumerBinding } from "../utility-contract.mjs";

const entry = Renderer.entry(new URL(location.href), { bindings: [ConsumerBinding] });

Renderer.run(
  entry,
  Effect.gen(function* () {
    try {
      const utility = yield* ConsumerBinding();
      const first = yield* utility.inspect();
      const values = yield* utility
        .stream({ count: 8, delayMs: 4 })
        .pipe(Stream.take(2), Stream.runCollect);
      window.utilityProcessFixture = {
        pid: first.pid,
        type: first.type,
        role: first.role,
        counter: first.counter,
        streamValues: Array.from(values),
      };
    } catch (cause) {
      window.utilityProcessFixtureError = Cause.pretty(cause);
    }
    yield* Effect.never;
  }),
);
