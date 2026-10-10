import { Rpc, RpcGroup } from "effect/rpc";
import { Binding, Dialog, SewedError } from "sewed";

export const Picker = RpcGroup.make(
  Rpc.make("open", { success: Dialog.OpenResult, error: SewedError }),
  Rpc.make("save", { success: Dialog.SaveResult, error: SewedError }),
);
export const PickerSlot = Binding.slot("picker", Picker);
