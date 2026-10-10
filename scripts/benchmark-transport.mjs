import { readFile, writeFile } from "node:fs/promises";
import { build } from "vite";
import { verifyNative } from "./verify-native.mjs";

await build({
  configFile: false,
  root: "scripts/transport-renderer",
  base: "./",
  build: { outDir: "../../.artifacts/transport-renderer", emptyOutDir: true },
});
const result = await verifyNative({
  fixture: "scripts/transport-fixture.mjs",
  artifact: "transport",
  marker: "TRANSPORT_VERIFICATION",
  electronArgs: ["--ozone-platform=x11"],
});
const core = JSON.parse(await readFile("node_modules/sewed/package.json", "utf8"));
const effect = JSON.parse(await readFile("node_modules/effect/package.json", "utf8"));
await writeFile(
  ".artifacts/transport-benchmark.json",
  `${JSON.stringify({ ...result, measuredAt: new Date().toISOString(), profile: "batched-streams", packages: { sewed: core.version, effect: effect.version }, scope: "Single local run; payload bytes exclude RPC envelopes. Unary timings are round trips; stream rate counts response payload bytes. Not a capacity guarantee." }, null, 2)}\n`,
);
console.table(
  result.rows.map((row) => ({
    path: row.path,
    KiB: row.bytes / 1024,
    p50ms: row.p50Ms.toFixed(2),
    p95ms: row.p95Ms.toFixed(2),
    streamMiBps: row.stream === undefined ? "-" : row.stream.payloadMiBPerSecond.toFixed(1),
  })),
);
