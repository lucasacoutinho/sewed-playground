import { Cause } from "effect";
import { useAction, useClient, useStream } from "@sewed/react";
import { Controls } from "../../../shared/bindings.js";

export function useWindowControls() {
  const controls = useClient(Controls, { connection: "shared" });
  const state = useStream(() => controls.changes(), [controls]);
  const command = useAction((name: "maximize" | "restore" | "minimize") => controls[name]());
  return {
    native: state.status === "value" ? state.value : undefined,
    run: command.run,
    commandError: command.status === "failure" ? Cause.pretty(command.cause) : null,
    stateError: state.status === "failure" ? Cause.pretty(state.cause) : null,
  };
}
