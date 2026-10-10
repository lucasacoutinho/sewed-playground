import { createRootRoute, Link } from "@tanstack/react-router";
import { AppShell } from "../app/AppShell.js";
import { DesktopProvider } from "../app/desktop-context.js";
import { RuntimeLane } from "../app/RuntimeLane.js";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => (
    <p>
      This experiment does not exist. <Link to="/">Open request lifetime</Link>.
    </p>
  ),
});

function RootLayout() {
  return (
    <>
      <RuntimeLane />
      <DesktopProvider>
        <AppShell />
      </DesktopProvider>
    </>
  );
}
