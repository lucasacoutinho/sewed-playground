import { Stream } from "effect";
import { useStream } from "@sewed/react";

const heartbeat = Stream.tick(50).pipe(Stream.scan(() => 0, (ticks) => ticks + 1));

export function useHeartbeat() {
  const state = useStream(() => heartbeat, []);
  return state.status === "value" ? state.value : 0;
}
