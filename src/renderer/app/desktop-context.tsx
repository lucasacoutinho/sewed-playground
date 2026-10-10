import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { Cause } from "effect";
import { useAction, useClient, useStream } from "@sewed/react";
import { Controls, Session } from "../../shared/bindings.js";
import { useWorker } from "../features/worker/use-worker.js";

function useDesktopState() {
  const name = new URL(location.href).searchParams.get("window") === "second" ? "second" : "first";
  const session = useClient(Session, { connection: "shared" });
  const controls = useClient(Controls, { connection: "shared" });
  const owners = useStream(() => session.changes(), [session]);
  const snapshot = owners.status === "value" ? owners.value : undefined;
  const worker = useWorker(snapshot?.worker.status === "running");
  const terminate = useAction(() => session.terminate());
  const close = useAction(() => controls.close());

  return {
    name,
    label: name === "second" ? "B" : "A",
    snapshot,
    worker,
    terminate,
    close,
    stopped: snapshot?.worker.status === "stopped",
    sessionError: owners.status === "failure" ? Cause.pretty(owners.cause) : null,
    terminateError: terminate.status === "failure" ? Cause.pretty(terminate.cause) : null,
    closeError: close.status === "failure" ? Cause.pretty(close.cause) : null,
  };
}

const DesktopContext = createContext<ReturnType<typeof useDesktopState> | null>(null);

export function DesktopProvider({ children }: { children: ReactNode }) {
  const desktop = useDesktopState();
  return <DesktopContext value={desktop}>{children}</DesktopContext>;
}

export function useDesktop() {
  const desktop = useContext(DesktopContext);
  if (!desktop) throw new Error("Desktop features require DesktopProvider");
  return desktop;
}
