import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { featureMap } from "./feature-map.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const requiredSections = [
  "Behavior",
  "Ownership",
  "Lifetime",
  "Contracts and dependencies",
  "Source",
  "Verification",
  "Limits",
];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const readRecord = async (projectRoot, relativePath, label) => {
  const filename = resolve(projectRoot, relativePath);
  let details;
  try {
    details = await lstat(filename);
  } catch {
    assert.fail(`${label}: missing feature record: ${relativePath}`);
  }
  assert.ok(details.isFile(), `${label}: feature record is not a file: ${relativePath}`);
  return readFile(filename, "utf8");
};

const recordSections = (source) =>
  [...source.matchAll(/^##\s+([^\r\n]+?)\s*$/gm)].map((match) => match[1]);

export async function checkFeatureDocs({ projectRoot = root, map = featureMap } = {}) {
  const projectRootPath = resolve(projectRoot);
  const index = await readFile(resolve(projectRootPath, "FEATURES.md"), "utf8");
  const featureIds = Object.keys(map.features);
  assert.ok(featureIds.length > 0, "Feature map must contain at least one feature");

  for (const featureId of featureIds) {
    const label = `Feature ${featureId}`;
    const recordPath = `docs/features/${featureId}.md`;
    assert.match(
      index,
      new RegExp(`\\]\\(${escapeRegExp(recordPath)}(?:#[^)]+)?\\)`),
      `${label}: FEATURES.md must link its record: ${recordPath}`,
    );
    const record = await readRecord(projectRootPath, recordPath, label);
    assert.match(record, /^#\s+[^\r\n]+$/m, `${label}: record must have a level-one title`);
    assert.deepEqual(
      recordSections(record),
      requiredSections,
      `${label}: record sections must be ${requiredSections.join(", ")}`,
    );
  }
  return { records: featureIds.length };
}

if (import.meta.main) {
  try {
    const checked = await checkFeatureDocs();
    console.log(`Feature docs: ${checked.records} records`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
