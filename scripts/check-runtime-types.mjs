import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

await mkdir(".artifacts", { recursive: true });
const directory = await mkdtemp(resolve(".artifacts/runtime-types-"));
const compiler = resolve("node_modules/typescript/bin/tsc");
const cases = [
  {
    name: "scoped-renderer-resource",
    accepts: true,
    source: `import { Effect } from "effect";
import { useResource } from "@sewed/react";
useResource(() => Effect.acquireRelease(Effect.succeed(1), () => Effect.void), []);
`,
  },
  {
    name: "main-operation-in-react",
    accepts: false,
    requirement: "MainContext",
    source: `import { BrowserWindow } from "sewed/main";
import { useResource } from "@sewed/react";
useResource(() => BrowserWindow.make(), []);
`,
  },
  {
    name: "worker-operation-in-react",
    accepts: false,
    requirement: "WorkerContext",
    source: `import * as Worker from "sewed/worker";
import { useResource } from "@sewed/react";
useResource(() => Worker.threadId, []);
`,
  },
];

try {
  const results = [];
  for (const check of cases) {
    const path = resolve(directory, check.name + ".ts");
    await writeFile(path, check.source);
    const result = spawnSync(
      process.execPath,
      [
        compiler,
        "--ignoreConfig",
        "--noEmit",
        "--pretty",
        "false",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ES2023",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        path,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, check.name);
    if (check.accepts) assert.equal(result.status, 0, output);
    else {
      assert.ok(result.status === 1 || result.status === 2, output);
      assert.match(output, /error TS(2322|2345|2719):/, output);
      assert.ok(output.includes(check.requirement), output);
    }
    results.push({
      name: check.name,
      accepted: result.status === 0,
      requiredRuntime: check.requirement,
    });
    console.log(
      `PASS ${check.name}: ${check.accepts ? "accepted" : "rejected by runtime requirements"}`,
    );
  }
  await writeFile(
    ".artifacts/runtime-types.json",
    JSON.stringify({ success: true, results }, null, 2) + "\n",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
