# Application-owned work

## Behavior

The background readout shows a compute thread, a clock thread, and advancing ticks.
Main starts this work before creating either window. Both windows observe the same job;
opening a route or a second window does not start another copy.

Stopping Compute releases its clock subscription while the clock owner remains alive.
Closing the final window releases the remaining application owners.

## Ownership

The application scope owns the clock and compute workers and the background subscription.
Main provides Compute through `Binding.layer`, and Compute consumes its declared `Clock`
binding. The renderer receives observations through the Session owner; it does not own
the stream or either worker.

## Lifetime

Application-owned work starts before the native-window lifetime and survives renderer
reloads and the closure of one window. The subscription ends when its Compute owner
stops or when the application scope shuts down. A stopped owner stays stopped; reload
does not silently create a replacement worker.

## Contracts and dependencies

The Compute protocol and Clock binding are declared in shared code. Main chooses the
worker instances and binds them before starting the subscription. The dependency is
therefore visible in the composition rather than hidden in the worker implementation.

## Source

- [`src/main/app.ts`](../../src/main/app.ts) creates workers and starts the application.
- [`src/main/session.ts`](../../src/main/session.ts) starts and observes the background job.
- [`src/worker/compute.ts`](../../src/worker/compute.ts) consumes the Clock dependency.
- [`src/worker/clock.ts`](../../src/worker/clock.ts) owns the timer stream.
- [`src/renderer/features/background/ApplicationWork.tsx`](../../src/renderer/features/background/ApplicationWork.tsx)
  renders the readout.

## Verification

The metadata entry is `background`:

```sh
pnpm verify:features background
```

Its scenarios cover `background-start`, `worker-dependency`, `background-reload`,
`dependency-cleanup`, `background-window-close`, `background-shutdown`, and
`clock-shutdown`. Use `pnpm verify:lifecycle` for the native lifecycle fixture.

## Limits

The example demonstrates one application-owned subscription and one dependency chain.
It does not define a general policy for which work every Electron application should
keep alive after its windows close.
