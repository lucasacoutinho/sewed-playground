import { createFileRoute } from "@tanstack/react-router";
import { Resources } from "../features/resources/Resources.js";

export const Route = createFileRoute("/resources")({ component: Resources });
