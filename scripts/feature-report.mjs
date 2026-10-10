import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { compareVerification } from "./verification-state.mjs";

const text = Schema.String.check(Schema.isMinLength(1));
const strings = Schema.Array(text);
const mode = Schema.Struct({ development: Schema.Boolean, applicationLifetime: Schema.Boolean });
const check = Schema.Struct({ id: text, name: text, evidence: Schema.Unknown });
export const CheckRecords = Schema.Array(check);
const scenario = Schema.Struct({
  id: text,
  description: text,
  checks: strings,
  when: Schema.Literals(["always", "development", "owner-exit", "application-lifetime"]),
  status: Schema.Literals(["covered", "not-observed", "not-applicable"]),
  evidence: CheckRecords,
  missingChecks: strings,
});
const coverage = Schema.Struct({
  mode,
  features: Schema.Record(text, Schema.Struct({ title: text, scenarios: Schema.Array(scenario) })),
});
const fields = {
  version: Schema.Literal(1),
  startedAt: text,
  finishedAt: text,
  mode,
  checks: CheckRecords,
  provenance: Schema.Unknown,
};
const Report = Schema.Union([
  Schema.Struct({ ...fields, success: Schema.Literal(true), coverage }),
  Schema.Struct({
    ...fields,
    success: Schema.Literal(false),
    error: text,
    coverage: Schema.NullOr(coverage),
    coverageError: Schema.NullOr(text),
    context: Schema.Struct({
      lastCompletedCheck: Schema.NullOr(text),
      lastWait: Schema.NullOr(text),
    }),
  }),
]);

export function searchFeatures(map, query) {
  const words = query.trim().toLowerCase().split(/\s+/);
  assert.ok(words[0].length > 0, "Enter feature words, a source path, or a scenario name");
  return Object.entries(map.features).flatMap(([id, feature]) => {
    const haystack = [
      id,
      feature.title,
      feature.runtime,
      feature.route,
      ...feature.sources,
      ...feature.scenarios.flatMap((item) => [item.id, item.description]),
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => haystack.includes(word))
      ? [
          {
            id,
            title: feature.title,
            runtime: feature.runtime,
            route: feature.route,
            sources: feature.sources,
          },
        ]
      : [];
  });
}

export async function readFeatureReport(file, featureId, projectRoot) {
  const raw = JSON.parse(await readFile(resolve(projectRoot, file), "utf8"));
  assert.ok(
    raw?.version === 1,
    "Report has no supported fingerprint format. Run pnpm build and pnpm verify.",
  );
  const report = Schema.decodeUnknownSync(Report)(raw);
  let freshness;
  try {
    freshness = await compareVerification(report.provenance, projectRoot);
  } catch (error) {
    freshness = { status: "unavailable", reason: error.message };
  }
  const feature = report.coverage?.features[featureId] ?? null;
  let status = "unverified";
  if (freshness.status === "current" && feature !== null)
    status = report.success ? "passed" : "failed";
  const result = {
    file,
    status,
    recordedOutcome: report.success ? "passed" : "failed",
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    mode: report.mode,
    freshness,
    feature,
  };
  if (report.success) return result;
  return {
    ...result,
    error: report.error,
    context: report.context,
    coverageError: report.coverageError,
  };
}
