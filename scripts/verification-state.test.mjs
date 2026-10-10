import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  assertCurrentBuild,
  captureArtifacts,
  captureInputs,
  captureVerification,
  changedFiles,
  compareVerification,
  writeBuildEvidence,
} from "./verification-state.mjs";

const packages = ["sewed", "@sewed/react", "@sewed/vite", "@sewed/devtools"];
const requiredArtifacts = [
  "dist/main/app.js",
  "dist/renderer/index.html",
  "dist/renderer/renderer-meta.json",
];

const put = async (projectRoot, relativeFile, contents) => {
  const file = join(projectRoot, relativeFile);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents);
};

const fixture = async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sewed-verification-"));
  await Promise.all([
    put(projectRoot, "package.json", '{"name":"fixture"}\n'),
    put(projectRoot, "pnpm-lock.yaml", "lockfileVersion: 9\n"),
    put(projectRoot, "vite.config.ts", "export default {};\n"),
    put(projectRoot, "tsconfig.json", "{}\n"),
    put(projectRoot, "tsconfig.electron.json", "{}\n"),
    put(projectRoot, "scripts/build.mjs", "export {};\n"),
    put(projectRoot, "scripts/verification-state.mjs", "export {};\n"),
    put(projectRoot, "scripts/feature-map.json", '{"version":2}\n'),
    put(projectRoot, "scripts/verify.mjs", "console.log('verify');\n"),
    put(projectRoot, "scripts/feature-map.mjs", "export {};\n"),
    put(projectRoot, "scripts/architecture.mjs", "export {};\n"),
    put(projectRoot, "scripts/feature-report.mjs", "export {};\n"),
    put(projectRoot, "src/main/app.ts", "export const app = 1;\n"),
    put(projectRoot, "src/renderer/index.html", "<!doctype html>\n"),
    put(projectRoot, "src/renderer/assets/font.ttf", "font\n"),
    put(projectRoot, "src/renderer/routeTree.gen.ts", "generated\n"),
    put(projectRoot, "src/shared/contracts.ts", "export const contract = 1;\n"),
    put(projectRoot, "src/worker/compute.ts", "export const compute = 1;\n"),
    put(projectRoot, "dist/main/app.js", "main\n"),
    put(projectRoot, "dist/renderer/index.html", "<!doctype html>\n"),
    put(projectRoot, "dist/renderer/renderer-meta.json", '{"inputs":{}}\n'),
    put(projectRoot, "dist/renderer/assets/app.js", "renderer\n"),
    ...packages.flatMap((name) => [
      put(projectRoot, `node_modules/${name}/package.json`, `{"name":"${name}"}\n`),
      put(projectRoot, `node_modules/${name}/lib/index.js`, `${name}\n`),
    ]),
  ]);
  return projectRoot;
};

