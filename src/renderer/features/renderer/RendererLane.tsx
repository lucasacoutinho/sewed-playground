import { useState } from "react";
import { useHeartbeat } from "./use-heartbeat.js";

export function RendererLane({ label }: { label: string }) {
  const ticks = useHeartbeat();
  const [count, setCount] = useState(0);

  return (
    <section className="lane renderer-lane" aria-labelledby="renderer-title">
      <div className="lane-heading">
        <span className="owner-symbol renderer-symbol" aria-hidden="true" />
        <h2 id="renderer-title">Renderer</h2>
        <span className="lane-tag">This window</span>
      </div>
      <p className="lane-description">React, local state, and the interface.</p>
      <div className="runtime-display">
        <div className="runtime-caption">
          <span>Event loop</span>
          <span className="status-dot">Live</span>
        </div>
        <div className="heartbeat" aria-hidden="true">
          {Array.from({ length: 24 }, (_, index) => (
            <i key={index} className={index === ticks % 24 ? "beat-current" : ""} />
          ))}
        </div>
        <div className="runtime-footnote">
          <span>
            <b data-ticks>{ticks}</b> timer ticks
          </span>
          <span>Every 50 ms</span>
        </div>
      </div>
      <button
        className="local-button"
        data-local
        data-count={count}
        onClick={() => {
          setCount((value) => value + 1);
        }}
      >
        <span>Click while the worker is busy</span>
        <strong>
          {count}
          <span className="count-plus" aria-hidden="true">
            +
          </span>
        </strong>
      </button>
      <p className="lane-note">Only window {label}'s counter changes. Try it during CPU work.</p>
      <code className="source-path">renderer/</code>
    </section>
  );
}
