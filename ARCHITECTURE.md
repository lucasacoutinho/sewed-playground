# Playground architecture

The playground is an external Sewed consumer. It keeps application experiments outside
the library while exercising its public contracts, native owners, and React adapter.

[FEATURES.md](FEATURES.md) indexes the application behavior records under
[`docs/features`](docs/features). This document explains the structure those features
share.
[Verification](docs/verification.md) describes the executable checks and native harness.

## Entry points and composition

[main/app.ts](src/main/app.ts) owns startup. It creates the application scope, starts the
workers, starts the application-owned subscription, and creates two native windows.
It then loads the renderer with bindings to the selected owners.

The worker entry points implement distinct responsibilities:

- [worker/compute.ts](src/worker/compute.ts) handles computation and interruptible requests.
  Its background stream consumes its declared clock dependency.
- [worker/clock.ts](src/worker/clock.ts) owns the clock stream consumed by Compute.
- [worker/resources.ts](src/worker/resources.ts) implements acquired resources and generates bytes.

[renderer/main.tsx](src/renderer/main.tsx) mounts the React application through the
[bootstrap adapter](src/renderer/lib/sewed.tsx). TanStack routes compose the experiment
panels inside a persistent desktop shell. React components render data and dispatch
actions through feature hooks.

Shared files declare protocols, schemas, and binding slots. Those declarations acquire
no resources. Main chooses the running instance for each slot. Both windows share
Compute, Session, and Resources, while each window's Controls binding selects its own
native control owner.

## Feature ownership

A feature consists of a behavior, its contract and implementation, and the React code
that exposes it. Its record under [`docs/features`](docs/features) explains why those
pieces belong together.
The implementation still respects runtime boundaries: one feature can span shared,
main, worker, and renderer files without importing native code into the renderer.

Renderer components and hooks are collocated in `features/<name>`. Routes and `app`
compose those features and pass shared state as props. A feature cannot reach into a
sibling feature or import the app provider. The desktop provider owns work that persists
across routes; a route component owns work that ends when that component unmounts.

| Directory                       | Owns                                                      | May depend on                                              |
| ------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| `src/shared`                    | Schemas, protocols, binding slots, resource definitions   | Shared declarations and public inert package APIs          |
| `src/main`                      | Native resources, application lifetime, instance bindings | Main code and shared contracts                             |
| `src/worker`                    | Computation and resource implementations                  | Worker code and shared contracts                           |
| `src/renderer/features/<name>`  | One feature's components and scoped hooks                 | That feature, neutral renderer utilities, shared contracts |
| `src/renderer/app`              | Shell, providers, feature composition                     | Renderer features and shared contracts                     |
| `src/renderer/routes`           | TanStack route entries and page composition               | App composition and renderer features                      |
| `src/renderer/lib`              | Renderer bootstrap and neutral utilities                  | Public package APIs and shared declarations                |
| `src/renderer/main.tsx`         | React startup                                             | Router, app composition and renderer utilities             |
| `src/renderer/router.ts`        | Router configuration                                      | Generated route tree and renderer utilities                |
| `src/renderer/routeTree.gen.ts` | Generated route registration                              | Route entries                                              |

Each renderer source file has one of these roles. Entry files and unclassified helper
directories cannot provide a route around the feature boundaries. Neutral utilities
cannot depend on composition code, and app code cannot import routes.

## Lifetimes

The code distinguishes application, native window, document, component, invocation,
and remote resource ownership. A child lifetime can end while its parent remains alive.

| Owner              | Example                                              | What ends its work                                               |
| ------------------ | ---------------------------------------------------- | ---------------------------------------------------------------- |
| Application scope  | Worker instances and the background subscription     | Application shutdown                                             |
| Native window      | Window controls and WebContents observers            | Native window closure                                            |
| Renderer document  | Connections, desktop provider, local counter         | Reload, document loss, or window closure                         |
| Route component    | React scopes panel or Remote data panel              | Leaving the route or unmounting the component                    |
| Action invocation  | An interruptible request or a retained local lease   | Replacement, cancellation, failure, or owning component teardown |
| Remote acquisition | Resource implementation and its scoped client handle | Explicit release or loss of its caller, connection, or owner     |

A successful `useAction` return can retain resources until its invocation scope closes.
A remote handle can survive cancellation of one read. A renderer reload can release
document requests while application-owned work continues. The feature descriptions
spell out these distinctions for each interaction.

Owner loss is observable state. The playground does not silently replace a stopped
worker or invent activity to keep a readout moving. Recovery of a lost renderer is an
explicit operation on its surviving native owner.

## Enforcement

`pnpm check` runs the architecture parser, separate renderer/native/tool compiler
configurations, and tests of the rules. Development commands run it before launch.
Production builds generate TanStack routes before type checking.

The parser checks imports, re-exports, dynamic imports, runtime globals, dynamic code
evaluation, feature dependencies, React effect hooks, handwritten comments, `any`, and
type assertions. Only `as const` assertions are accepted in application source. It also
checks `.mts` and `.mjs` files and rejects CommonJS source. Glob imports are rejected so
dependencies remain explicit.

TanStack owns `routeTree.gen.ts`. Its generated comments and assertions are exempt from
style rules; its imports, runtime globals, and effect hooks still obey the boundaries.
Separate compiler probes verify that React resource hooks accept renderer requirements
and reject effects that require main or worker execution.

Effect requirements preserve declared capabilities through types. Runtime schemas and
bindings validate messages and dispatch them to the selected owner. These mechanisms
do not determine the cost of arbitrary JavaScript. The native harness measures actual
worker thread identity, renderer heartbeat, native responsiveness, and cleanup.

## Documentation and verification

Each feature record under [`docs/features`](docs/features) records behavior, ownership,
lifecycle, dependencies, source entry points, and expected scenarios. A behavior change
needs a corresponding record update and verification scenario so a reader can follow
the intended contract into the code.

The architecture check also requires every mapped feature ID to have a linked record
with the standard section shape. This keeps the prose catalog navigable as the runtime
map grows; cross-cutting records may exist without a map entry.

The harness keeps its selectors, source inventory, and assertion IDs in
[scripts/feature-map.json](scripts/feature-map.json). Static checks verify that feature
directories and their source files have owners, referenced files exist, and check IDs
resolve to harness assertions. Native checks exercise the controls and behavior.
The [verification guide](docs/verification.md) explains the commands and evidence format.

Review connects the prose to the implementation: a selector match cannot establish the
behavior described by a feature. `AGENTS.md` directs agents through the documentation
and checks. These remain local acceptance checks; CI, release automation, and an external
review bot are outside this playground experiment.
