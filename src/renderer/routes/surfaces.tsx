import { createFileRoute } from "@tanstack/react-router";
import { Surfaces } from "../features/surfaces/Surfaces.js";

export const Route = createFileRoute("/surfaces")({
  component: () => (
    <div id="panel-surfaces">
      <Surfaces />
    </div>
  ),
});
