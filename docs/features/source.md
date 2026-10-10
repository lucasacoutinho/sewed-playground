# Routes and source reference

## Behavior

TanStack file routes switch the experiment panel below a persistent desktop shell.
The `/source` route displays small examples of shared declarations, native composition,
worker implementation, and React clients. The excerpts explain the ownership model;
linked source files remain authoritative.

The playground uses hash history so the built `file://` entry supports route changes,
back/forward navigation, and reloads without a server fallback. Window identity stays in
the document query string, separate from the route hash. Leaving a route unmounts its
route-owned components, so local scopes and remote handles are released.

## Ownership

TanStack Router owns navigation. `AppShell` owns the persistent desktop layout and
`Outlet` composition. Each route owns its panel, while feature directories own the
components and hooks used by that panel. SourceMap is a renderer-only presentation
feature.

## Lifetime

Hash changes preserve the renderer document and desktop provider. Route components can
unmount during navigation, ending component-owned work. Reload replaces the document
and recreates document-owned connections while retaining native and application owners.

## Contracts and dependencies

Route entries use ordinary React and TanStack Router APIs. The route tree is generated
by the TanStack Vite plugin. The source reference points at shared protocols, main
composition, worker implementations, and renderer clients without importing across
those runtime boundaries.

## Source

- [`src/renderer/router.ts`](../../src/renderer/router.ts) configures hash history.
- [`src/renderer/app/AppShell.tsx`](../../src/renderer/app/AppShell.tsx) owns the shell
  and route outlet.
- [`src/renderer/features/source/SourceMap.tsx`](../../src/renderer/features/source/SourceMap.tsx)
  renders the source examples.
- [`src/renderer/routes/source.tsx`](../../src/renderer/routes/source.tsx) mounts the
  source route.
- [`src/renderer/routeTree.gen.ts`](../../src/renderer/routeTree.gen.ts) is generated
  route registration.

## Verification

The metadata entry is `source`:

```sh
pnpm verify:features source
```

Its scenarios are `feature-map` and `router-navigation`. The route harness checks
keyboard navigation, back/forward behavior, and the source examples. The map checker
also verifies that each feature source has an owner.

## Limits

These scenarios exercise hash navigation in the built Electron entry. They do not
establish browser-history `pushState` routing, server fallback, or the behavior of a
consumer that loads an unbound document.
