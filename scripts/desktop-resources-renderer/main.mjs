import { Effect, Fiber, Queue, Stream } from "effect";
import { Renderer } from "sewed";
import { TrayEventsSlot } from "../desktop-resources-contract.mjs";

Renderer.run(
  Renderer.entry(new URL(location.href), { bindings: [TrayEventsSlot] }),
  Effect.gen(function* () {
    const client = yield* TrayEventsSlot();
    const commands = yield* Queue.make();
    const events = [];
    const state = {
      bound: true,
      session: crypto.randomUUID(),
      events,
      cancelled: false,
      consumerExit: undefined,
    };
    const consumer = yield* client.events().pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
          const output = document.getElementById("events");
          if (output) output.textContent = JSON.stringify(events, null, 2);
        }),
      ),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          state.consumerExit = exit._tag;
        }),
      ),
      Effect.forkScoped,
    );
    state.cancel = () => Queue.offerUnsafe(commands, "cancel");
    window.desktopResourcesFixture = state;
    yield* Effect.forever(
      Effect.gen(function* () {
        const command = yield* Queue.take(commands);
        if (command === "cancel") {
          yield* Fiber.interrupt(consumer);
          state.cancelled = true;
        }
      }),
    );
  }),
);