const withFixture = async (run) => {
  const projectRoot = await fixture();
  try {
    return await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
};

const evidence = async (projectRoot) => {
  const inputsBefore = await captureInputs(projectRoot);
  return writeBuildEvidence(inputsBefore, projectRoot);
};

test("captureInputs hashes sorted source, config, scripts, and installed Sewed files", async () =>
  withFixture(async (projectRoot) => {
    const inputs = await captureInputs(projectRoot);
    assert.deepEqual(Object.keys(inputs), [...Object.keys(inputs)].sort());
    assert.ok(Object.hasOwn(inputs, "src/renderer/assets/font.ttf"));
    assert.ok(Object.hasOwn(inputs, "node_modules/sewed/package.json"));
    assert.ok(Object.hasOwn(inputs, "node_modules/@sewed/devtools/lib/index.js"));
    assert.equal(Object.hasOwn(inputs, "src/renderer/routeTree.gen.ts"), false);
    for (const value of Object.values(inputs)) assert.match(value, /^[a-f0-9]{64}$/);
  }));

test("captureArtifacts excludes its own evidence and requires the build outputs", async () =>
  withFixture(async (projectRoot) => {
    await put(projectRoot, "dist/.verification-build.json", "old\n");
    const artifacts = await captureArtifacts(projectRoot);
    assert.equal(Object.hasOwn(artifacts, "dist/.verification-build.json"), false);
    await rm(join(projectRoot, requiredArtifacts[2]));
    await assert.rejects(
      captureArtifacts(projectRoot),
      /missing dist\/renderer\/renderer-meta\.json/,
    );
  }));

test("changedFiles reports sorted additions, edits, and deletions", () => {
  assert.deepEqual(
    changedFiles(
      { "z.txt": "old", "same.txt": "x", "deleted.txt": "x" },
      {
        "z.txt": "new",
        "same.txt": "x",
        "added.txt": "x",
      },
    ),
    ["added.txt", "deleted.txt", "z.txt"],
  );
});

test("valid build and verification snapshots round trip as current", async () =>
  withFixture(async (projectRoot) => {
    const build = await evidence(projectRoot);
    assert.deepEqual(await assertCurrentBuild(projectRoot), build);
    const verification = await captureVerification(projectRoot);
    assert.equal(verification.version, 1);
    assert.match(verification.capturedAt, /Z$/);
    assert.ok(Object.hasOwn(verification.inputs, "scripts/feature-map.json"));
    assert.deepEqual(await compareVerification(verification, projectRoot), {
      status: "current",
      changed: [],
    });
    const saved = JSON.parse(
      await readFile(join(projectRoot, "dist/.verification-build.json"), "utf8"),
    );
    assert.deepEqual(saved, build);
  }));

test("source drift makes both build assertion and reporting stale", async () =>
  withFixture(async (projectRoot) => {
    await evidence(projectRoot);
    const verification = await captureVerification(projectRoot);
    await put(projectRoot, "src/main/app.ts", "export const app = 2;\n");
    await assert.rejects(assertCurrentBuild(projectRoot), /src\/main\/app\.ts.*Run pnpm build/);
    assert.deepEqual(await compareVerification(verification, projectRoot), {
      status: "stale",
      changed: ["src/main/app.ts"],
    });
  }));

test("reporting detects edited and removed artifacts without requiring a build", async () =>
  withFixture(async (projectRoot) => {
    await evidence(projectRoot);
    const edited = await captureVerification(projectRoot);
    await put(projectRoot, "dist/renderer/index.html", "edited\n");
    assert.deepEqual(await compareVerification(edited, projectRoot), {
      status: "stale",
      changed: ["dist/renderer/index.html"],
    });

    const removedRoot = await fixture();
    try {
      await evidence(removedRoot);
      const removed = await captureVerification(removedRoot);
      await rm(join(removedRoot, "dist/renderer/renderer-meta.json"));
      assert.deepEqual(await compareVerification(removed, removedRoot), {
        status: "stale",
        changed: ["dist/renderer/renderer-meta.json"],
      });
    } finally {
      await rm(removedRoot, { recursive: true, force: true });
    }
  }));

test("reporting detects installed Sewed implementation drift", async () =>
  withFixture(async (projectRoot) => {
    await evidence(projectRoot);
    const verification = await captureVerification(projectRoot);
    await put(projectRoot, "node_modules/sewed/lib/index.js", "changed\n");
    const result = await compareVerification(verification, projectRoot);
    assert.equal(result.status, "stale");
    assert.deepEqual(result.changed, ["node_modules/sewed/lib/index.js"]);
  }));

test("writeBuildEvidence rejects edits made during the build", async () =>
  withFixture(async (projectRoot) => {
    const inputsBefore = await captureInputs(projectRoot);
    await put(projectRoot, "src/worker/compute.ts", "export const compute = 2;\n");
    await assert.rejects(
      writeBuildEvidence(inputsBefore, projectRoot),
      /Build inputs changed during the build: src\/worker\/compute\.ts/,
    );
    await assert.rejects(readFile(join(projectRoot, "dist/.verification-build.json")), {
      code: "ENOENT",
    });
  }));

test("missing and malformed build evidence are actionable, and malformed reports throw", async () =>
  withFixture(async (projectRoot) => {
    await assert.rejects(assertCurrentBuild(projectRoot), /missing.*Run pnpm build/);
    await put(projectRoot, "dist/.verification-build.json", "{}\n");
    await assert.rejects(assertCurrentBuild(projectRoot), /invalid[\s\S]*Run pnpm build/);
    await assert.rejects(
      compareVerification(
        { version: 1, capturedAt: "bad", inputs: {}, artifacts: {} },
        projectRoot,
      ),
      /Verification evidence is invalid/,
    );
  }));
