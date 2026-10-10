import { createFileRoute } from "@tanstack/react-router";
import { Scopes } from "../features/scopes/Scopes.js";

export const Route = createFileRoute("/scopes")({
  component: () => (
    <div id="panel-scopes">
      <Scopes />
    </div>
  ),
});
