import { Effect } from "effect";
import { Binding, Decidables, Decision, Renderer } from "sewed";
import {
  App,
  BrowserWindow,
  Capability,
  Clipboard,
  GuestView,
  NativeTheme,
  PowerMonitor,
  WindowControls,
  Worker,
} from "sewed/main";
import { Clock, Compute, Controls, Paste, Power, Session, Tab, Theme, bindings } from "../shared/bindings.js";
import { ClockProtocol, ComputeProtocol } from "../shared/contracts.js";
import { createGuestSite } from "./guest.js";
import { createSession } from "./session.js";
import { ByteResource, Resources } from "../shared/resources.js";

const application = Effect.gen(function* () {
  const clock = yield* Worker.spawn(
    Worker.entry(new URL("../worker/clock.js", import.meta.url), ClockProtocol, { bindings: [] }),
  );
  const computeEntry = Worker.entry(
    new URL("../worker/compute.js", import.meta.url),
    ComputeProtocol,
    { bindings: [Clock] },
  );
  const worker = yield* Worker.spawn(computeEntry, { bindings: [Binding.to(Clock, clock)] });
  const session = yield* createSession({ worker, clock });
  const resources = yield* Worker.spawn(
    Worker.entry(new URL("../worker/resources.js", import.meta.url), ByteResource.protocol, {
      bindings: [],
    }),
  );
  const theme = yield* Capability.serve(NativeTheme.capability).pipe(
    Effect.provide(NativeTheme.native({ allowSetSource: true })),
  );
  const paste = yield* Capability.serve(Clipboard.capability).pipe(
    Effect.provide(Clipboard.native({ read: ["text"], write: ["text"] })),
  );
  const power = yield* Capability.serve(PowerMonitor.capability).pipe(
    Effect.provide(PowerMonitor.native()),
  );
  const guestSite = yield* createGuestSite;
  const guest = yield* GuestView.make({ navigation: [`${guestSite.origin}/*`] });
  const tab = yield* Capability.serve(GuestView.tab).pipe(
    Effect.provide(GuestView.native(guest, { navigate: true, capture: true })),
  );
  yield* guest.navigate(`${guestSite.origin}/`);

  for (const { name, label } of [
    { name: "first", label: "A" },
    { name: "second", label: "B" },
  ]) {
    const window = yield* BrowserWindow.make({
      title: `Sewed / Window ${label}`,
      width: 1160,
      height: 920,
    });
    yield* session.observeWindow(name, window);
    const controls = yield* Capability.serve(WindowControls.capability).pipe(
      Effect.provide(WindowControls.native(window)),
    );
    const url = new URL(
      process.env.SEWED_RENDERER_URL ?? "../renderer/index.html",
      import.meta.url,
    );
    url.searchParams.set("window", name);
    url.hash = "/";
    yield* window.webContents.load(Renderer.entry(url, { bindings }), {
      bindings: [
        Binding.to(Controls, controls),
        Binding.to(Compute, worker),
        Binding.to(Session, session.owner),
        Binding.to(Resources, resources),
        Binding.to(Theme, theme),
        Binding.to(Paste, paste),
        Binding.to(Power, power),
        Binding.to(Tab, tab),
      ],
    });
    if (name === "first")
      yield* window.attach(guest, { bounds: { x: 760, y: 720, width: 380, height: 180 } });
  }
});

App.run(
  [],
  Effect.gen(function* () {
    yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "quit"));
    if (process.env.SEWED_DEVTOOLS === "1") {
      const DevTools = yield* Effect.promise(() => import("@sewed/devtools"));
      const tools = yield* DevTools.make();
      yield* application.pipe(Effect.provide(tools.layer));
    } else yield* application;
  }),
);
