import { Match } from "effect";
import type { WebContents } from "sewed";
import type { SessionState } from "../../../shared/contracts.js";
import { useRenderers } from "./use-renderers.js";

function describeContents(contents: WebContents.State) {
  return Match.value(contents).pipe(
    Match.when({ status: "idle" }, () => ({
      label: "Idle",
      detail: "Waiting for the first document load.",
    })),
    Match.when({ status: "loading" }, ({ url }) => ({
      label: "Loading",
      detail: url,
    })),
    Match.when({ status: "ready" }, ({ url, processId }) => ({
      label: "Ready",
      detail: `Renderer PID ${processId} · ${url}`,
    })),
    Match.when({ status: "failed" }, ({ url, code, description }) => ({
      label: "Failed",
      detail: `${description} (code ${code}) · ${url}`,
    })),
    Match.when({ status: "gone" }, ({ reason, exitCode }) => ({
      label: "Gone",
      detail: `${reason} (exit ${exitCode})`,
    })),
    Match.exhaustive,
  );
}

export function Renderers({ windows }: { windows: SessionState["windows"] | undefined }) {
  const { reload, recover, reloadError, recoveryError } = useRenderers();
  const renderWindowContent = () => {
    if (windows === undefined) {
      return <p className="renderers-empty">Connecting to the main process…</p>;
    }
    if (windows.length === 0) {
      return <p className="renderers-empty">No native windows remain.</p>;
    }
    return (
      <div className="renderers-grid">
        {windows.map((window) => {
          const readout = describeContents(window.contents);
          const label = window.name === "first" ? "A" : "B";
          const health = Match.value(window.responsiveness).pipe(
            Match.when({ status: "unknown" }, () => "Waiting for a native response"),
            Match.when({ status: "responsive" }, () => "Responsive"),
            Match.when({ status: "unresponsive" }, () => "Not responding"),
            Match.exhaustive,
          );
          return (
            <article
              className="renderer-card"
              data-renderer-owner={window.owner}
              data-renderer-state={window.contents.status}
              data-renderer-responsiveness={window.responsiveness.status}
              key={window.owner}
            >
              <div className="renderer-card-heading">
                <div>
                  <span className="renderer-card-kicker">Window {label}</span>
                  <h4>{window.name}</h4>
                </div>
                <span className="renderer-state">{readout.label}</span>
              </div>
              <p className="renderer-detail">{readout.detail}</p>
              <p className="renderer-detail">{health}</p>
              <button
                data-reload-renderer={window.owner}
                disabled={reload.status === "running"}
                onClick={() => {
                  reload.run(window.owner);
                }}
              >
                Reload renderer
              </button>
              <button
                data-recover-renderer={window.owner}
                disabled={
                  recover.status === "running" ||
                  (window.responsiveness.status !== "unresponsive" &&
                    window.contents.status !== "gone")
                }
                onClick={() => recover.run(window.owner)}
              >
                Restart renderer
              </button>
            </article>
          );
        })}
      </div>
    );
  };

  return (
    <div className="renderers-panel">
      <div className="renderers-intro">
        <div>
          <h3>Native windows report their document lifecycle.</h3>
          <p>
            Main observes document loading and native responsiveness. Another window can request a
            reload or restart while the native window and workers stay alive.
          </p>
        </div>
        <span className="renderers-count">{windows?.length ?? "…"} windows</span>
      </div>

      {renderWindowContent()}

      {reloadError !== null && (
        <output className="inline-error" data-renderer-error role="alert">
          {reloadError}
        </output>
      )}
      {recoveryError !== null && (
        <output className="inline-error" data-recovery-error role="alert">
          {recoveryError}
        </output>
      )}
    </div>
  );
}
