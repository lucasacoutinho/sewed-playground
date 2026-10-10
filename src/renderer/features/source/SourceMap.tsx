export function SourceMap() {
  return (
    <div className="source-map">
      <div className="source-intro">
        <h3>A React app with explicit owners.</h3>
        <p>
          Folders make the example readable. Effect requirements, runtime capabilities, and explicit
          bindings enforce execution placement across the main process and two worker owners.
        </p>
        <p>
          Vite builds the renderer. TanStack Router owns navigation. Components use feature hooks;
          Sewed connects those hooks to native owners.
        </p>
      </div>
      <div className="source-files">
        <details>
          <summary>
            <code>main/app.ts</code>
            <span>Owns work and binds instances</span>
          </summary>
          <pre>{`const clock = yield* Worker.spawn(clockEntry);
const worker = yield* Worker.spawn(computeEntry, {
  bindings: [Binding.to(Clock, clock)]
});
const clients = Binding.layer([Binding.to(Compute, worker)]);

yield* background.pipe(Effect.provide(clients), Effect.forkScoped);
const window = yield* BrowserWindow.make();
const controls = yield* Capability.serve(WindowControls.capability).pipe(
  Effect.provide(WindowControls.native(window))
);

Binding.to(Controls, controls)
Binding.to(Compute, worker)`}</pre>
        </details>
        <details>
          <summary>
            <code>renderer/features/</code>
            <span>Scoped clients behind React hooks</span>
          </summary>
          <pre>{`const compute = useClient(Compute, { connection: "shared" });
const work = useAction(() =>
  compute.compute({ milliseconds: 1200, label: "CPU completed" })
);`}</pre>
        </details>
        <details data-source-example="worker">
          <summary>
            <code>worker/compute.ts</code>
            <span>Owns the actual CPU loop</span>
          </summary>
          <pre>{`const thread = yield* Worker.threadId;

compute: ({ milliseconds, label }) => Effect.sync(() => {
  const end = performance.now() + milliseconds;
  let iterations = 0;
  while (performance.now() < end) iterations++;
  return { label, thread, iterations };
})`}</pre>
        </details>
        <details>
          <summary>
            <code>shared/</code>
            <span>Inert schemas and binding declarations</span>
          </summary>
          <pre>{`export const Controls = Binding.slot("window", WindowControls.protocol);
export const Clock = Binding.slot("clock", ClockProtocol);
export const Compute = Binding.slot("compute", ComputeProtocol);
export const Session = Binding.slot("session", SessionProtocol);`}</pre>
        </details>
        <details>
          <summary>
            <code>renderer/routes/</code>
            <span>TanStack file routes and components</span>
          </summary>
          <pre>{`export const Route = createFileRoute("/scopes")({
  component: ScopesPage,
});

function ScopesPage() {
  return <Scopes />;
}`}</pre>
        </details>
      </div>
      <p className="source-limit">
        Arbitrary JavaScript can still block a renderer. Sewed places the operations you model as
        owned effects; it does not analyze the cost of a function.
      </p>
    </div>
  );
}
