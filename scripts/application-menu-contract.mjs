import { Rpc, RpcGroup } from "effect/rpc";
import { Binding, Menu, SewedError } from "sewed";

export const MenuEvents = RpcGroup.make(
  Rpc.make("selections", { success: Menu.Selection, stream: true, error: SewedError }),
);
export const MenuEventsSlot = Binding.slot("application-menu-events", MenuEvents);
