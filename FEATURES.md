# Playground feature catalog

This guide is the application feature catalog. Each feature has a short record under
[`docs/features`](docs/features) that explains its behavior, owners, lifetime, contracts,
source entry points, verification, and limits. The records are the place to start when
an agent is investigating a behavior or planning a change.

| Feature                     | Route or scope          | Record                                      |
| --------------------------- | ----------------------- | ------------------------------------------- |
| Desktop windows             | Native window scope     | [desktop](docs/features/desktop.md)         |
| Renderer responsiveness     | Renderer document scope | [renderer](docs/features/renderer.md)       |
| Application-owned work      | Application scope       | [background](docs/features/background.md)   |
| Worker requests             | Request lifetime route  | [requests](docs/features/requests.md)       |
| React action scopes         | `/scopes`               | [scopes](docs/features/scopes.md)           |
| Renderer recovery           | `/renderers`            | [renderers](docs/features/renderers.md)     |
| Remote data                 | `/resources`            | [resources](docs/features/resources.md)     |
| Routes and source reference | `/source`               | [source](docs/features/source.md)           |
| Desktop surfaces            | `/surfaces`             | [surfaces](docs/features/surfaces.md)       |
| Guest tab                   | `/guest`                | [guest](docs/features/guest.md)             |
| Development and diagnostics | Development scope       | [development](docs/features/development.md) |

## How to read a feature record

Every record uses the same shape:

- **Behavior** states what a person can observe and the important scenarios.
- **Ownership** names the runtime owner and the boundary where work executes.
- **Lifetime** says what keeps the work alive and what releases it.
- **Contracts and dependencies** names the shared protocol and required bindings.
- **Source** links to the entry points instead of copying implementation details.
- **Verification** points to stable scenario IDs and the native or static checks that
  establish them.
- **Limits** records what the playground does not prove.

Use the [feature record template](docs/features/_template.md) when adding a new record.

`pnpm check` requires every mapped feature to have a linked record with this section
shape. Keep cross-cutting records, such as development diagnostics, in the same
directory even when they do not have a route entry in the runtime map.

The records describe the intended application behavior. The machine-readable
[`scripts/feature-map.json`](scripts/feature-map.json) is a verification index: it maps
routes and source ownership to selectors and assertion IDs so the harness can find and
exercise those records. It is not a replacement for the feature descriptions.

## Keeping the catalog current

When behavior, ownership, or lifetime changes, update the corresponding record and then
update the matching map entry or scenario. Add a new record before adding a new feature
directory. Keep the record focused on one user-facing behavior; link to neighboring
records when a flow crosses a boundary. Run the checks in the
[verification guide](docs/verification.md) after changing a record's contract or its
harness metadata.

[Architecture](ARCHITECTURE.md) explains the boundaries shared by these features. The
[verification guide](docs/verification.md) explains how to run the static and Electron
checks and how to interpret their evidence.
