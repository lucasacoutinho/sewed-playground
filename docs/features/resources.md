# Remote data

## Behavior

The `/resources` route acquires a worker resource and shows its thread identity and
seed. It can stream 32 MiB, cancel a transfer, reuse the resource, replace the
acquisition, or release it. The byte counter and progress indicator update as 64 KiB
chunks reach the renderer.

Cancelling a read keeps the resource available for another read. Releasing or replacing
the handle also cancels the transfer. Leaving the route unmounts the hook and closes the
remote resource and its connection.

## Ownership

The resource implementation runs in a dedicated worker. `Remote.layer` owns the worker
side resource, while `useResource` owns the scoped client handle in the renderer. The
transfer action and the handle are separate owners.

## Lifetime

The handle starts after the resource hook commits and ends on explicit release,
replacement, route unmount, document loss, or worker shutdown. A transfer can end by
success or cancellation without ending the handle. Releasing the handle cancels any
transfer still using it.

## Contracts and dependencies

[`src/shared/resources.ts`](../../src/shared/resources.ts) defines the `Remote` payload,
binary protocol, and `Resources` binding. Main supplies the selected resource worker;
the worker implements the protocol with `Remote.layer`. The renderer consumes the
typed handle through `@sewed/react`'s `useResource`.

## Source

- [`src/shared/resources.ts`](../../src/shared/resources.ts) declares the remote contract.
- [`src/worker/resources.ts`](../../src/worker/resources.ts) implements acquisition and
  binary streaming.
- [`src/renderer/features/resources/use-resource.ts`](../../src/renderer/features/resources/use-resource.ts)
  owns the handle and transfer action.
- [`src/renderer/features/resources/Resources.tsx`](../../src/renderer/features/resources/Resources.tsx)
  renders the resource panel.
- [`src/renderer/routes/resources.tsx`](../../src/renderer/routes/resources.tsx) mounts the route.

## Verification

The metadata entry is `resources`:

```sh
pnpm verify:features resources
```

Its `remote-resource` scenario covers acquisition, a complete transfer, cancellation,
reuse, replacement, explicit release, and route cleanup. Use `pnpm verify:remote`,
`pnpm verify:binary`, and `pnpm verify:resource-inspection` for the native and
headless transport checks. The reload fixture verifies new diagnostic records after the
reload sequence and closure of the original renderer bindings; retained event counts
can decrease when the bounded diagnostics buffer discards older records.

## Limits

The 32 MiB payload and 64 KiB chunk size are demonstration values. They show ownership,
binary transport, and cleanup; they do not establish a general throughput or memory
profile for every workload.
