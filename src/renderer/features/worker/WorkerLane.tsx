import { Match } from "effect";
import type { WorkerModel } from "./use-worker.js";

function requestMessage({ work, kind }: WorkerModel, stopped: boolean): string {
  switch (work.status) {
    case "idle":
      return "The renderer sends a typed request.";
    case "running":
      return kind === "cpu" ? "Computing in the worker…" : "Waiting in the worker…";
    case "success":
      return work.value.label === "latest" ? "Latest result received" : work.value.label;
    case "failure":
      return stopped ? "Worker exited. Request ended." : "Request failed.";
    case "interrupted":
      return "Request cancelled";
  }
}

export function WorkerLane({ worker, stopped }: { worker: WorkerModel; stopped: boolean }) {
  const { snapshot, work } = worker;
  const running = work.status === "running";
  const status = Match.value({ stopped, available: worker.available, running }).pipe(
    Match.when({ stopped: true }, () => "Stopped"),
    Match.when({ available: false }, () => "Connecting"),
    Match.when({ running: true }, () => "Request pending"),
    Match.orElse(() => "Ready"),
  );

  return (
    <section className="lane worker-lane" aria-labelledby="worker-title">
      <div className="lane-heading">
        <span className="owner-symbol worker-symbol" aria-hidden="true" />
        <h2 id="worker-title">Worker</h2>
        <span className="lane-tag">Shared owner</span>
      </div>
      <p className="lane-description">CPU work on a separate Node thread.</p>
      <div className="runtime-display worker-display" data-busy={running && !stopped}>
        <div className="runtime-caption">
          <span>
            Thread <b data-thread>{snapshot?.thread ?? (stopped ? "—" : "…")}</b>
          </span>
          <span data-worker-status>{status}</span>
        </div>
        <div className="worker-glyph" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="runtime-footnote">
          <span>{stopped ? "Owner exited" : "One instance"}</span>
          <span>{stopped ? "Calls disabled" : "Bound to both windows"}</span>
        </div>
      </div>
      <button
        className="primary-button"
        data-cpu
        disabled={!worker.available || running}
        onClick={() => {
          worker.run("cpu");
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="m5 3 8 5-8 5Z" />
        </svg>
        <span>Run CPU work</span>
        <small>1.2 s</small>
      </button>
      <div
        className="work-result"
        data-work-status={work.status}
        data-work-result={work.status === "success" ? work.value.label : ""}
      >
        <output data-work aria-live="polite">
          {requestMessage(worker, stopped)}
        </output>
        {work.status === "success" && work.value.iterations > 0 && (
          <small>
            {work.value.iterations.toLocaleString()} iterations on thread {work.value.thread}
          </small>
        )}
        {work.status === "failure" && (
          <details className="error-details">
            <summary>Error details</summary>
            <pre>{worker.workError}</pre>
          </details>
        )}
      </div>
      <code className="source-path">worker/compute.ts</code>
    </section>
  );
}
