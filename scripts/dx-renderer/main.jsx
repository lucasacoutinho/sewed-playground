import { StrictMode, Suspense, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Cause, Effect, Match, Option, Stream, Tracer } from "effect";
import { Renderer } from "sewed";
import { connect, mount, RuntimeProvider, useClient, useStream } from "@sewed/react";
import { Other, Values } from "../dx-contract.mjs";

const listeners = new Set();
const factories = [];
let model = {
  key: "first",
  revision: 0,
  mounted: true,
  abandon: false,
  throws: false,
  slow: false,
};
const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => model;
const update = (change) => {
  model = { ...model, ...change };
  for (const listener of listeners) listener();
};
const suspended = new Promise(() => {});

function Abandoned() {
  useStream(() => {
    factories.push("abandoned");
    return Stream.empty;
  }, []);
  throw suspended;
}

function ValuesView({ value }) {
  const client = useClient(Values);
  const { key, throws, slow } = value;
  const state = useStream(() => {
    factories.push(key);
    if (throws) throw new Error("stream factory failed");
    if (slow)
      return Stream.fromEffect(
        Effect.sleep(150).pipe(Effect.as({ key, subscription: -1 }), Effect.uninterruptible),
      );
    return client.values({ key });
  }, [client, key, throws, slow]);
  const text = Match.value(state).pipe(
    Match.when({ status: "value" }, ({ value }) => JSON.stringify(value)),
    Match.when({ status: "failure" }, ({ cause }) => Cause.pretty(cause)),
    Match.when({ status: "loading" }, () => "loading"),
    Match.exhaustive,
  );
  const code =
    state.status === "failure"
      ? Cause.findErrorOption(state.cause).pipe(
          Option.map((error) => error.code),
          Option.getOrUndefined,
        )
      : undefined;
  return (
    <output data-state={state.status} data-error-code={code}>
      {text}
    </output>
  );
}

function Fixture() {
  const value = useSyncExternalStore(subscribe, snapshot);
  return (
    <div data-revision={value.revision}>
      {value.mounted ? <ValuesView value={value} /> : <span data-unmounted />}
      <Suspense fallback={<span data-suspended />}>{value.abandon ? <Abandoned /> : null}</Suspense>
    </div>
  );
}

const mode = new URL(location.href).searchParams.get("mode");
const entry = Renderer.entry(new URL(location.href), {
  bindings: mode === "mismatch" ? [Other] : [Values],
});
const baseTracer = Effect.runSync(Effect.tracer);
let clientSpan;
const tracer = Tracer.make({
  span(options) {
    const span = baseTracer.span(options);
    if (options.name === "RpcClient.values") clientSpan = span;
    return span;
  },
});
if (mode === "ungated") {
  // No `Renderer.run`, no `mount`: `connect` builds its store over whatever bridge this document
  // actually has (none, on a plain `loadURL` page with no Sewed preload), and `Fixture`'s hooks
  // — unconditional, no gate — render `failure` with that store's `Closed` cause instead of
  // throwing or leaving the page blank.
  const store = connect(entry);
  createRoot(document.getElementById("root")).render(
    <StrictMode>
      <RuntimeProvider store={store}>
        <Fixture />
      </RuntimeProvider>
    </StrictMode>,
  );
  window.dx = { store };
} else {
  const lifetime = Renderer.run(
    entry,
    mount(
      document.getElementById("root"),
      <StrictMode>
        <Fixture />
      </StrictMode>,
    ).pipe(Effect.withTracer(tracer)),
  );
  window.dx = {
    update,
    factories,
    stop: () => lifetime.interruptUnsafe(),
    trace: () => clientSpan && Object.fromEntries(clientSpan.attributes),
  };
  lifetime.addObserver((exit) => {
    if (exit._tag !== "Failure") return;
    const error = Cause.findErrorOption(exit.cause);
    window.dx.error =
      error._tag === "Some"
        ? { code: error.value.code, message: error.value.message }
        : { message: Cause.pretty(exit.cause) };
  });
}
