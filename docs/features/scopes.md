# React action scopes

## Behavior

The `/scopes` route acquires a renderer-local lease. The action returns successfully
while its invocation scope continues to own the lease, so the panel makes the
difference between a completed computation and a released resource visible.

Replacing an acquisition closes the old invocation before the next one takes over.
Explicit release, failure after acquisition, component unmount, and leaving the route
all return the active lease count to zero.

## Ownership

The mounted `Lease` component owns the `useAction` invocation. The lease is a renderer
resource; it has no native window or worker implementation. This isolates React adapter
lifetime behavior from transport behavior.

## Lifetime

The lease remains alive after a successful action result until the invocation scope is
released. Its scope closes on explicit release, replacement, failure, component
teardown, or route unmount. Development StrictMode can exercise the acquire/release
cycle more than once.

## Contracts and dependencies

The hook uses `Effect.acquireRelease` and `@sewed/react`'s `useAction`. The component
does not use React effect hooks to manage the resource; the action scope is the
ownership boundary.

## Source

- [`src/renderer/features/scopes/Scopes.tsx`](../../src/renderer/features/scopes/Scopes.tsx)
  renders the lease controls and status.
- [`src/renderer/features/scopes/use-lease.ts`](../../src/renderer/features/scopes/use-lease.ts)
  implements acquisition and release.
- [`src/renderer/routes/scopes.tsx`](../../src/renderer/routes/scopes.tsx) mounts the route.

## Verification

The metadata entry is `scopes`:

```sh
pnpm verify:features scopes
```

The `react-scopes` scenario covers success, replacement, failure, explicit release,
and unmount cleanup in the React fixture.

## Limits

This is a local renderer lease rather than a native or remote resource. It demonstrates
scope semantics; it does not prove that a third-party resource has correct cleanup
unless that resource supplies its own release effect.
