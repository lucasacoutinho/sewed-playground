import { Match } from "effect";
import { useWindowControls } from "./use-window-controls.js";

export function MainLane({ label, processId }: { label: string; processId: number | undefined }) {
  const { native, run, commandError, stateError } = useWindowControls();
  const windowStatus = Match.value(native).pipe(
    Match.when(undefined, () => "Connecting"),
    Match.when({ maximized: true }, () => "Maximized"),
    Match.when({ minimized: true }, () => "Minimized"),
    Match.orElse(() => "Restored"),
  );

  return (
    <section
      className="lane main-lane"
      aria-labelledby="main-title"
      data-native={JSON.stringify(native)}
    >
      <div className="lane-heading">
        <span className="owner-symbol main-symbol" aria-hidden="true" />
        <h2 id="main-title">Main</h2>
        <span className="lane-tag">Native owner</span>
      </div>
      <p className="lane-description">App lifetime and native windows.</p>
      <div className="runtime-display native-display">
        <div className="runtime-caption">
          <span>Window {label}</span>
          <span className="native-state" data-native-state>
            {windowStatus}
          </span>
        </div>
        <div className="window-preview" data-maximized={native?.maximized} aria-hidden="true">
          <div className="window-preview-bar">
            <i />
            <i />
            <i />
          </div>
          <span>{label}</span>
          <div className="window-preview-sidebar" />
        </div>
        <div className="runtime-footnote">
          <span>Process {processId ?? "…"}</span>
          <span>{native?.focused ? "Focused" : "Background"}</span>
        </div>
      </div>
      <div className="window-actions">
        <button
          data-maximize
          onClick={() => {
            run("maximize");
          }}
        >
          Maximize
        </button>
        <button
          data-restore
          onClick={() => {
            run("restore");
          }}
        >
          Restore
        </button>
        <button
          data-minimize
          onClick={() => {
            run("minimize");
          }}
        >
          Minimize
        </button>
      </div>
      <p className="lane-note">
        This binding controls window {label}. The other window keeps its own state.
      </p>
      {commandError !== null && (
        <output className="inline-error" role="alert">
          {commandError}
        </output>
      )}
      {stateError !== null && (
        <output className="inline-error" role="alert">
          {stateError}
        </output>
      )}
      <code className="source-path">main/app.ts</code>
    </section>
  );
}
