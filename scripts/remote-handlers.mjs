import { Context, Effect, Layer, Stream } from "effect";
import { Remote } from "sewed";
import { Definition, Methods } from "./remote-contract.mjs";

export const ResourceState = Context.Service()("remote-fixture/ResourceState");

const emptyDownstream = {
  downstreamSeed: "",
  downstreamRuntime: "",
  downstreamResourceId: -1,
};

const inspectState = (state, counters, downstream = emptyDownstream) => ({
  seed: state.seed,
  resourceId: state.resourceId,
  value: state.value,
  placement: state.placement,
  active: counters.active,
  created: counters.created,
  released: counters.released,
  streamsStarted: counters.streamsStarted,
  streamsFinalized: counters.streamsFinalized,
  ...downstream,
});

const stateLayer = ({ seed, placement, counters }) =>
  Layer.effect(
    ResourceState,
    Effect.gen(function* () {
      const nativePlacement = yield* placement;
      const state = {
        seed,
        resourceId: ++counters.created,
        value: 0,
        placement: nativePlacement,
      };
      counters.active += 1;
      return yield* Effect.acquireRelease(Effect.succeed(state), () =>
        Effect.sleep("30 millis").pipe(
          Effect.andThen(
            Effect.sync(() => {
              counters.active -= 1;
              counters.released += 1;
            }),
          ),
        ),
      );
    }),
  );

const methodLayer = ({ seed, counters, downstream }) =>
  Methods.toLayer(
    Effect.gen(function* () {
      const state = yield* ResourceState;
      return {
        inspect: () => Effect.sync(() => inspectState(state, counters, downstream)),
        add: ({ delta }) =>
          Effect.sync(() => {
            state.value += delta;
            return state.value;
          }),
        read: () => Effect.succeed(state.value),
        progress: ({ hold }) =>
          Stream.unwrap(
            Effect.sync(() => {
              counters.streamsStarted += 1;
              const values = Stream.range(0, hold ? 4095 : 2).pipe(
                Stream.rechunk(1),
                Stream.map((step) => ({ seed, step, value: state.value + step })),
              );
              const tail = hold ? Stream.never : Stream.empty;
              return Stream.ensuring(
                Stream.concat(values, tail),
                Effect.sync(() => {
                  counters.streamsFinalized += 1;
                }),
              );
            }),
          ),
      };
    }),
  );

const resourceLayer = (config, payload) => {
  const counters = config.counters;
  return methodLayer({ ...config, seed: payload.seed, counters }).pipe(
    Layer.provide(stateLayer({ ...config, seed: payload.seed, counters })),
  );
};

export const resourceHandlers = (config) =>
  Remote.layer(Definition, (payload) => resourceLayer(config, payload));

export const relayHandlers = (config, utilitySlot) =>
  Remote.layer(Definition, (payload) => {
    const counters = config.counters;
    const downstreamLayer = Methods.toLayer(
      Effect.gen(function* () {
        const downstream = yield* Remote.acquire(Definition, utilitySlot, {
          seed: `relay:${payload.seed}`,
        });
        yield* Effect.addFinalizer(() => downstream.release.pipe(Effect.catch(() => Effect.void)));
        const state = yield* ResourceState;
        return {
          inspect: () =>
            Effect.map(downstream.client.inspect(), (child) =>
              inspectState(state, counters, {
                downstreamSeed: child.seed,
                downstreamRuntime: child.placement.runtime,
                downstreamResourceId: child.resourceId,
              }),
            ),
          add: ({ delta }) =>
            Effect.sync(() => {
              state.value += delta;
              return state.value;
            }),
          read: () => Effect.succeed(state.value),
          progress: ({ hold }) => {
            counters.streamsStarted += 1;
            return Stream.ensuring(
              downstream.client.progress({ hold }),
              Effect.sync(() => {
                counters.streamsFinalized += 1;
              }),
            );
          },
        };
      }),
    );
    return downstreamLayer.pipe(
      Layer.provide(stateLayer({ ...config, seed: payload.seed, counters })),
    );
  });
