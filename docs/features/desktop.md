# Desktop windows

## Behavior

Startup opens Window A and Window B. Each window has a local counter and native
maximize, restore, minimize, reload, and close controls. Both windows observe the same
Compute, Session, and Resources owners while each keeps a distinct Controls owner.

Maximizing or incrementing one window leaves the other window's native state and local
React state unchanged. Closing one window updates the remaining ownership list. Closing
the final window ends the application scope and releases application work.

## Ownership

Main creates the native windows and binds one `Controls` slot to each window. `Compute`,
`Session`, and `Resources` are shared application owners. The renderer receives those
clients when main loads its entry through `window.webContents.load`.

## Lifetime

A native window and its renderer document have separate lifetimes. Reload creates a new
document and resets document-local state while the window, workers, and shared bindings
remain alive. Closing a window releases its controls and document connections; closing
the final window releases the application scope.

## Contracts and dependencies

Window bindings are declared in [`src/shared/bindings.ts`](../../src/shared/bindings.ts).
Main supplies the selected instances through Sewed's renderer entry. The desktop
provider keeps window-level clients above the route outlet so route changes do not
recreate them.

## Source

- [`src/main/app.ts`](../../src/main/app.ts) composes the application and native windows.
- [`src/main/session.ts`](../../src/main/session.ts) observes windows and application state.
- [`src/renderer/app/desktop-context.tsx`](../../src/renderer/app/desktop-context.tsx)
  provides the shared clients to the renderer.
- [`src/renderer/features/window/MainLane.tsx`](../../src/renderer/features/window/MainLane.tsx)
  renders the native controls.
- [`src/renderer/features/window/use-window-controls.ts`](../../src/renderer/features/window/use-window-controls.ts)
  exposes the control actions.

## Verification

The metadata entry is `desktop`. Inspect it with:

```sh
pnpm verify:features desktop
```

The scenarios are `shared-worker`, `window-isolation`, and `window-shutdown`. Native
window checks use `pnpm verify:windows` and `pnpm verify:app`.
The window fixture verifies direct and bound fullscreen transitions, and reads
content bounds on demand because X11 frame extents can change without another event.
The application lifecycle fixture also checks that relative application paths
fail before creating directories.

## Limits

The playground demonstrates two windows on the supported Electron test display. It does
not claim that arbitrary consumer window policies, display servers, or operating-system
window managers behave identically.
