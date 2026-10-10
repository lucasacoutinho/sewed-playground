import { Rpc, RpcGroup } from "effect/rpc";
import { Binding, Menu, SewedError } from "sewed";

export const ContextMenu = RpcGroup.make(
  Rpc.make("choose", { success: Menu.PopupResult, error: SewedError }),
);
export const ContextMenuSlot = Binding.slot("context-menu", ContextMenu);
