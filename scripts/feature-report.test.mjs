import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFeatureReport, searchFeatures } from "./feature-report.mjs";
import { featureMap } from "./feature-map.mjs";

test("feature lookup accepts words, runtime concepts and source filenames", () => {
  assert.ok(
    searchFeatures(featureMap, "binary stream").some((feature) => feature.id === "resources"),
  );
  assert.ok(
    searchFeatures(featureMap, "USE-RESOURCE.TS").some((feature) => feature.id === "resources"),
  );
  assert.ok(
    searchFeatures(featureMap, "renderer recovery").some((feature) => feature.id === "renderers"),
  );
  assert.deepEqual(searchFeatures(featureMap, "no-such-feature"), []);
  assert.throws(() => searchFeatures(featureMap, "  "), /Enter feature words/);
});

const withReport = async (report, run) => {
  const root = await mkdtemp(join(tmpdir(), "sewed-report-"));
  try {
    await writeFile(join(root, "report.json"), JSON.stringify(report));
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("a legacy successful report cannot be presented as current proof", async () => {
  await withReport({ success: true, checks: [] }, async (root) => {
    await assert.rejects(
      () => readFeatureReport("report.json", "resources", root),
      /fingerprint format/,
    );
  });
});

test("preflight failure reports expose unobserved coverage and their cause", async () => {
  const mode = { development: false, applicationLifetime: false };
  const report = {
    version: 1,
    success: false,
    startedAt: "2026-09-13T00:00:00.000Z",
    finishedAt: "2026-09-13T00:00:01.000Z",
    mode,
    checks: [],
    provenance: null,
    error: "Build is stale. Run pnpm build.",
    coverageError: null,
    context: { lastCompletedCheck: null, lastWait: null },
    coverage: {
      mode,
      features: {
        resources: {
          title: "Resources",
          scenarios: [
            {
              id: "read",
              description: "Read bytes",
              checks: ["read"],
              when: "always",
              status: "not-observed",
              evidence: [],
              missingChecks: ["read"],
            },
          ],
        },
      },
    },
  };
  await withReport(report, async (root) => {
    const result = await readFeatureReport("report.json", "resources", root);
    assert.equal(result.status, "unverified");
    assert.equal(result.recordedOutcome, "failed");
    assert.equal(result.freshness.status, "unavailable");
    assert.deepEqual(result.context, report.context);
    assert.equal(result.error, report.error);
    assert.equal(result.feature.scenarios[0].status, "not-observed");
  });
});
