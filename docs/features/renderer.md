# Renderer responsiveness

## Behavior

The main route shows a renderer-local counter and heartbeat beside the worker and
native lanes. While a worker runs a CPU request, the counter and heartbeat continue to
advance and native controls remain responsive.

The renderer lane also reports document state, process information, and the latest
heartbeat. Its display is local to each document, so reloading a window starts a fresh
heartbeat without changing the shared worker owner.

## Ownership

React owns the counter and heartbeat presentation. The heartbeat is a scoped
`Stream.tick` subscription in the renderer document. Computation belongs to the worker;
the renderer only dispatches the request and displays its state.

## Lifetime

The heartbeat is acquired with the renderer document and released on reload, renderer
loss, route shell teardown, or window closure. A route change keeps the desktop provider
and renderer lane mounted. StrictMode may mount the component more than once during
development, so the hook must remain safe to acquire and release repeatedly.

## Contracts and dependencies

The lane consumes the typed Compute client supplied by the desktop provider and the
renderer's local `useHeartbeat` stream. It does not import main or worker
implementations. Worker execution and native responsiveness are separate observations:
an active heartbeat does not prove that arbitrary renderer JavaScript is inexpensive.

## Source

- [`src/renderer/features/renderer/RendererLane.tsx`](../../src/renderer/features/renderer/RendererLane.tsx)
  renders the renderer status and counter.
- [`src/renderer/features/renderer/use-heartbeat.ts`](../../src/renderer/features/renderer/use-heartbeat.ts)
  owns the scoped heartbeat stream.
- [`src/renderer/features/worker/use-worker.ts`](../../src/renderer/features/worker/use-worker.ts)
  dispatches the worker request displayed beside the lane.

## Verification

The metadata entry is `renderer`:

```sh
pnpm verify:features renderer
```

Its scenarios are `renderer-bundle`, `fast-refresh`, `cpu-responsive`, and
`accessible-layout`. The normal Electron run and `pnpm verify --dev` exercise the
renderer and Fast Refresh paths; `pnpm verify:responsiveness` measures native
unresponsive and responsive events separately.

## Limits

Worker placement prevents the demonstrated CPU loop from occupying the renderer. Sewed
cannot inspect the cost of arbitrary JavaScript that an application chooses to run in a
renderer, and a heartbeat is not a frame-rate or latency benchmark.
