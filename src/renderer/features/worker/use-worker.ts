import { useState } from "react";
import { Cause, Match, Stream } from "effect";
import { useAction, useClient, useStream } from "@sewed/react";
import { Compute } from "../../../shared/bindings.js";

type RequestKind = "cpu" | "slow" | "latest";

export function useWorker(available: boolean) {
  const compute = useClient(Compute, { connection: "shared" });
  const [kind, setKind] = useState<RequestKind>("cpu");
  const info = useStream(
    () => (available ? compute.changes() : Stream.empty),
    [available, compute],
  );
  const snapshot = info.status === "value" ? info.value : undefined;
  const rejected = useAction(() => compute.reject());
  const work = useAction((request: RequestKind) =>
    Match.value(request).pipe(
      Match.when("cpu", () => compute.compute({ milliseconds: 1200, label: "CPU completed" })),
      Match.when("slow", () =>
        compute.wait({ milliseconds: 5000, label: "Slow request completed" }),
      ),
      Match.when("latest", () => compute.wait({ milliseconds: 20, label: "latest" })),
      Match.exhaustive,
    ),
  );

  const run = (request: RequestKind) => {
    setKind(request);
    work.run(request);
  };
  return {
    kind,
    work,
    run,
    info,
    snapshot,
    rejected,
    available,
    workError: work.status === "failure" ? Cause.pretty(work.cause) : null,
    infoError: info.status === "failure" ? Cause.pretty(info.cause) : null,
    rejection: rejected.status === "failure" ? Cause.pretty(rejected.cause) : null,
  };
}

export type WorkerModel = ReturnType<typeof useWorker>;
