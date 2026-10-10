import assert from "node:assert/strict";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Schema } from "effect";
import { parseSync, visitorKeys } from "oxc-parser";
import { isSourceFile, sourceCompartment } from "./architecture.mjs";
import { CheckRecords, readFeatureReport, searchFeatures } from "./feature-report.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const text = Schema.String.check(Schema.isMinLength(1));
const strings = Schema.Array(text);
const nonEmptyStrings = strings.check(Schema.isMinLength(1));
const selectors = Schema.Record(text, text);
const scenarioConditions = Schema.Literals([
  "always",
  "development",
  "owner-exit",
  "application-lifetime",
]);
const Scenario = Schema.Struct({
  id: text,
  description: text,
  checks: nonEmptyStrings,
  when: scenarioConditions,
});
const Feature = Schema.Struct({
  title: text,
  runtime: Schema.Literals(["main", "worker", "renderer"]),
  route: text,
  navigation: text,
  surface: text,
  sources: nonEmptyStrings,
  controls: selectors,
  observations: selectors,
  scenarios: Schema.Array(Scenario).check(Schema.isMinLength(1)),
  nativeChecks: strings,
  featureDirectories: nonEmptyStrings,
});
const FeatureMap = Schema.Struct({
  version: Schema.Literal(2),
  entrypoints: Schema.Struct({ main: text, renderer: text, workers: nonEmptyStrings }),
  verification: Schema.Struct({
    production: strings,
    development: strings,
    preconditions: strings,
  }),
  features: Schema.Record(text, Feature),
});

const canonicalName = /^[a-z][a-z0-9-]*$/;
const projectPath = (file) => file.replaceAll("\\", "/");
const decodeFeatureMap = (map) => Schema.decodeUnknownSync(FeatureMap)(map);

export const featureMap = decodeFeatureMap(
  JSON.parse(await readFile(new URL("./feature-map.json", import.meta.url), "utf8")),
);

const assertCanonicalPath = (value, label) => {
  assert.equal(value, projectPath(value), `${label}: paths must use forward slashes`);
  assert.equal(value, posix.normalize(value), `${label}: path is not canonical`);
  assert.ok(!value.startsWith("/"), `${label}: path must be project-relative`);
  assert.ok(value.startsWith("src/"), `${label}: path must be inside src`);
};

const assertCanonicalName = (value, label) => {
  assert.match(value, canonicalName, `${label}: name is not canonical`);
};

const sourceFile = async (projectRoot, sourceRoot, source, label) => {
  assertCanonicalPath(source, label);
  const candidate = resolve(projectRoot, source);
  let actual;
  try {
    actual = await realpath(candidate);
  } catch {
    assert.fail(`${label}: source is not a file: ${source}`);
  }
  assert.ok(actual.startsWith(sourceRoot + sep), `${label}: source escapes src: ${source}`);
  const details = await stat(actual);
  assert.ok(details.isFile(), `${label}: source is not a file: ${source}`);
  const actualProjectPath = projectPath(relative(projectRoot, actual));
  assert.equal(actualProjectPath, source, `${label}: source path is not canonical: ${source}`);
  return actual;
};

const walkSourceFiles = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.ok(
      !entry.isSymbolicLink(),
      `Feature source contains a symbolic link: ${directory}/${entry.name}`,
    );
    const candidate = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkSourceFiles(candidate)));
    else if (entry.isFile() && isSourceFile(entry.name)) files.push(candidate);
  }
  return files;
};

const nativeCheckIds = async (projectRoot) => {
  const filename = "scripts/verify.mjs";
  const source = await readFile(resolve(projectRoot, filename), "utf8");
  const parsed = parseSync(filename, source, {
    lang: "js",
    astType: "ts",
    sourceType: "module",
  });
  assert.equal(parsed.errors.length, 0, `Native harness does not parse: ${filename}`);
  const ids = new Set();
  const visit = (node) => {
    if (node === null || typeof node !== "object" || typeof node.type !== "string") return;
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "pass"
    ) {
      const first = node.arguments?.[0];
      assert.ok(node.arguments.length >= 2, "Native pass() calls require an ID and name");
      assert.ok(
        first?.type === "Literal" && typeof first.value === "string",
        "Native pass() IDs must be string literals",
      );
      assert.ok(!ids.has(first.value), `Duplicate native check ID: ${first.value}`);
      ids.add(first.value);
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) for (const item of child) visit(item);
      else visit(child);
    }
  };
  visit(parsed.program);
  return ids;
};

const scenarioEntries = (map) => {
  const entries = [];
  for (const [featureId, feature] of Object.entries(map.features)) {
    assertCanonicalName(featureId, `Feature ${featureId}`);
    const scenarioIds = new Set();
    for (const scenario of feature.scenarios) {
      assertCanonicalName(scenario.id, `${featureId} scenario ${scenario.id}`);
      assert.ok(
        !scenarioIds.has(scenario.id),
        `${featureId}: duplicate scenario ID ${scenario.id}`,
      );
      scenarioIds.add(scenario.id);
      entries.push({ featureId, scenario });
    }
  }
  return entries;
};

