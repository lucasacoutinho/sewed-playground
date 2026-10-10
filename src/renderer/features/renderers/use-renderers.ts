import { Cause } from "effect";
import { useAction, useClient } from "@sewed/react";
import { Session } from "../../../shared/bindings.js";

export function useRenderers() {
  const session = useClient(Session, { connection: "shared" });
  const reload = useAction((owner: string) => session.reloadRenderer({ owner }));
  const recover = useAction((owner: string) => session.recoverRenderer({ owner }));

  return {
    reload,
    recover,
    reloadError: reload.status === "failure" ? Cause.pretty(reload.cause) : null,
    recoveryError: recover.status === "failure" ? Cause.pretty(recover.cause) : null,
  };
}
