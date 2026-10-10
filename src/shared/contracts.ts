import { Schema } from "effect";
import { SewedError, WebContents } from "sewed";
import { Rpc, RpcGroup } from "effect/rpc";

export class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {
  message: Schema.String,
}) {}

export const ClockProtocol = RpcGroup.make(
  Rpc.make("ticks", {
    success: Schema.Struct({
      thread: Schema.Number,
      ticks: Schema.Number,
    }),
    stream: true,
  }),
);

export const ComputeProtocol = RpcGroup.make(
  Rpc.make("changes", {
    success: Schema.Struct({
      thread: Schema.Number,
      active: Schema.Number,
      released: Schema.Number,
    }),
    stream: true,
  }),
  Rpc.make("background", {
    success: Schema.Struct({
      thread: Schema.Number,
      sourceThread: Schema.Number,
      ticks: Schema.Number,
    }),
    stream: true,
  }),
  Rpc.make("compute", {
    payload: { milliseconds: Schema.Number, label: Schema.String },
    success: Schema.Struct({
      label: Schema.String,
      thread: Schema.Number,
      iterations: Schema.Number,
    }),
  }),
  Rpc.make("wait", {
    payload: { milliseconds: Schema.Number, label: Schema.String },
    success: Schema.Struct({
      label: Schema.String,
      thread: Schema.Number,
      iterations: Schema.Number,
    }),
  }),
  Rpc.make("reject", { error: Rejected }),
);

export const BackgroundState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("starting") }),
  Schema.Struct({
    status: Schema.Literal("running"),
    thread: Schema.Number,
    sourceThread: Schema.Number,
    ticks: Schema.Number,
  }),
  Schema.Struct({ status: Schema.Literal("stopped") }),
]);

export const SessionState = Schema.Struct({
  mainProcess: Schema.Number,
  worker: Schema.Struct({ id: Schema.String, status: Schema.Literals(["running", "stopped"]) }),
  clock: Schema.Struct({ id: Schema.String, status: Schema.Literals(["running", "stopped"]) }),
  windows: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      owner: Schema.String,
      contents: WebContents.State,
      responsiveness: WebContents.Responsiveness,
    }),
  ),
  background: BackgroundState,
});
export type SessionState = typeof SessionState.Type;

export const SessionProtocol = RpcGroup.make(
  Rpc.make("changes", { success: SessionState, stream: true }),
  Rpc.make("terminate"),
  Rpc.make("reloadRenderer", {
    payload: { owner: Schema.String },
    error: SewedError,
  }),
  Rpc.make("recoverRenderer", {
    payload: { owner: Schema.String },
    error: SewedError,
  }),
);
