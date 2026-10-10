import { app } from "electron";
import { Effect } from "effect";
import { App } from "sewed/main";

// Task 1 (fully-on-sewed wave 1), ruling 2: App.showErrorBox is a plain synchronous function, safe
// to call in this module's own first pass, before App.run and before Electron is ready. Probed on
// Electron 44.3.0/Linux: before readiness the call prints the title and the content to stderr and
// returns at once, with or without a display, because GTK is not yet up -- this entry proves exactly
// that process-observed fact; verify-app-extras.mjs reads it off the child's own stderr stream, not
// off anything this fixture claims about itself.
App.showErrorBox({ title: "Sewed error box", content: "before readiness" });

// `App.run` is called synchronously in this module's own first pass, with an empty declaration
// list -- always allowed, ready or not.
function main() {
  App.run(
    [],
    Effect.andThen(
      Effect.sync(() =>
        console.log(`APP_ERROR_BOX_VERIFICATION ${JSON.stringify({ success: true, checks: [] })}`),
      ),
      App.exit(0),
    ),
  );
}

try {
  main();
} catch (error) {
  console.error(error);
  app.exit(1);
}
