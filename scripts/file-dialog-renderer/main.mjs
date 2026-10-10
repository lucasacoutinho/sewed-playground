import { Cause, Effect, Fiber, Match, Queue } from "effect";
import { Renderer } from "sewed";
import { PickerSlot } from "../file-dialog-contract.mjs";

Renderer.run(
  Renderer.entry(new URL(location.href), { bindings: [PickerSlot] }),
  Effect.gen(function* () {
    const picker = yield* PickerSlot();
    const commands = yield* Queue.make();
    const results = [];
    let current;
    window.fileDialogFixture = {
      open: () => Queue.offerUnsafe(commands, "open"),
      save: () => Queue.offerUnsafe(commands, "save"),
      cancel: () => Queue.offerUnsafe(commands, "cancel"),
      results,
    };
    yield* Effect.gen(function* () {
      const command = yield* Queue.take(commands);
      if (command === "cancel") {
        if (current !== undefined) yield* Fiber.interrupt(current);
        return;
      }
      const operation = command === "open" ? picker.open() : picker.save();
      current = yield* operation.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            results.push(
              Match.value(exit).pipe(
                Match.tag("Success", ({ value }) => ({ status: "success", value })),
                Match.tag("Failure", ({ cause }) => {
                  const error = Cause.findErrorOption(cause);
                  return {
                    status: "failure",
                    interrupted: Cause.hasInterruptsOnly(cause),
                    ...(error._tag === "Some" ? { code: error.value.code } : {}),
                  };
                }),
                Match.exhaustive,
              ),
            );
          }),
        ),
        Effect.forkScoped,
      );
    }).pipe(Effect.forever);
  }),
);
