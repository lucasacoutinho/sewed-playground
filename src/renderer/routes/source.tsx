import { createFileRoute } from "@tanstack/react-router";
import { SourceMap } from "../features/source/SourceMap.js";

export const Route = createFileRoute("/source")({
  component: () => (
    <div id="panel-source">
      <SourceMap />
    </div>
  ),
});
