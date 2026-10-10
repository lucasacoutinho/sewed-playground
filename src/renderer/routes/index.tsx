import { createFileRoute } from "@tanstack/react-router";
import { Requests } from "../features/worker/Requests.js";
import { useDesktop } from "../app/desktop-context.js";

export const Route = createFileRoute("/")({ component: RequestsPage });

function RequestsPage() {
  const { worker } = useDesktop();
  return (
    <div id="panel-requests">
      <Requests worker={worker} />
    </div>
  );
}
