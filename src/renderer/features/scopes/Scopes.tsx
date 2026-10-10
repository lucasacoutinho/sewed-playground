import { useState } from "react";
import { useLease } from "./use-lease.js";

function Lease({ update }: { update: (change: (value: number) => number) => void }) {
  const resource = useLease(update);

  return (
    <div className="lease-component">
      <span className="component-caption">Mounted React component</span>
      <div className="experiment-actions">
        <button
          data-lease
          onClick={() => {
            resource.run();
          }}
        >
          Acquire lease
        </button>
        <button data-release onClick={resource.cancel}>
          Release lease
        </button>
        <button
          data-lease-fail
          onClick={() => {
            resource.run(true);
          }}
        >
          Fail with a lease
        </button>
      </div>
      <output data-lease-result aria-live="polite">
        {resource.message}
      </output>
    </div>
  );
}

export function Scopes() {
  const [leased, setLeased] = useState(0);
  const [mounted, setMounted] = useState(true);

  return (
    <div className="experiment-grid scope-experiment">
      <div className="experiment-content">
        <h3>A resource has a lifetime, too.</h3>
        <p>
          This local renderer lease survives a successful action. Replacement, cancellation,
          failure, and component unmount close its scope.
        </p>
        {mounted ? (
          <Lease update={setLeased} />
        ) : (
          <div className="unmounted-component">
            Component unmounted. Its resources have been released.
          </div>
        )}
      </div>
      <aside className="scope-summary">
        <div className="lease-value" data-lease-count={leased}>
          <strong>{leased}</strong>
          <span>active {leased === 1 ? "lease" : "leases"}</span>
        </div>
        <button
          data-unmount
          onClick={() => {
            setMounted((value) => !value);
          }}
        >
          {mounted ? "Unmount component" : "Mount component"}
        </button>
        <small>The component's state belongs to this renderer.</small>
      </aside>
    </div>
  );
}
