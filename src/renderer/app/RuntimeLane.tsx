import { useRef } from "react";
import { Effect } from "effect";
import { useAction, useClient, useResource, useStream } from "@sewed/react";
import { Power, Session } from "../../shared/bindings.js";

export function RuntimeLane() {
  const renderIdentityRef = useRef<string | undefined>(undefined);
  if (renderIdentityRef.current === undefined)
    renderIdentityRef.current = Math.random().toString(36).slice(2);
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;

  const session = useClient(Session);
  const power = useClient(Power);
  const owners = useStream(() => session.changes(), [session]);
  const snapshot = useResource(() => power.state({ idleThresholdSeconds: 60 }), [power]);
  const action = useAction(() => Effect.succeed(true));

  return (
    <div
      data-runtime-lane
      data-runtime-id={renderIdentityRef.current}
      data-runtime-renders={renderCountRef.current}
      data-runtime-stream={owners.status}
      data-runtime-resource={snapshot.status}
      data-runtime-action={action.status}
      hidden
    />
  );
}
