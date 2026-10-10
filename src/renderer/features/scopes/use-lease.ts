import { Cause, Effect, Match } from "effect";
import { useAction } from "@sewed/react";
import { Rejected } from "../../../shared/contracts.js";

export function useLease(update: (change: (value: number) => number) => void) {
  const resource = useAction((fail = false) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          update((count) => count + 1);
        }),
        () =>
          Effect.sync(() => {
            update((count) => count - 1);
          }),
      );
      if (fail)
        return yield* Effect.fail(
          new Rejected({ message: "Failure released the invocation scope." }),
        );
      return "The action finished. Its scope still owns the lease.";
    }),
  );
  const message = Match.value(resource).pipe(
    Match.when({ status: "success" }, ({ value }) => value),
    Match.when({ status: "failure" }, ({ cause }) => Cause.pretty(cause)),
    Match.when({ status: "interrupted" }, () => "Scope closed. Lease released."),
    Match.whenOr(
      { status: "idle" },
      { status: "running" },
      () => "Acquire a resource in an action's scope.",
    ),
    Match.exhaustive,
  );
  return { run: resource.run, cancel: resource.cancel, message };
}
