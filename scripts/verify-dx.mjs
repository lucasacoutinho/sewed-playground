import { build } from "vite";
import react from "@vitejs/plugin-react";
import { verifyNative } from "./verify-native.mjs";

for (const mode of ["production", "development"]) {
  await build({
    configFile: false,
    root: "scripts/dx-renderer",
    base: "./",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify(mode) },
    build: { outDir: `../../.artifacts/dx-${mode}-renderer`, emptyOutDir: true },
  });
  await verifyNative({
    fixture: "scripts/dx-fixture.mjs",
    artifact: `dx-${mode}`,
    marker: "DX_VERIFICATION",
    electronArgs: mode === "development" ? ["--dx-development"] : [],
  });
}
