import { Deferred, Effect, Stream, SubscriptionRef } from "effect";
import type { RpcGroup } from "effect/rpc";
import { Binding, SewedError } from "sewed";
import { host } from "sewed/main";
import type { BrowserWindow, Worker } from "sewed/main";
import { Compute } from "../shared/bindings.js";
import { SessionProtocol, SessionState } from "../shared/contracts.js";
import type { ClockProtocol, ComputeProtocol } from "../shared/contracts.js";

export const createSession = ({
  worker,
  clock,
}: {
  readonly worker: Worker.Handle<RpcGroup.Rpcs<typeof ComputeProtocol>>;
  readonly clock: Worker.Handle<RpcGroup.Rpcs<typeof ClockProtocol>>;
}) =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<SessionState>({
      mainProcess: process.pid,
      worker: { id: worker.id, status: "running" },
      clock: { id: clock.id, status: "running" },
      windows: [],
      background: { status: "starting" },
    });
    const windows = new Map<string, BrowserWindow.Handle>();
    yield* worker.awaitExit.pipe(
      Effect.andThen(
        SubscriptionRef.update(state, (value): SessionState => ({
          ...value,
          worker: { ...value.worker, status: "stopped" },
        })),
      ),
      Effect.forkScoped,
    );
    yield* clock.awaitExit.pipe(
      Effect.andThen(
        SubscriptionRef.update(state, (value): SessionState => ({
          ...value,
          clock: { ...value.clock, status: "stopped" },
        })),
      ),
      Effect.forkScoped,
    );
    const session = yield* host(SessionProtocol, (implement) =>
      implement({
        changes: () => SubscriptionRef.changes(state),
        terminate: () => worker.terminate,
        reloadRenderer: ({ owner }) => {
          const window = windows.get(owner);
          return window === undefined
            ? Effect.fail(
                new SewedError({
                  code: "Closed",
                  message: `Renderer owner ${owner} is closed`,
                }),
              )
            : window.webContents.reload;
        },
        recoverRenderer: ({ owner }) => {
          const window = windows.get(owner);
          return window === undefined
            ? Effect.fail(
                new SewedError({ code: "Closed", message: `Renderer owner ${owner} is closed` }),
              )
            : window.webContents.recover;
        },
      }),
    );

    const backgroundReady = yield* Deferred.make<void, unknown>();
    const backgroundJob = Effect.gen(function* () {
      const compute = yield* Compute();
      let firstProgress = true;
      yield* compute.background().pipe(
        Stream.runForEach(({ thread, sourceThread, ticks }) =>
          Effect.gen(function* () {
            yield* SubscriptionRef.update(state, (value): SessionState => ({
              ...value,
              background: { status: "running", thread, sourceThread, ticks },
            }));
            if (firstProgress) {
              firstProgress = false;
              const current = yield* SubscriptionRef.get(state);
              yield* Effect.annotateLogs(Effect.logInfo("playground.background.started"), {
                thread,
                sourceThread,
                windows: current.windows.length,
              });
              yield* Deferred.succeed(backgroundReady, undefined);
            }
          }),
        ),
      );
    }).pipe(
      Effect.provide(Binding.layer([Binding.to(Compute, worker)])),
      Effect.catchCause((cause) => Deferred.failCause(backgroundReady, cause).pipe(Effect.asVoid)),
      Effect.ensuring(
        SubscriptionRef.update(state, (value): SessionState => ({
          ...value,
          background: { status: "stopped" },
        })),
      ),
    );
    yield* backgroundJob.pipe(Effect.forkScoped);
    yield* Deferred.await(backgroundReady);

    return {
      owner: session,
      observeWindow: (name: string, window: BrowserWindow.Handle) =>
        Effect.gen(function* () {
          windows.set(window.id, window);
          yield* SubscriptionRef.update(state, (value): SessionState => ({
            ...value,
            windows: [
              ...value.windows,
              {
                name,
                owner: window.id,
                contents: { status: "idle" },
                responsiveness: { status: "unknown" },
              },
            ],
          }));
          yield* window.awaitClosed.pipe(
            Effect.andThen(
              Effect.sync(() => {
                windows.delete(window.id);
              }),
            ),
            Effect.andThen(
              SubscriptionRef.update(state, (value) => ({
                ...value,
                windows: value.windows.filter((entry) => entry.owner !== window.id),
              })),
            ),
            Effect.forkScoped,
          );
          yield* window.webContents.state.pipe(
            Stream.runForEach((contents) =>
              SubscriptionRef.update(state, (value) => ({
                ...value,
                windows: value.windows.map((entry) =>
                  entry.owner === window.id ? { ...entry, contents } : entry,
                ),
              })),
            ),
            Effect.ensuring(
              Effect.annotateLogs(Effect.logInfo("playground.contents.observer.closed"), {
                owner: window.id,
                name,
              }),
            ),
            Effect.forkScoped,
          );
          yield* window.webContents.responsiveness.pipe(
            Stream.runForEach((responsiveness) =>
              SubscriptionRef.update(state, (value) => ({
                ...value,
                windows: value.windows.map((entry) =>
                  entry.owner === window.id ? { ...entry, responsiveness } : entry,
                ),
              })),
            ),
            Effect.forkScoped,
          );
        }),
    };
  });
