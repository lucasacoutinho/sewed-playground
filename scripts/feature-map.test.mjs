import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { checkFeatureMap, featureCoverage, featureProgress } from "./feature-map.mjs";

const mapFor = (
  scenarios = [
    { id: "alpha", description: "Alpha works", checks: ["alpha-check"], when: "always" },
  ],
) => ({
  version: 2,
  entrypoints: {
    main: "src/main/app.ts",
    renderer: "src/renderer/main.tsx",
    workers: ["src/worker/index.ts"],
  },
  verification: {
    production: ["pnpm", "verify"],
    development: ["pnpm", "verify", "--dev"],
    preconditions: ["pnpm build"],
  },
  features: {
    alpha: {
      title: "Alpha",
      runtime: "renderer",
      route: "/",
      navigation: "#alpha",
      surface: "#surface",
      sources: ["src/renderer/features/alpha/index.ts"],
      controls: { run: "#run" },
      observations: { rows: ".row" },
      scenarios,
      nativeChecks: ["verify:alpha"],
      featureDirectories: ["alpha"],
    },
  },
});

const fixture = async (
  map = mapFor(),
  verifySource = 'const pass = (id, name, evidence) => {};\npass("alpha-check", "Alpha", {});\n',
) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sewed-feature-map-"));
  await mkdir(resolve(projectRoot, "src/renderer/features/alpha"), { recursive: true });
  await mkdir(resolve(projectRoot, "src/main"), { recursive: true });
  await mkdir(resolve(projectRoot, "src/renderer"), { recursive: true });
  await mkdir(resolve(projectRoot, "src/worker"), { recursive: true });
  await mkdir(resolve(projectRoot, "scripts"), { recursive: true });
  await writeFile(resolve(projectRoot, "src/main/app.ts"), "export {};\n");
  await writeFile(resolve(projectRoot, "src/renderer/main.tsx"), "export {};\n");
  await writeFile(resolve(projectRoot, "src/worker/index.ts"), "export {};\n");
  await writeFile(resolve(projectRoot, "src/renderer/features/alpha/index.ts"), "export {};\n");
  await writeFile(
    resolve(projectRoot, "package.json"),
    JSON.stringify({ scripts: { "verify:alpha": "node scripts/verify.mjs" } }),
  );
  await writeFile(resolve(projectRoot, "scripts/verify.mjs"), verifySource);
  return { projectRoot, map };
};

const withFixture = async (map, callback, verifySource) => {
  const value = await fixture(map, verifySource);
  try {
    await callback(value);
  } finally {
    await rm(value.projectRoot, { recursive: true, force: true });
  }
};

test("the current feature map passes static ownership and harness checks", async () => {
  await checkFeatureMap();
});

test("feature coverage joins real records and marks skipped scenarios", () => {
  const map = mapFor([
    { id: "always", description: "Always", checks: ["alpha-check"], when: "always" },
    { id: "development", description: "Development", checks: ["dev-check"], when: "development" },
    { id: "owner", description: "Owner exit", checks: ["owner-check"], when: "owner-exit" },
    {
      id: "lifetime",
      description: "Application lifetime",
      checks: ["lifetime-check"],
      when: "application-lifetime",
    },
  ]);
  const coverage = featureCoverage(
    [
      { id: "alpha-check", name: "Alpha", evidence: { observed: true } },
      { id: "lifetime-check", name: "Lifetime", evidence: { observed: 1 } },
    ],
    { development: false, applicationLifetime: true },
    map,
  );
  const scenarios = coverage.features.alpha.scenarios;
  assert.equal(scenarios[0].status, "covered");
  assert.deepEqual(scenarios[0].evidence[0], {
    id: "alpha-check",
    name: "Alpha",
    evidence: { observed: true },
  });
  assert.equal(scenarios[1].status, "not-applicable");
  assert.deepEqual(scenarios[1].evidence, []);
  assert.equal(scenarios[2].status, "not-applicable");
  assert.equal(scenarios[3].status, "covered");
});

test("feature coverage rejects missing and duplicate completed evidence", () => {
  assert.throws(() => featureCoverage([], {}, mapFor()), /missing evidence.*alpha-check/);
  assert.throws(
    () =>
      featureCoverage(
        [
          { id: "alpha-check", name: "Alpha", evidence: {} },
          { id: "alpha-check", name: "Alpha again", evidence: {} },
        ],
        {},
        mapFor(),
      ),
    /Duplicate completed check ID: alpha-check/,
  );
  assert.throws(
    () => featureCoverage([{ id: "alpha-check", name: "Alpha" }], {}, mapFor()),
    /Missing key/,
  );
});

test("failed runs retain observed checks without marking unvisited scenarios as failed", () => {
  const map = mapFor([
    {
      id: "partial",
      description: "A then B",
      checks: ["alpha-check", "beta-check"],
      when: "always",
    },
    { id: "development", description: "Refresh", checks: ["dev-check"], when: "development" },
  ]);
  const checks = [{ id: "alpha-check", name: "A passed", evidence: { active: 0 } }];
  const progress = featureProgress(checks, {}, map);
  assert.deepEqual(progress.features.alpha.scenarios[0].evidence, checks);
  assert.equal(progress.features.alpha.scenarios[0].status, "not-observed");
  assert.deepEqual(progress.features.alpha.scenarios[0].missingChecks, ["beta-check"]);
  assert.equal(progress.features.alpha.scenarios[1].status, "not-applicable");
  assert.throws(() => featureCoverage(checks, {}, map), /missing evidence.*beta-check/);
});

