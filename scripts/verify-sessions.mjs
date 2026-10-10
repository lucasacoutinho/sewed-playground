import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "vite";
import { verifyNative } from "./verify-native.mjs";

await build({
  configFile: false,
  root: "scripts/session-renderer",
  base: "./",
  build: { outDir: "../../.artifacts/session-renderer", emptyOutDir: true },
});
const assets = new Map();
const root = ".artifacts/session-renderer";
for (const relative of await readdir(root, { recursive: true })) {
  const file = path.join(root, relative);
  if ((await stat(file)).isFile())
    assets.set(`/${relative.split(path.sep).join("/")}`, await readFile(file));
}
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/redirect") {
    response.writeHead(302, { location: "/index.html?redirected" });
    response.end();
    return;
  }
  if (url.pathname === "/cookie") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ cookie: request.headers.cookie ?? "" }));
    return;
  }
  const body = assets.get(url.pathname);
  response.writeHead(body === undefined ? 404 : 200, {
    "content-type": url.pathname.endsWith(".js") ? "text/javascript" : "text/html",
    "cache-control": "no-store",
  });
  response.end(body);
});
const profiles = await mkdtemp(path.join(tmpdir(), "sewed-sessions-"));
const cases = [];
await writeFile(".artifacts/sessions-verification.json", JSON.stringify({ success: false, cases }));
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  for (const scenario of ["full", "write", "read"]) {
    const profile = path.join(profiles, scenario === "full" ? "full" : "restart");
    await mkdir(profile, { recursive: true });
    const result = await verifyNative({
      fixture: "scripts/session-fixture.mjs",
      artifact: `sessions-${scenario}`,
      marker: "SESSION_VERIFICATION",
      electronArgs: [
        "--ozone-platform=x11",
        `--sewed-session-case=${scenario}`,
        `--sewed-session-profile=${profile}`,
        `--sewed-session-origin=${origin}`,
      ],
    });
    cases.push(result);
  }
  await writeFile(
    ".artifacts/sessions-verification.json",
    `${JSON.stringify(
      {
        success: true,
        report: { checks: cases.flatMap((result) => result.checks), cases },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(profiles, { recursive: true, force: true });
}
