import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { checkFeatureDocs } from "./feature-docs.mjs";

const map = { features: { alpha: {} } };
const sections = [
  "Behavior",
  "Ownership",
  "Lifetime",
  "Contracts and dependencies",
  "Source",
  "Verification",
  "Limits",
];
const record = (names = sections) =>
  `# Alpha\n\n${names.map((name) => `## ${name}\n\nText.`).join("\n\n")}\n`;

const fixture = async ({ index = "[alpha](docs/features/alpha.md)\n", body = record() } = {}) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sewed-feature-docs-"));
  await mkdir(resolve(projectRoot, "docs/features"), { recursive: true });
  await writeFile(resolve(projectRoot, "FEATURES.md"), index);
  await writeFile(resolve(projectRoot, "docs/features/alpha.md"), body);
  return projectRoot;
};

test("the current feature records match the catalog shape", async () => {
  const checked = await checkFeatureDocs();
  assert.equal(checked.records, 10);
});

test("static checking rejects an unlinked feature record", async () => {
  const projectRoot = await fixture({ index: "# Catalog\n" });
  try {
    await assert.rejects(
      () => checkFeatureDocs({ projectRoot, map }),
      /FEATURES\.md must link its record/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("static checking rejects a record with a changed section shape", async () => {
  const projectRoot = await fixture({ body: record([...sections.slice(0, -1), "Notes"]) });
  try {
    await assert.rejects(
      () => checkFeatureDocs({ projectRoot, map }),
      /record sections must be Behavior, Ownership, Lifetime/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
