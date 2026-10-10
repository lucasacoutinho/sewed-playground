import { Link, Outlet } from "@tanstack/react-router";
import { Match } from "effect";
import { MainLane } from "../features/window/MainLane.js";
import { RendererLane } from "../features/renderer/RendererLane.js";
import { WorkerLane } from "../features/worker/WorkerLane.js";
import { ApplicationWork } from "../features/background/ApplicationWork.js";
import { useDesktop } from "./desktop-context.js";

export function AppShell() {
  const {
    name,
    label,
    snapshot,
    worker,
    stopped,
    terminate,
    close,
    sessionError,
    terminateError,
    closeError,
  } = useDesktop();
  const pending = worker.work.status === "running";
  const connectionMessage = Match.value(snapshot?.windows.length).pipe(
    Match.when(undefined, () => "Connecting to main…"),
    Match.when(1, () => "1 window open"),
    Match.orElse((count) => `${count} windows open`),
  );

  return (
    <main
      data-sewed-playground
      data-window={name}
      data-session={JSON.stringify(snapshot)}
      data-info={JSON.stringify(worker.snapshot)}
    >
      <header className="app-header">
        <div className="brand">
          <svg className="brand-mark" viewBox="0 0 30 30" aria-hidden="true">
            <path d="M6 8h12a6 6 0 0 1 0 12H6m18-15H12a6 6 0 0 0 0 12h12" />
            <path d="m10 2-2 26m14-26-2 26" />
          </svg>
          <strong>Sewed</strong>
          <span className="brand-divider" />
          <span>Playground</span>
        </div>
        <div className="header-actions">
          <span className="window-badge">Window {label}</span>
          <button
            className="text-button"
            data-reload
            onClick={() => {
              location.reload();
            }}
          >
            Reload renderer
          </button>
          <button
            className="icon-button close-button"
            data-close
            aria-label={`Close window ${label}`}
            onClick={() => {
              close.run();
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      </header>

      <div className="page-content">
        <div className="page-intro">
          <div>
            <h1>See where the work runs.</h1>
            <p>Two React windows. Dedicated workers. Explicit bindings.</p>
          </div>
          <div className="session-summary">
            <span className={stopped ? "session-dot stopped-dot" : "session-dot"} />
            {connectionMessage}
          </div>
        </div>

        {stopped && (
          <div className="stopped-banner" role="alert">
            <strong>The compute worker has stopped.</strong>
            <span>
              Renderer and native controls still work. The clock worker remains app-owned. Close the
              windows and run <code>pnpm start</code> to create a new worker.
            </span>
          </div>
        )}
        {sessionError !== null && (
          <output className="stopped-banner" role="alert">
            Session connection failed. {sessionError}
          </output>
        )}

        <div className="execution-map" data-request-pending={pending && !stopped}>
          <div
            className="binding-route"
            aria-label="Requests go from the renderer through a main-owned binding to the worker"
          >
            <span className="route-label">Typed request</span>
            <span className="route-line" />
            <span className="route-binding">Instance binding</span>
            <span className="route-line" />
            <span className="route-label">Owned execution</span>
          </div>
          <div className="lanes">
            <RendererLane label={label} />
            <MainLane label={label} processId={snapshot?.mainProcess} />
            <WorkerLane worker={worker} stopped={stopped} />
          </div>
          <div className="map-caption">
            <span>All panels are React UI. Calls cross boundaries through Sewed bindings.</span>
            <span className="boundary-legend">
              <i />
              Execution boundary
            </span>
          </div>
        </div>

        <ApplicationWork background={snapshot?.background} />

        <section className="experiments" aria-label="Boundary experiments">
          <nav className="experiment-tabs" aria-label="Experiments">
            <Link
              id="nav-requests"
              to="/"
              activeOptions={{ exact: true, includeSearch: false }}
              activeProps={{ "aria-current": "page" }}
            >
              Request lifetime
            </Link>
            <Link id="nav-scopes" to="/scopes" activeProps={{ "aria-current": "page" }}>
              React scopes
            </Link>
            <Link id="nav-source" to="/source" activeProps={{ "aria-current": "page" }}>
              Source boundaries
            </Link>
            <Link id="nav-renderers" to="/renderers" activeProps={{ "aria-current": "page" }}>
              Renderer lifecycle
            </Link>
            <Link id="nav-resources" to="/resources" activeProps={{ "aria-current": "page" }}>
              Remote data
            </Link>
            <Link id="nav-surfaces" to="/surfaces" activeProps={{ "aria-current": "page" }}>
              Desktop surfaces
            </Link>
            <Link id="nav-guest" to="/guest" activeProps={{ "aria-current": "page" }}>
              Guest tab
            </Link>
          </nav>
          <Outlet />
        </section>

        <footer className="app-footer">
          <p>
            A separate consumer of <code>sewed</code>
            <span>Local playground</span>
          </p>
          <div className="owner-lifetime">
            <span>Stops the compute worker for both windows.</span>
            <button
              className="text-button stop-button"
              data-terminate
              disabled={!worker.available || terminate.status === "running"}
              onClick={() => {
                terminate.run();
              }}
            >
              {stopped ? "Worker stopped" : "Stop worker"}
            </button>
          </div>
        </footer>
        {terminateError !== null && (
          <output className="inline-error" role="alert">
            {terminateError}
          </output>
        )}
        {closeError !== null && (
          <output className="inline-error" role="alert">
            {closeError}
          </output>
        )}
      </div>
    </main>
  );
}
