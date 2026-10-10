import { Cause } from "effect";
import { SewedError } from "sewed";
import { useAction, useClient, useStream } from "@sewed/react";
import { Tab } from "../../../shared/bindings.js";

const failure = (state: { readonly status: string; readonly cause?: Cause.Cause<unknown> }) => {
  if (state.status !== "failure" || state.cause === undefined) return null;
  const error = Cause.squash(state.cause);
  return error instanceof SewedError ? `${error.code}: ${error.message}` : Cause.pretty(state.cause);
};

export function useGuest() {
  const tab = useClient(Tab);
  const state = useStream(() => tab.state(), [tab]);
  const history = useStream(() => tab.history(), [tab]);
  const navigate = useAction((url: string) => tab.navigate({ url }));
  const back = useAction(() => tab.back());
  const forward = useAction(() => tab.forward());
  const capture = useAction(() => tab.capture({}));
  return {
    state: state.status === "value" ? state.value : undefined,
    history: history.status === "value" ? history.value : undefined,
    navigate: navigate.run,
    back: back.run,
    forward: forward.run,
    capture: capture.run,
    captured: capture.status === "success" ? capture.value.bytes.byteLength : undefined,
    busy: navigate.status === "running" || capture.status === "running",
    error:
      failure(state) ?? failure(navigate) ?? failure(back) ?? failure(forward) ?? failure(capture),
  };
}
