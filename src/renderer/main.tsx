import { StrictMode } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { mountDesktop } from "./lib/sewed.js";
import { router } from "./router.js";
import "./style.css";

mountDesktop(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