const scenarioIsActive = (condition, { development, applicationLifetime }) => {
  if (condition === "always") return true;
  if (condition === "development") return development;
  if (condition === "owner-exit") return !applicationLifetime;
  return applicationLifetime;
};

export function featureProgress(
  checks,
  { development = false, applicationLifetime = false } = {},
  map = featureMap,
) {
  assert.equal(typeof development, "boolean", "development mode must be a boolean");
  assert.equal(
    typeof applicationLifetime,
    "boolean",
    "application lifetime mode must be a boolean",
  );
  const decodedMap = decodeFeatureMap(map);
  const records = Schema.decodeUnknownSync(CheckRecords)(checks);
  const scenarios = scenarioEntries(decodedMap);
  const mappedCheckIds = new Set(scenarios.flatMap(({ scenario }) => scenario.checks));
  const completed = new Map();
  for (const record of records) {
    assert.ok(mappedCheckIds.has(record.id), `Completed check is not mapped: ${record.id}`);
    assert.ok(!completed.has(record.id), `Duplicate completed check ID: ${record.id}`);
    completed.set(record.id, record);
  }
  const features = Object.fromEntries(
    Object.entries(decodedMap.features).map(([featureId, feature]) => [
      featureId,
      {
        title: feature.title,
        scenarios: feature.scenarios.map((scenario) => {
          const active = scenarioIsActive(scenario.when, { development, applicationLifetime });
          const required = active ? scenario.checks : [];
          const evidence = required.flatMap((checkId) => {
            const record = completed.get(checkId);
            return record === undefined ? [] : [record];
          });
          const missingChecks = required.filter((checkId) => !completed.has(checkId));
          let status = "not-applicable";
          if (active) status = missingChecks.length === 0 ? "covered" : "not-observed";
          return {
            id: scenario.id,
            description: scenario.description,
            checks: scenario.checks,
            when: scenario.when,
            status,
            evidence,
            missingChecks,
          };
        }),
      },
    ]),
  );
  return {
    mode: { development, applicationLifetime },
    features,
  };
}

export function featureCoverage(checks, mode, map = featureMap) {
  const progress = featureProgress(checks, mode, map);
  for (const [featureId, feature] of Object.entries(progress.features))
    for (const scenario of feature.scenarios)
      assert.equal(
        scenario.missingChecks.length,
        0,
        `${featureId}/${scenario.id}: missing evidence for check ${scenario.missingChecks.join(", ")}`,
      );
  return progress;
}

export async function checkFeatureMap({ projectRoot = root, map = featureMap } = {}) {
  const projectRootPath = await realpath(projectRoot);
  const decodedMap = decodeFeatureMap(map);
  const sourceRoot = await realpath(resolve(projectRootPath, "src"));
  const featureRoot = resolve(projectRootPath, "src/renderer/features");
  assert.equal(
    await realpath(featureRoot),
    featureRoot,
    "Feature directory root must not be a symbolic link",
  );
  const manifest = JSON.parse(await readFile(resolve(projectRootPath, "package.json"), "utf8"));
  assert.ok(
    manifest?.scripts !== null && typeof manifest?.scripts === "object",
    "package.json must declare scripts",
  );

  const { entrypoints, features } = decodedMap;
  const entrypointEntries = [
    ["main", entrypoints.main, "main"],
    ["renderer", entrypoints.renderer, "renderer"],
    ...entrypoints.workers.map((entrypoint, index) => [`worker[${index}]`, entrypoint, "worker"]),
  ];
  const allSources = new Set();
  for (const [label, source, compartment] of entrypointEntries) {
    assert.equal(
      sourceCompartment(source),
      compartment,
      `${label}: entrypoint must belong to src/${compartment}`,
    );
    await sourceFile(projectRootPath, sourceRoot, source, label);
    allSources.add(source);
  }

  const actualDirectories = [];
  for (const entry of await readdir(featureRoot, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), `Feature source contains a symbolic link: ${entry.name}`);
    if (entry.isDirectory()) {
      assertCanonicalName(entry.name, `Feature directory ${entry.name}`);
      actualDirectories.push(entry.name);
    }
  }
  const directoryOwners = new Map();
  for (const [featureId, feature] of Object.entries(features)) {
    assertCanonicalName(featureId, `Feature ${featureId}`);
    for (const directory of feature.featureDirectories) {
      assertCanonicalName(directory, `${featureId}: feature directory ${directory}`);
      assert.ok(
        !directoryOwners.has(directory),
        `Duplicate feature directory ownership: ${directory}`,
      );
      assert.ok(
        actualDirectories.includes(directory),
        `${featureId}: feature directory is missing: ${directory}`,
      );
      directoryOwners.set(directory, featureId);
    }
    for (const script of feature.nativeChecks)
      assert.ok(
        Object.hasOwn(manifest.scripts, script) && typeof manifest.scripts[script] === "string",
        `${featureId}: missing script ${script}`,
      );
  }
  assert.deepEqual(
    [...directoryOwners.keys()].sort(),
    actualDirectories.sort(),
    "Every feature directory must be mapped exactly once",
  );

  for (const [featureId, feature] of Object.entries(features)) {
    const featureSources = new Set();
    for (const source of feature.sources) {
      assert.ok(!featureSources.has(source), `${featureId}: duplicate source ${source}`);
      featureSources.add(source);
      allSources.add(source);
      await sourceFile(projectRootPath, sourceRoot, source, `${featureId}: ${source}`);
      if (source.startsWith("src/renderer/features/")) {
        const owner = directoryOwners.get(source.split("/")[3]);
        assert.equal(
          owner,
          featureId,
          `${featureId}: source belongs to ${owner ?? "an unregistered feature"}: ${source}`,
        );
      }
    }
    for (const directory of feature.featureDirectories) {
      for (const file of await walkSourceFiles(resolve(featureRoot, directory))) {
        const source = projectPath(relative(projectRootPath, file));
        assert.ok(
          featureSources.has(source),
          `${featureId}: feature source file is omitted from sources: ${source}`,
        );
      }
    }
  }

  const nativeIds = await nativeCheckIds(projectRootPath);
  for (const { featureId, scenario } of scenarioEntries(decodedMap))
    for (const checkId of scenario.checks)
      assert.ok(
        nativeIds.has(checkId),
        `${featureId}/${scenario.id}: check ID is not a literal pass() ID in scripts/verify.mjs: ${checkId}`,
      );
  return { features: Object.keys(features).length, sources: allSources.size };
}

