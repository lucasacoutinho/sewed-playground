import { Binding, Clipboard, GuestView, NativeTheme, PowerMonitor, WindowControls } from "sewed";
import { ClockProtocol, ComputeProtocol, SessionProtocol } from "./contracts.js";
import { Resources } from "./resources.js";

export const Controls = WindowControls.capability.slot;
export const Clock = Binding.slot("clock", ClockProtocol);
export const Compute = Binding.slot("compute", ComputeProtocol);
export const Session = Binding.slot("session", SessionProtocol);
export const Theme = NativeTheme.capability.slot;
export const Paste = Clipboard.capability.slot;
export const Power = PowerMonitor.capability.slot;
export const Tab = GuestView.tab.slot;

export const bindings = [Controls, Compute, Session, Resources, Theme, Paste, Power, Tab];
