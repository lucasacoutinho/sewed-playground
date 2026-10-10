import { useState } from "react";
import { useClipboard, usePower, useTheme, useZoom } from "./use-surfaces.js";

export function Surfaces() {
  const theme = useTheme();
  const clipboard = useClipboard();
  const power = usePower();
  const zoom = useZoom();
  const [draft, setDraft] = useState("Copied from the playground");
  const error = theme.error ?? clipboard.error ?? power.error ?? zoom.error;

  return (
    <div className="experiment-grid surfaces-experiment">
      <div className="experiment-content">
        <h3>Native surfaces, hosted by main.</h3>
        <p>
          Theme, clipboard, and power are library owners with a policy chosen in main. The
          renderer binds them like any other owner.
        </p>
        <div
          className="surface-card"
          data-theme-source={theme.state?.source}
          data-dark={theme.state === undefined ? undefined : String(theme.state.shouldUseDarkColors)}
        >
          <span className="component-caption">Theme</span>
          <output data-theme-state aria-live="polite">
            {theme.state === undefined
              ? "Connecting"
              : `${theme.state.source} · ${theme.state.shouldUseDarkColors ? "dark" : "light"}`}
          </output>
          <div className="experiment-actions">
            <button
              data-theme-dark
              onClick={() => {
                theme.set("dark");
              }}
            >
              Dark
            </button>
            <button
              data-theme-light
              onClick={() => {
                theme.set("light");
              }}
            >
              Light
            </button>
            <button
              data-theme-system
              onClick={() => {
                theme.set("system");
              }}
            >
              System
            </button>
          </div>
        </div>
        <div className="surface-card">
          <span className="component-caption">Clipboard</span>
          <input
            data-clipboard-input
            aria-label="Text to copy"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
          <div className="experiment-actions">
            <button
              data-clipboard-write
              disabled={clipboard.busy}
              onClick={() => {
                clipboard.write(draft);
              }}
            >
              Copy
            </button>
            <button
              data-clipboard-read
              disabled={clipboard.busy}
              onClick={() => {
                clipboard.read();
              }}
            >
              Read
            </button>
          </div>
          <output data-clipboard-value aria-live="polite">
            {clipboard.value === undefined
              ? "Nothing read yet"
              : clipboard.value === null
                ? "Clipboard has no text"
                : clipboard.value.kind === "text"
                  ? clipboard.value.text
                  : "Unexpected content"}
          </output>
        </div>
        <div className="surface-card">
          <span className="component-caption">Power</span>
          <div className="experiment-actions">
            <button
              data-power-refresh
              onClick={() => {
                power.refresh();
              }}
            >
              Read power state
            </button>
          </div>
          <output data-power-state={power.state === undefined ? undefined : JSON.stringify(power.state)}>
            {power.state === undefined
              ? "Not read yet"
              : `${power.state.onBattery ? "On battery" : "On mains"} · ${power.state.idleState} · thermal ${power.state.thermal}`}
          </output>
        </div>
        <div className="surface-card" data-zoom={zoom.factor}>
          <span className="component-caption">Window zoom</span>
          <output data-zoom-value aria-live="polite">
            {zoom.factor === undefined ? "Connecting" : `${Math.round(zoom.factor * 100)}%`}
          </output>
          <div className="experiment-actions">
            <button
              data-zoom-in
              onClick={() => {
                zoom.set(1.25);
              }}
            >
              Zoom to 125%
            </button>
            <button
              data-zoom-reset
              onClick={() => {
                zoom.set(1);
              }}
            >
              Reset zoom
            </button>
          </div>
        </div>
        {error !== null && (
          <output className="inline-error" role="alert" data-surfaces-error>
            {error}
          </output>
        )}
      </div>
    </div>
  );
}
