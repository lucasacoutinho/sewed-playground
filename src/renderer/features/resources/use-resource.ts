import { useState } from "react";
import { Cause, Effect, Match, Stream } from "effect";
import { useAction, useResource as useScopedResource } from "@sewed/react";
import { Remote } from "sewed";
import { ByteResource, Resources } from "../../../shared/resources.js";

export function useResource() {
  const [received, setReceived] = useState(0);
  const lease = useScopedResource(
    () =>
      Effect.gen(function* () {
        const handle = yield* Remote.acquire(ByteResource, Resources, { seed: 37 });
        const identity = yield* handle.client.inspect();
        return { handle, identity };
      }),
    [],
  );
  const transfer = useAction(() =>
    Effect.gen(function* () {
      if (lease.status !== "ready") return yield* Effect.fail("Acquire a resource first.");
      yield* Effect.sync(() => setReceived(0));
      const start = performance.now();
      const bytes = yield* lease.value.handle.client.read({ chunks: 512 }).pipe(
        Stream.runFold(
          () => 0,
          (count, chunk) => {
            const total = count + chunk.byteLength;
            setReceived(total);
            return total;
          },
        ),
      );
      return { bytes, milliseconds: Math.round(performance.now() - start) };
    }),
  );
  const release = () => {
    transfer.cancel();
    lease.release();
  };
  const reload = () => {
    transfer.cancel();
    lease.reload();
  };
  const resourceMessage = Match.value(lease).pipe(
    Match.when(
      { status: "ready" },
      ({ value }) =>
        `Owned by worker thread ${value.identity.thread}. Seed ${value.identity.seed}.`,
    ),
    Match.when({ status: "failure" }, ({ cause }) => Cause.pretty(cause)),
    Match.when({ status: "loading" }, () => "Acquiring a worker resource…"),
    Match.when({ status: "releasing" }, () => "Waiting for the worker resource to close…"),
    Match.when({ status: "released" }, () => "Resource released. Acquire another to continue."),
    Match.exhaustive,
  );
  const transferMessage = Match.value(transfer).pipe(
    Match.when(
      { status: "success" },
      ({ value }) => `Received ${value.bytes / 1024 / 1024} MiB in ${value.milliseconds} ms.`,
    ),
    Match.when({ status: "failure" }, ({ cause }) => Cause.pretty(cause)),
    Match.when({ status: "running" }, () => "Streaming 64 KiB chunks through the private port…"),
    Match.when(
      { status: "interrupted" },
      () => "Transfer cancelled. The resource can be used again.",
    ),
    Match.when({ status: "idle" }, () => "The renderer counts bytes as they arrive."),
    Match.exhaustive,
  );
  return { lease, transfer, release, reload, received, resourceMessage, transferMessage };
}
