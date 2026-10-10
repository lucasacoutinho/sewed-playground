import { Cause, Effect, Fiber, Queue } from "effect";
import { Renderer } from "sewed";
import { PromptSlot } from "../dialog-contract.mjs";

Renderer.run(
  Renderer.entry(new URL(location.href), { bindings: [PromptSlot] }),
  Effect.gen(function* () {
    const prompt = yield* PromptSlot();
    const commands = yield* Queue.make();
    const results = [];
    let current;
    window.dialogFixture = {
      start: () => Queue.offerUnsafe(commands, "start"),
      cancel: () => Queue.offerUnsafe(commands, "cancel"),
      results,
    };
    yield* Effect.gen(function* () {
      const command = yield* Queue.take(commands);
      if (command === "cancel") {
        if (current !== undefined) yield* Fiber.interrupt(current);
        return;
      }
      current = yield* prompt.ask().pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            results.push(
              exit._tag === "Success"
                ? { status: "success", value: exit.value }
                : { status: "failure", interrupted: Cause.hasInterruptsOnly(exit.cause) },
            );
          }),
        ),
        Effect.forkScoped,
      );
    }).pipe(Effect.forever);
  }),
);
