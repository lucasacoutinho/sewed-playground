# Development and diagnostics

## Behavior

`pnpm dev` runs the local checks and starts Vite with Electron. Renderer edits use React
Fast Refresh. Main, worker, and shared-contract edits compile a new native generation
and restart Electron after a successful build; a failed compile preserves the running
application.

`pnpm dev:inspect` selects the same application with headless diagnostics and Effect
tracing. The diagnostic snapshot reports owners, bindings, requests, resources, stream
counters, spans, and health. It creates no custom inspector UI and no extra renderer
bridge. Chromium DevTools remain available through Electron's normal WebContents API.

## Ownership

The [`@sewed/vite`](../../../sewed/packages/vite/README.md) package owns the development
build and restart loop. The optional `@sewed/devtools` package contributes the
diagnostic layer. Main acquires that layer in the application scope; the playground
only renders or records the resulting observations.

## Lifetime

Fast Refresh preserves the mounted renderer state when a component update is accepted.
A successful native rebuild replaces the native generation. Closing Vite or the final
application window ends the development session and its diagnostic scope.

## Contracts and dependencies

Plugin composition lives in `vite.config.ts`. The inspect mode changes package
composition through the Vite mode; it does not add a second application architecture.
Diagnostics use the public Sewed and Effect APIs and follow the same application and
document owners as the normal run.

## Source

- [`vite.config.ts`](../../vite.config.ts) composes Sewed, diagnostics, TanStack, and
  React plugins.
- [`src/main/app.ts`](../../src/main/app.ts) conditionally acquires the diagnostic layer.
- [`src/renderer/lib/sewed.tsx`](../../src/renderer/lib/sewed.tsx) attaches the renderer
  runtime at startup.
- [`scripts/verify-development.mjs`](../../scripts/verify-development.mjs) exercises
  development restarts and Fast Refresh.
- [`scripts/verify-diagnostics.mjs`](../../scripts/verify-diagnostics.mjs) exercises
  diagnostic snapshots and spans.

## Verification

This is a cross-cutting development feature rather than one route in
`scripts/feature-map.json`. Use:

```sh
pnpm verify:development
pnpm verify:devtools
pnpm verify:devtools-development
pnpm verify:diagnostics
pnpm verify --dev
```

The fixtures cover renderer Fast Refresh, native restart recovery, diagnostic binding
targets, request cleanup, and final scope closure. The normal application checks remain
the source of truth for production composition.

## Limits

The fixtures verify this playground's Vite and diagnostics integration. They do not
replace Electron Chromium DevTools, define a visual inspector product, or guarantee
that every consumer's build tool has the same restart semantics.