export async function exerciseFeatureMap(page, until) {
  const visited = [];
  for (const [id, feature] of Object.entries(featureMap.features)) {
    await page.call("Page.bringToFront");
    await page.evaluate(`document.querySelector(${JSON.stringify(feature.navigation)}).focus()`);
    for (const type of ["keyDown", "keyUp"])
      await page.call("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
    await until(
      async () => (await page.attribute(feature.navigation, "aria-current")) === "page",
      `${id}: route active`,
    );
    const required = [feature.navigation, feature.surface];
    await until(
      () =>
        page.evaluate(`
      ${JSON.stringify(required)}.every(selector => document.querySelectorAll(selector).length === 1)
    `),
      `${id}: mapped navigation and surface exist exactly once`,
    );
    const controls = Object.values(feature.controls);
    await until(
      () =>
        page.evaluate(`
      ${JSON.stringify(controls)}.every(selector => document.querySelectorAll(selector).length >= 1)
    `),
      `${id}: mapped controls exist`,
    );
    assert.equal(await page.evaluate("location.hash"), `#${feature.route}`, `${id}: route`);
    visited.push(id);
  }
  await page.click(featureMap.features.requests.navigation);
  return visited;
}

if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        check: { type: "boolean" },
        find: { type: "string" },
        report: { type: "string" },
        help: { type: "boolean" },
      },
    });
    assert.ok(positionals.length <= 1, "Choose one feature ID");
    const [id] = positionals;
    if (values.help) {
      console.log(
        "pnpm verify:features [id]\npnpm verify:features --find <words>\npnpm verify:features <id> --report <file>\npnpm verify:features --check",
      );
    } else {
      assert.ok(
        !values.check ||
          (id === undefined && values.find === undefined && values.report === undefined),
        "Use --check on its own",
      );
      assert.ok(
        values.find === undefined || (id === undefined && values.report === undefined),
        "Use --find on its own",
      );
      assert.ok(values.report === undefined || id !== undefined, "--report requires a feature ID");
      const checked = await checkFeatureMap();
      if (values.check) {
        console.log(`Feature map: ${checked.features} features, ${checked.sources} source files`);
      } else if (values.find !== undefined) {
        console.log(JSON.stringify(searchFeatures(featureMap, values.find), null, 2));
      } else if (id !== undefined) {
        assert.ok(
          Object.hasOwn(featureMap.features, id),
          `Unknown feature ${id}; choose ${Object.keys(featureMap.features).join(", ")}`,
        );
        const result = { id, ...featureMap.features[id], verification: featureMap.verification };
        if (values.report !== undefined) {
          const report = await readFeatureReport(values.report, id, root);
          console.log(JSON.stringify({ ...result, report }, null, 2));
          if (report.status !== "passed") process.exitCode = 1;
        } else console.log(JSON.stringify(result, null, 2));
      } else {
        for (const [featureId, feature] of Object.entries(featureMap.features))
          console.log(
            `${featureId.padEnd(12)} ${feature.title} (${feature.runtime}, ${feature.route})`,
          );
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
