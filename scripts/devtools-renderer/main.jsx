import { useState } from "react";
import { Cause, Effect, Match } from "effect";
import { mount, useAction, useClient, useStream } from "@sewed/react";
import { Renderer } from "sewed";
import { Compute } from "../devtools-contract.mjs";

function Values({ worker }) {
  const result = useStream(() => worker.ticks(), [worker]);
  return (
    <output>
      {Match.value(result).pipe(
        Match.when({ status: "loading" }, () => "Connecting"),
        Match.when({ status: "value" }, ({ value }) => `Worker ${value}`),
        Match.when({ status: "failure" }, () => "Owner closed"),
        Match.exhaustive,
      )}
    </output>
  );
}
function App() {
  const [active, setActive] = useState(true);
  const worker = useClient(Compute);
  const busy = useAction(() =>
    Effect.gen(function* () {
      yield* Effect.log("devtools-renderer-busy");
      return yield* worker.busy();
    }).pipe(Effect.withSpan("devtools-renderer-busy-operation")),
  );
  return (
    <main data-inspected-app>
      <h1>Renderer document</h1>
      <button data-stream-toggle type="button" onClick={() => setActive((value) => !value)}>
        {active ? "Cancel stream" : "Start stream"}
      </button>
      <button data-busy type="button" onClick={() => busy.run()}>
        Run busy worker
      </button>
      <output data-busy-status>
        {Match.value(busy).pipe(
          Match.when({ status: "idle" }, () => "Idle"),
          Match.when({ status: "running" }, () => "Busy"),
          Match.when({ status: "success" }, ({ value }) => `Busy ${value}ms`),
          Match.when({ status: "failure" }, () => "Busy failed"),
          Match.when({ status: "interrupted" }, () => "Busy interrupted"),
          Match.exhaustive,
        )}
      </output>
      {active && <Values worker={worker} />}
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing inspected application root");
const lifetime = Renderer.run(
  Renderer.entry(new URL(location.href), { bindings: [Compute] }),
  mount(root, <App />),
);
lifetime.addObserver((exit) => {
  if (exit._tag === "Failure") console.error(Cause.pretty(exit.cause));
});
