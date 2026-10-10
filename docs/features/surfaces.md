# Desktop surfaces hosted by main

## Behavior

The `/surfaces` route shows four native surfaces from the renderer: the theme source
with its dark or light result, a text clipboard round trip, a power snapshot, and the
window's zoom factor. Switching the theme updates the state in both windows, copying then
reading returns the same text, and zooming changes only the calling window.

## Ownership

Main hosts one owner per surface with `NativeTheme.host`, `Clipboard.host`, and
`PowerMonitor.host` and chooses the policy there: the theme owner allows source changes
and the clipboard owner allows text only. Zoom rides on the window's own controls owner,
so it targets the window that asked.

## Lifetime

The owners live in the application scope and serve every window. A renderer document's
clients close with the document; the owners and the native state stay.

## Contracts and dependencies

The renderer binds the library's `NativeTheme.protocol`, `Clipboard.protocol`, and
`PowerMonitor.protocol` through slots in `src/shared/bindings.ts` and drives them with
`@sewed/react`'s `useClient`, `useStream`, and `useAction`. Formats outside the
clipboard policy fail with `Protocol` before Electron runs.

## Source

- [`src/main/app.ts`](../../src/main/app.ts) hosts the owners and binds them per window.
- [`src/shared/bindings.ts`](../../src/shared/bindings.ts) declares the slots.
- [`src/renderer/features/surfaces/Surfaces.tsx`](../../src/renderer/features/surfaces/Surfaces.tsx)
  renders the cards.
- [`src/renderer/features/surfaces/use-surfaces.ts`](../../src/renderer/features/surfaces/use-surfaces.ts)
  wraps the bindings in hooks.
- [`src/renderer/routes/surfaces.tsx`](../../src/renderer/routes/surfaces.tsx) mounts the route.

## Verification

The metadata entry is `surfaces`:

```sh
pnpm verify:features surfaces
```

The `desktop-surfaces` scenario covers a theme switch observed through the state stream,
a clipboard copy and read of the same text, a power snapshot with a valid idle state, and
a zoom change on one window.
`pnpm verify:surfaces` also checks that deferred clipboard writes authorize the
format present at execution and reject a changed payload before writing it.

## Limits

The clipboard check runs on an X11 test display where Electron's asynchronous clipboard
can stall for several seconds on a self-owned selection, so the check waits longer than
the others. Power values depend on the machine; only their shape is checked.
