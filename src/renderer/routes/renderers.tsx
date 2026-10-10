import { createFileRoute } from "@tanstack/react-router";
import { Renderers } from "../features/renderers/Renderers.js";
import { useDesktop } from "../app/desktop-context.js";

export const Route = createFileRoute("/renderers")({ component: RenderersPage });

function RenderersPage() {
  const { snapshot } = useDesktop();
  return (
    <div id="panel-renderers">
      <Renderers windows={snapshot?.windows} />
    </div>
  );
}
