# Verify a playground feature

Start with [the feature guide](../FEATURES.md), then open the linked record under
[`docs/features`](features). Identify the reported behavior, its owner and lifetime,
and the relevant implementation files. Use
[the architecture guide](../ARCHITECTURE.md) when deciding where a change belongs.

## Check the implementation

Run the local rules and build the application:

```sh
pnpm check
pnpm build
```

`pnpm check` covers source ownership, imports, runtime requirements, feature-record
links and sections, compiler diagnostics, and tests of those rules. It cannot establish
the runtime behavior of a feature.

`pnpm build` records successful output with hashes of its inputs. The inputs include
handwritten source and assets, configuration, the package lock, build scripts, and
installed Sewed package code. TanStack generates its route tree during the build, so
that generated file is excluded from the input comparison.

## Exercise the feature in Electron

Run the application harness for the relevant lifetimes:

```sh
pnpm verify
pnpm verify --dev
pnpm verify --lifetime
```

The normal run covers explicit compute-worker termination. The development run also
exercises Fast Refresh and restores its temporary source edit. The lifetime run keeps
the worker alive while closing windows and verifies application shutdown. Use the
[fixture reference](../README.md#verification) for additional Electron API and development
checks, such as `verify:windows`, `verify:development`, `verify:remote`, `verify:guest`, and `verify:devtools`.

`verify:development` uses an Electron config with explicit main and worker files.
It checks that imported shared sources still trigger a restart, package metadata
reaches the staged manifest, failed builds retain a usable renderer, and shutdown
removes owned processes and session files. `verify:devtools-development` repeats
that loop with headless diagnostics enabled.

`pnpm verify:utility` checks native utility placement, dependency calls, startup
failure, cancellation, and shutdown. It also injects a refused native port
subscription and checks listener cleanup and reuse of the same utility owner.

Use an Electron-capable desktop session. A regular browser at the Vite URL has no Sewed
preload. For unattended tests, use the existing isolated display wrapper:

```sh
python3 scripts/with-xvfb.py dbus-run-session -- pnpm verify
```

The wrapper requires Xvfb, Openbox, and `xprop`. Without root access, `pnpm ui-tools`
extracts Xvfb and Openbox from their Debian packages into `.artifacts/ui-tools` and
prints the `SEWED_XVFB` and `SEWED_WINDOW_MANAGER` exports that select them. The wrapper
starts an authenticated temporary display and window manager, checks readiness, cleans
up its own processes, and holds a lock so overlapping runs wait instead of racing.
`pnpm verify:all` runs the production harness and every feature fixture in sequence
inside one display session and prints a pass count per fixture:

```sh
SEWED_XVFB=$PWD/.artifacts/ui-tools/xvfb.sh SEWED_WINDOW_MANAGER=$PWD/.artifacts/ui-tools/openbox.sh \
  SEWED_XVFB_TIMEOUT=3600 python3 scripts/with-xvfb.py dbus-run-session -- pnpm verify:all
```

The wrapper stops its command after 90 seconds by default, which fits one fixture;
`SEWED_XVFB_TIMEOUT` raises that for the full run.

The responsiveness and web contents extras fixtures launch Electron with
`--no-sandbox`. On the current WSL test host, Electron's forced renderer crash did
not deliver a termination event with Chromium's sandbox enabled; a native-only
probe reproduced this. These two fixtures exercise actual termination and
recovery with the sandbox disabled. Other fixtures keep their normal launch
settings. The renderer-loss fixtures signal only their owned renderer process
and compare Sewed's state with Electron's `render-process-gone` event.

When a native window check fails, retain the report and display context. Passing on an
isolated display does not establish behavior on another window manager.

The window fixture compares event snapshots with native flags and outer geometry.
On X11, frame extents can change `contentBounds` without a move or resize event, so
that field is checked through public on-demand reads after creation and fullscreen
transitions. The fixture does not toggle fullscreen again to recover a failed check.

Use `pnpm verify:windows --repeat 10` inside the display wrapper to check repeated
transitions. Each run keeps its own report and Electron log, and the command stops
at the first failure. `--repeat` accepts 1 to 100 runs; set `SEWED_XVFB_TIMEOUT`
to cover the requested run count.

## Inspect harness metadata

The test inventory is [scripts/feature-map.json](../scripts/feature-map.json).
It supplies selectors, source ownership, and check IDs to the harness. The feature
records supply the behavior and design explanation; the map is automation metadata,
not the catalog.

Find test metadata by name or source filename:

```sh
pnpm verify:features
pnpm verify:features --find "binary stream"
pnpm verify:features resources
```

The map checker requires each renderer feature directory to have one owner, every
feature source file to be listed, entry points to belong to the declared runtime,
and scenario check IDs to exist in the harness. Electron navigates the mapped routes
by keyboard and checks controls before exercising their behavior.

After changing an interaction, update its feature description and any affected test
selectors or scenarios. Keep new fixture protocols and native helpers under `scripts`,
outside the React application and the library.

## Read the evidence

Inspect the selected feature's recorded checks:

```sh
pnpm verify:features resources --report .artifacts/verification.json
pnpm verify:features resources --report .artifacts/dev-verification.json
pnpm verify:features resources --report .artifacts/lifetime-verification.json
```

The report includes the run mode, outcome, scenario evidence, and a fingerprint
comparison with the current files. A query exits nonzero when the run failed or its
evidence is no longer current. The recorded outcome remains visible for historical runs.

Each scenario joins the checks that establish its behavior:

- `covered`: all required checks passed in this run.
- `not-observed`: an applicable scenario lacks some required evidence, often because an
  earlier failure stopped the run. This does not mean the unvisited behavior failed.
- `not-applicable`: the scenario belongs to another run mode.

A failed run retains completed checks, the last completed check ID, the last wait
condition, and available screenshots. Inspect those alongside the Electron log in
`.artifacts`. Failure cleanup waits for the launched process and forcibly stops it if
termination stalls.

The harness rejects a missing or stale build before Electron starts. It also records
the verification scripts and test inventory, then compares fingerprints at completion.
Rebuild after application input changes and rerun the relevant checks after behavior or
harness changes. Fingerprints detect file drift; they do not attest against someone
rewriting both code and evidence.
