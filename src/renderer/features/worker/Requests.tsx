import { Match } from "effect";
import type { WorkerModel } from "./use-worker.js";

export function Requests({ worker }: { worker: WorkerModel }) {
  const rejectionMessage = Match.value(worker.rejected.status).pipe(
    Match.when("failure", () => worker.rejection),
    Match.when("running", () => "Requesting an error…"),
    Match.whenOr("idle", "success", "interrupted", () => "Errors return across the same binding."),
    Match.exhaustive,
  );

  return (
    <div className="experiment-grid">
      <div className="experiment-content">
        <h3>A request belongs to its caller.</h3>
        <p>
          Start a 5-second wait. Replacing it or cancelling it releases the worker's handler.
          Reloading or closing this window does the same.
        </p>
        <div className="experiment-actions">
          <button
            data-slow
            disabled={!worker.available}
            onClick={() => {
              worker.run("slow");
            }}
          >
            Start slow request <small>5 s</small>
          </button>
          <button
            data-latest
            disabled={!worker.available}
            onClick={() => {
              worker.run("latest");
            }}
          >
            Replace with latest
          </button>
          <button
            data-cancel
            disabled={worker.work.status !== "running"}
            onClick={worker.work.cancel}
          >
            Cancel request
          </button>
        </div>
        <p className="experiment-hint">
          CPU work is synchronous; cancellation cannot preempt its loop. This wait is interruptible.
        </p>
      </div>
      <aside
        className="worker-snapshot"
        aria-label="Worker snapshot"
        data-info-status={worker.info.status}
      >
        <div className="snapshot-heading">
          <h3>Worker snapshot</h3>
          <span>{worker.available ? "Live stream" : "Disconnected"}</span>
        </div>
        <dl>
          <div>
            <dt>Active waits</dt>
            <dd>{worker.snapshot?.active ?? (worker.available ? "…" : "—")}</dd>
          </div>
          <div>
            <dt>Released handlers</dt>
            <dd>{worker.snapshot?.released ?? (worker.available ? "…" : "—")}</dd>
          </div>
        </dl>
        <button
          className="text-button error-trigger"
          data-reject
          disabled={!worker.available}
          onClick={() => {
            worker.rejected.run();
          }}
        >
          Try a typed worker error
        </button>
        <output className="error-output" data-error aria-live="polite">
          {rejectionMessage}
        </output>
        {worker.info.status === "failure" && (
          <output className="inline-error" role="alert">
            {worker.infoError}
          </output>
        )}
      </aside>
    </div>
  );
}
