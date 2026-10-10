import { createFileRoute } from "@tanstack/react-router";
import { Guest } from "../features/guest/Guest.js";

export const Route = createFileRoute("/guest")({
  component: () => (
    <div id="panel-guest">
      <Guest />
    </div>
  ),
});