test("static checking rejects stale scenario check IDs", async () => {
  const map = mapFor([
    { id: "stale", description: "Stale", checks: ["removed-check"], when: "always" },
  ]);
  await withFixture(map, async ({ projectRoot }) => {
    await assert.rejects(
      () => checkFeatureMap({ projectRoot, map }),
      /check ID is not a literal pass\(\) ID.*removed-check/,
    );
  });
});

test("static checking rejects nonliteral and duplicate native check IDs", async () => {
  await withFixture(
    mapFor(),
    async ({ projectRoot, map }) => {
      await assert.rejects(
        () => checkFeatureMap({ projectRoot, map }),
        /Native pass\(\) IDs must be string literals/,
      );
    },
    'const pass = (id, name, evidence) => {};\nconst id = "alpha-check";\npass(id, "Alpha", {});\n',
  );
  await withFixture(
    mapFor(),
    async ({ projectRoot, map }) => {
      await assert.rejects(
        () => checkFeatureMap({ projectRoot, map }),
        /Duplicate native check ID: alpha-check/,
      );
    },
    'const pass = (id, name, evidence) => {};\npass("alpha-check", "Alpha", {});\npass("alpha-check", "Alpha again", {});\n',
  );
});

test("static checking rejects duplicate scenario IDs in one feature", async () => {
  const map = mapFor([
    { id: "same", description: "One", checks: ["alpha-check"], when: "always" },
    { id: "same", description: "Two", checks: ["alpha-check"], when: "always" },
  ]);
  await withFixture(map, async ({ projectRoot }) => {
    await assert.rejects(
      () => checkFeatureMap({ projectRoot, map }),
      /alpha: duplicate scenario ID same/,
    );
  });
});

test("static checking rejects source ownership drift", async () => {
  const map = mapFor();
  await withFixture(map, async ({ projectRoot }) => {
    await mkdir(resolve(projectRoot, "src/renderer/features/beta"), { recursive: true });
    await writeFile(resolve(projectRoot, "src/renderer/features/beta/index.ts"), "export {};\n");
    const drifted = structuredClone(map);
    drifted.features.beta = {
      ...structuredClone(drifted.features.alpha),
      title: "Beta",
      sources: ["src/renderer/features/beta/index.ts"],
      featureDirectories: ["beta"],
    };
    drifted.features.alpha.sources.push("src/renderer/features/beta/index.ts");
    await assert.rejects(
      () => checkFeatureMap({ projectRoot, map: drifted }),
      /duplicate feature directory ownership|source belongs to|Every feature directory/,
    );
  });
});

test("static checking rejects omitted nested source files", async () => {
  const map = mapFor();
  await withFixture(map, async ({ projectRoot }) => {
    await mkdir(resolve(projectRoot, "src/renderer/features/alpha/nested"), { recursive: true });
    await writeFile(
      resolve(projectRoot, "src/renderer/features/alpha/nested/extra.mjs"),
      "export {};\n",
    );
    await assert.rejects(
      () => checkFeatureMap({ projectRoot, map }),
      /feature source file is omitted.*extra\.mjs/,
    );
  });
});

test("static checking rejects symbolic links in feature source trees", async () => {
  await withFixture(mapFor(), async ({ projectRoot, map }) => {
    await symlink(
      resolve(projectRoot, "src/main/app.ts"),
      resolve(projectRoot, "src/renderer/features/alpha/linked.ts"),
    );
    await assert.rejects(
      () => checkFeatureMap({ projectRoot, map }),
      /Feature source contains a symbolic link/,
    );
  });
});

test("static checking rejects an unregistered feature directory", async () => {
  await withFixture(mapFor(), async ({ projectRoot, map }) => {
    await mkdir(resolve(projectRoot, "src/renderer/features/orphan"), { recursive: true });
    await writeFile(resolve(projectRoot, "src/renderer/features/orphan/index.ts"), "export {};\n");
    await assert.rejects(
      () => checkFeatureMap({ projectRoot, map }),
      /Every feature directory must be mapped exactly once/,
    );
  });
});

test("static checking rejects duplicate directory ownership", async () => {
  await withFixture(mapFor(), async ({ projectRoot, map }) => {
    const duplicate = structuredClone(map);
    duplicate.features.alpha.featureDirectories = ["alpha", "alpha"];
    await assert.rejects(
      () => checkFeatureMap({ projectRoot, map: duplicate }),
      /duplicate feature directory alpha|Duplicate feature directory ownership: alpha/,
    );
  });
});

test("static checking rejects entrypoints in the wrong compartment and missing files", async () => {
  await withFixture(mapFor(), async ({ projectRoot, map }) => {
    const invalidEntrypoint = structuredClone(map);
    invalidEntrypoint.entrypoints.main = "src/worker/index.ts";
    await assert.rejects(
      () => checkFeatureMap({ projectRoot, map: invalidEntrypoint }),
      /main: entrypoint must belong to src\/main/,
    );
    const missingSource = structuredClone(map);
    missingSource.features.alpha.sources.push("src/renderer/missing.ts");
    await assert.rejects(
      () => checkFeatureMap({ projectRoot, map: missingSource }),
      /source is not a file: src\/renderer\/missing\.ts/,
    );
  });
});
