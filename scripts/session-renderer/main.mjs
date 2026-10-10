import { Effect, Queue } from "effect";
import { Renderer } from "sewed";
import { CounterSlot, ControlsSlot } from "../session-contract.mjs";

Renderer.run(
  Renderer.entry(new URL(location.href), { bindings: [CounterSlot, ControlsSlot] }),
  Effect.gen(function* () {
    const counter = yield* CounterSlot();
    const controls = yield* ControlsSlot();
    const commands = yield* Queue.make();
    const results = [];
    window.sessionFixture = {
      document: crypto.randomUUID(),
      results,
      sample: () => Queue.offerUnsafe(commands, "sample"),
    };
    yield* Effect.gen(function* () {
      yield* Queue.take(commands);
      const worker = yield* counter.next();
      const window = yield* controls.state();
      results.push({ worker, window });
    }).pipe(Effect.forever);
  }),
);
