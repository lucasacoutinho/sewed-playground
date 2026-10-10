# A guest tab driven through a hosted owner

## Behavior

The `/guest` route drives a page the application does not own. Main creates a
`GuestView` over a small local site, attaches it to the first window, and hosts it
behind a policy that grants navigation and capture. The route shows the guest's
state and URL, navigates to a URL typed in the toolbar, moves back and forward
through the guest's history, and captures the page as PNG bytes. A URL outside the
guest's pattern policy fails with `Protocol` before Electron runs.

## Ownership

Main owns the guest view, its navigation policy, and the local site it points at.
`guest.host({ navigate: true, capture: true })` produces the owner the renderer
binds; automation, downloads, and policy changes are not on the protocol, so no
renderer can reach them.

## Lifetime

The guest, the local site, and the hosted owner live in the application scope. The
guest's attachment ends with the first window, which closes the guest with it, as it
does for any attached view. A renderer document's client closes with the document.

## Contracts and dependencies

The renderer binds the library's `GuestView.protocol` through the `Tab` slot in
`src/shared/bindings.ts` and drives it with `@sewed/react`'s `useClient`,
`useStream`, and `useAction`. Navigation targets are checked against the guest's
pattern policy in main; the host policy decides which protocol operations are served.

## Source

- [`src/main/app.ts`](../../src/main/app.ts) creates the guest, hosts it, and attaches it.
- [`src/main/guest.ts`](../../src/main/guest.ts) serves the local guest site.
- [`src/shared/bindings.ts`](../../src/shared/bindings.ts) declares the slot.
- [`src/renderer/features/guest/Guest.tsx`](../../src/renderer/features/guest/Guest.tsx)
  renders the toolbar.
- [`src/renderer/features/guest/use-guest.ts`](../../src/renderer/features/guest/use-guest.ts)
  wraps the binding in a hook.
- [`src/renderer/routes/guest.tsx`](../../src/renderer/routes/guest.tsx) mounts the route.

## Verification

The metadata entry is `guest`:

```sh
pnpm verify:features guest
pnpm verify:guest
```

The `guest-tab` scenario covers the ready state, a navigation within the policy and a
history move back, a navigation outside the policy failing with `Protocol`, and a
capture returning PNG bytes. The native fixture `verify:guest` covers the rest of the
surface: no bridge in the page, blocked navigations and redirects, denied popups and
webviews, body-aware interception scoped by `sourceId`, downloads through a decider,
automation, DevTools coexistence, and closure.

## Limits

Page capture under the software renderer on the test display can fail on a first
attempt, so the scenario retries the capture a few times. The guest overlays the
bottom-right of the first window; it is a native view, so it never affects the
renderer's layout.
