import { Effect, Stream } from "effect";
import { Renderer } from "sewed";
import { MenuEventsSlot } from "../application-menu-contract.mjs";

Renderer.run(
  Renderer.entry(new URL(location.href), { bindings: [MenuEventsSlot] }),
  Effect.gen(function* () {
    const client = yield* MenuEventsSlot();
    const selections = [];
    window.applicationMenuFixture = { selections, session: crypto.randomUUID() };
    yield* client.selections().pipe(
      Stream.runForEach((selection) =>
        Effect.sync(() => {
          selections.push(selection);
          document.getElementById("selections").textContent = JSON.stringify(selections, null, 2);
        }),
      ),
    );
  }),
);
