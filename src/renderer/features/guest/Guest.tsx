import { useState } from "react";
import { useGuest } from "./use-guest.js";

export function Guest() {
  const guest = useGuest();
  const [draft, setDraft] = useState("");
  const url = guest.state !== undefined && "url" in guest.state ? guest.state.url : undefined;

  return (
    <div className="experiment-grid guest-experiment">
      <div className="experiment-content">
        <h3>A guest tab, driven through a hosted owner.</h3>
        <p>
          Main owns a guest view with a pattern navigation policy and hosts it behind a policy
          that grants navigation and capture. The renderer binds that owner like any other.
        </p>
        <div className="surface-card">
          <span className="component-caption">Guest state</span>
          <output data-guest-state={guest.state?.status} data-guest-url={url} aria-live="polite">
            {guest.state === undefined
              ? "Connecting"
              : url === undefined
                ? guest.state.status
                : `${guest.state.status} · ${url}`}
          </output>
          <input
            data-guest-url-input
            aria-label="Guest URL"
            placeholder="http://localhost:…/two"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
          <div className="experiment-actions">
            <button
              data-guest-go
              disabled={guest.busy || draft === ""}
              onClick={() => {
                guest.navigate(draft);
              }}
            >
              Go
            </button>
            <button
              data-guest-back
              disabled={guest.history !== undefined && !guest.history.canGoBack}
              onClick={() => {
                guest.back();
              }}
            >
              Back
            </button>
            <button
              data-guest-forward
              disabled={guest.history !== undefined && !guest.history.canGoForward}
              onClick={() => {
                guest.forward();
              }}
            >
              Forward
            </button>
            <button
              data-guest-capture
              disabled={guest.busy}
              onClick={() => {
                guest.capture();
              }}
            >
              Capture
            </button>
          </div>
          <output data-guest-capture-bytes={guest.captured} aria-live="polite">
            {guest.captured === undefined ? "No capture yet" : `${guest.captured} PNG bytes`}
          </output>
          <output data-guest-error aria-live="polite">
            {guest.error ?? ""}
          </output>
        </div>
      </div>
    </div>
  );
}
