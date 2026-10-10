import { Cause } from "effect";
import type { NativeTheme } from "sewed";
import { useAction, useClient, useStream } from "@sewed/react";
import { Controls, Paste, Power, Theme } from "../../../shared/bindings.js";

const failure = (state: { readonly status: string; readonly cause?: Cause.Cause<unknown> }) =>
  state.status === "failure" && state.cause !== undefined ? Cause.pretty(state.cause) : null;

export function useTheme() {
  const theme = useClient(Theme);
  const state = useStream(() => theme.state(), [theme]);
  const set = useAction((source: NativeTheme.Source) => theme.setSource({ source }));
  return {
    state: state.status === "value" ? state.value : undefined,
    set: set.run,
    error: failure(state) ?? failure(set),
  };
}

export function useClipboard() {
  const paste = useClient(Paste);
  const write = useAction((text: string) => paste.write({ content: { kind: "text", text } }));
  const read = useAction(() => paste.read({ format: "text" }));
  return {
    write: write.run,
    read: read.run,
    value: read.status === "success" ? read.value : undefined,
    busy: write.status === "running" || read.status === "running",
    error: failure(write) ?? failure(read),
  };
}

export function usePower() {
  const power = useClient(Power);
  const snapshot = useAction(() => power.state({ idleThresholdSeconds: 60 }));
  return {
    refresh: snapshot.run,
    state: snapshot.status === "success" ? snapshot.value : undefined,
    error: failure(snapshot),
  };
}

export function useZoom() {
  const controls = useClient(Controls, { connection: "shared" });
  const zoom = useStream(() => controls.zoom(), [controls]);
  const set = useAction((factor: number) => controls.setZoom({ factor }));
  return {
    factor: zoom.status === "value" ? zoom.value.factor : undefined,
    set: set.run,
    error: failure(zoom) ?? failure(set),
  };
}
