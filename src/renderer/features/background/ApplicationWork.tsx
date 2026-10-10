import { Match } from "effect";
import type { SessionState } from "../../../shared/contracts.js";

export function ApplicationWork({
  background,
}: {
  background: SessionState["background"] | undefined;
}) {
  const readout = Match.value(background).pipe(
    Match.when(undefined, () => ({
      label: "Connecting",
      description: "Waiting for the application snapshot.",
      thread: "—",
      clockThread: "—",
      ticks: "—",
    })),
    Match.when({ status: "starting" }, () => ({
      label: "Starting",
      description: "Waiting for the compute worker to read the first clock value.",
      thread: "—",
      clockThread: "—",
      ticks: "—",
    })),
    Match.when({ status: "running" }, ({ thread, sourceThread, ticks }) => ({
      label: "Running",
      description:
        "The compute worker reads ticks from a bound clock worker. Reload a renderer or close one window; this stream keeps running.",
      thread: String(thread),
      clockThread: String(sourceThread),
      ticks: String(ticks),
    })),
    Match.when({ status: "stopped" }, () => ({
      label: "Stopped",
      description: "The application-owned stream has stopped.",
      thread: "—",
      clockThread: "—",
      ticks: "—",
    })),
    Match.exhaustive,
  );

  return (
    <section
      className="application-work"
      data-app-work={JSON.stringify(background)}
      data-app-work-status={background?.status ?? "connecting"}
      aria-label="Application-owned work"
    >
      <div className="application-work-copy">
        <div className="application-work-heading">
          <div>
            <span className="application-work-kicker">Application-owned work</span>
            <h2>Main owns the worker stream.</h2>
          </div>
          <span
            className={`application-work-status application-work-status-${background?.status ?? "starting"}`}
          >
            <i />
            {readout.label}
          </span>
        </div>
        <p>{readout.description}</p>
      </div>
      <dl className="application-work-metrics">
        <div>
          <dt>Compute thread</dt>
          <dd>{readout.thread}</dd>
        </div>
        <div>
          <dt>Clock thread</dt>
          <dd>{readout.clockThread}</dd>
        </div>
        <div>
          <dt>Stream ticks</dt>
          <dd>{readout.ticks}</dd>
        </div>
      </dl>
    </section>
  );
}
