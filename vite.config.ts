import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { sewed } from "@sewed/vite";
import { sewedDevTools } from "@sewed/devtools/vite";

const renderer = fileURLToPath(new URL("./src/renderer", import.meta.url));

export default defineConfig(({ mode }) => ({
  root: renderer,
  base: "./",
  server: { host: "127.0.0.1" },
  plugins: [
    (mode === "inspect" ? sewedDevTools : sewed)({
      main: "src/main/app.ts",
      tsconfig: "tsconfig.electron.json",
      electronArgs:
        process.env.SEWED_DEBUG_PORT === undefined
          ? []
          : [`--remote-debugging-port=${process.env.SEWED_DEBUG_PORT}`],
    }),
    tanstackRouter({
      target: "react",
      routesDirectory: `${renderer}/routes`,
      generatedRouteTree: `${renderer}/routeTree.gen.ts`,
      autoCodeSplitting: true,
      quoteStyle: "double",
      semicolons: true,
    }),
    react(),
    {
      name: "playground-development-csp",
      apply: "serve",
      transformIndexHtml(html) {
        return html.replace(
          "script-src 'self'; style-src 'self'",
          "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*",
        );
      },
    },
    {
      name: "playground-bundle-evidence",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "renderer-meta.json",
          source: JSON.stringify({
            inputs: Object.fromEntries(Array.from(this.getModuleIds(), (id) => [id, {}])),
          }),
        });
      },
    },
  ],
  build: {
    outDir: fileURLToPath(new URL("./dist/renderer", import.meta.url)),
    emptyOutDir: true,
  },
}));
