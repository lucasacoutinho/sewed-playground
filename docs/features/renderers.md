# Renderer recovery

## Behavior

The `/renderers` route lists native window owners, document states, renderer process
information, and responsiveness. A surviving window can request a reload or explicitly
recover another renderer through the Session owner in main.

Renderer process loss releases interruptible document requests while native windows and
shared workers survive. Recovery reloads the existing window owner, replacing the
renderer process without replacing its native controls or worker bindings.

## Ownership

Main observes each window's `webContents.state` and `webContents.responsiveness` streams.
Those observers belong to the native window lifetime, not the renderer document. The
Session owner exposes recovery commands to the renderer through the declared binding.

## Lifetime

Reload or process loss ends the document lifetime and its connections. The native window
and application workers remain alive. Recovery targets that surviving native owner. A
window close releases its observers; final application shutdown releases the remaining
owners.

## Contracts and dependencies

Session commands and renderer observations use the shared contracts and a main-owned
Session binding. The renderer dispatches a typed command and renders the resulting
state; native fault injection stays in the harness.

## Source

- [`src/main/session.ts`](../../src/main/session.ts) owns lifecycle observers and recovery.
- [`src/shared/contracts.ts`](../../src/shared/contracts.ts) declares session messages.
- [`src/renderer/features/renderers/Renderers.tsx`](../../src/renderer/features/renderers/Renderers.tsx)
  renders the lifecycle panel.
- [`src/renderer/features/renderers/use-renderers.ts`](../../src/renderer/features/renderers/use-renderers.ts)
  dispatches recovery commands.
- [`src/renderer/routes/renderers.tsx`](../../src/renderer/routes/renderers.tsx) mounts the route.

## Verification

The metadata entry is `renderers`:

```sh
pnpm verify:features renderers
```

Its scenarios are `renderer-loss` and `renderer-recovery`. Use
`pnpm verify:responsiveness` for real Chromium unresponsive/responsive events and
`pnpm verify:webcontents` for the lower-level navigation and WebContents fixture.

## Limits

The harness induces renderer loss and hangs in controlled Electron fixtures. A recovery
operation proves the selected owner can reload; it does not guarantee recovery from
every operating-system or GPU failure.
