import { Rpc, RpcGroup } from "effect/rpc";
import { Binding, Dialog, SewedError } from "sewed";

export const Prompt = RpcGroup.make(
  Rpc.make("ask", { success: Dialog.MessageResult, error: SewedError }),
);
export const PromptSlot = Binding.slot("prompt", Prompt);
