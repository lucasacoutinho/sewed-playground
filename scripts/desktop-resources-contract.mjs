import { Rpc, RpcGroup } from "effect/rpc";
import { Binding, SewedError, Tray } from "sewed";

export const TrayEvents = RpcGroup.make(
  Rpc.make("events", { success: Tray.Event, stream: true, error: SewedError }),
);
export const TrayEventsSlot = Binding.slot("desktop-resources/tray-events", TrayEvents);
