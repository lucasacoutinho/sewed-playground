import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Cause } from "effect";
import { Renderer } from "sewed";
import { connect, RuntimeProvider } from "@sewed/react";
import { bindings } from "../../shared/bindings.js";

export function mountDesktop(children: ReactNode) {
  const element = document.getElementById("root");
  if (!element) throw new Error("Missing React root");
  const store = connect(Renderer.entry(new URL(location.href), { bindings }));
  const reportUnavailable = store.subscribe(() => {
    const state = store.getSnapshot();
    if (state.status !== "unavailable") return;
    const message = Cause.pretty(state.cause);
    if (message !== "") console.error(message);
  });
  const root = createRoot(element);
  root.render(<RuntimeProvider store={store}>{children}</RuntimeProvider>);
  if (import.meta.hot)
    import.meta.hot.dispose(() => {
      reportUnavailable();
      root.unmount();
      store.close();
    });
}
