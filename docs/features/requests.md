# Worker requests

## Behavior

The request lifetime panel can start a CPU loop, start a slow interruptible request,
replace pending work, cancel it, and request a typed error. The worker snapshot shows
active waits and released handlers in both windows.

Replacing a slow request releases its previous handler before the new invocation takes
over. Cancelling an interruptible wait releases its handler without stopping the
worker. A `Rejected` error reaches the UI as data in the request state. Stopping Compute
fails pending calls and disables compute controls in both windows.

## Ownership

The compute worker owns the CPU loop and slow-request handlers. `useAction` owns the
calling invocation in the renderer document and replaces the previous invocation when a
new request starts. The desktop provider keeps that action client above the route
outlet, so changing tabs does not cancel it.

## Lifetime

An invocation ends through success, replacement, cancellation, failure, document loss,
or document reload. Reload closes renderer connections and interrupts interruptible
work while application-owned workers remain alive. A stopped Compute owner remains
stopped across reloads.

## Contracts and dependencies

The request protocol and `Rejected` error schema are declared in
[`src/shared/contracts.ts`](../../src/shared/contracts.ts). The worker implements those
handlers and exposes them through the Compute binding. The renderer hook consumes only
the typed client.

## Source

- [`src/shared/contracts.ts`](../../src/shared/contracts.ts) declares the request protocol.
- [`src/worker/compute.ts`](../../src/worker/compute.ts) implements CPU, wait, and error
  handlers.
- [`src/renderer/features/worker/use-worker.ts`](../../src/renderer/features/worker/use-worker.ts)
  owns the action and request state.
- [`src/renderer/features/worker/Requests.tsx`](../../src/renderer/features/worker/Requests.tsx)
  renders request controls.
- [`src/renderer/features/worker/WorkerLane.tsx`](../../src/renderer/features/worker/WorkerLane.tsx)
  renders worker identity and handler observations.
- [`src/renderer/routes/index.tsx`](../../src/renderer/routes/index.tsx) composes the route.

## Verification

The metadata entry is `requests`:

```sh
pnpm verify:features requests
```

Its scenarios are `typed-errors`, `request-replacement`, `request-cancellation`,
`document-reload`, `worker-exit`, and `stopped-owner-reload`. The normal Electron
verification run covers the request flow and explicit worker termination.

## Limits

Cancellation can interrupt the Effect wait and release its handler. It cannot preempt
the synchronous CPU loop once that JavaScript is running. The example also does not
measure throughput or guarantee that an arbitrary worker computation is fast.
