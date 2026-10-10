import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { Schema } from "effect";

const root = fileURLToPath(new URL("../", import.meta.url));
const generatedRouteTree = "src/renderer/routeTree.gen.ts";
const buildEvidencePath = "dist/.verification-build.json";
const packageNames = ["sewed", "@sewed/react", "@sewed/vite", "@sewed/devtools"];
const buildInputPaths = [
  "package.json",
  "pnpm-lock.yaml",
  "vite.config.ts",
  "scripts/build.mjs",
  "scripts/verification-state.mjs",
];
const verificationInputPaths = [
  "scripts/feature-map.json",
  "scripts/verify.mjs",
  "scripts/feature-map.mjs",
  "scripts/architecture.mjs",
  "scripts/feature-report.mjs",
];
const requiredArtifacts = [
  "dist/main/app.js",
  "dist/renderer/index.html",
  "dist/renderer/renderer-meta.json",
];

const hash = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)));
const path = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^(?!\/)(?!.*[\\\u0000])(?!.*(?:^|\/)\.\.?(?:\/|$))[^/]+(?:\/[^/]+)*$/),
  ),
);
const hashRecord = Schema.Record(Schema.String, hash).pipe(
  Schema.check(Schema.isMinProperties(1), Schema.isPropertyNames(path)),
);
const capturedAt = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
  ),
);

export const BuildEvidence = Schema.Struct({
  version: Schema.Literal(1),
  inputs: hashRecord,
  artifacts: hashRecord,
});

export const VerificationEvidence = Schema.Struct({
  version: Schema.Literal(1),
  capturedAt,
  inputs: hashRecord,
  artifacts: hashRecord,
});

const missing = (error) => error?.code === "ENOENT" || error?.code === "ENOTDIR";
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

const canonicalRecord = (record) =>
  Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]]),
  );

const decode = (schema, value, label) => {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch (error) {
    throw new Error(`${label} is invalid: ${messageOf(error)}`, { cause: error });
  }
};

const decodeBuildEvidence = (value) => decode(BuildEvidence, value, "Build evidence");
const decodeVerificationEvidence = (value) => {
  const result = decode(VerificationEvidence, value, "Verification evidence");
  if (!Number.isFinite(Date.parse(result.capturedAt)))
    throw new Error("Verification evidence is invalid: capturedAt is not a valid ISO timestamp");
  return result;
};

const statIfPresent = async (file, allowMissing) => {
  try {
    return await stat(file);
  } catch (error) {
    if (allowMissing && missing(error)) return undefined;
    throw error;
  }
};

const walkFiles = async (directory, relativeDirectory, allowMissing, ancestors = new Set()) => {
  const directoryStat = await statIfPresent(directory, allowMissing);
  if (directoryStat === undefined) return [];
  if (!directoryStat.isDirectory()) throw new Error(`Expected a directory: ${directory}`);
  const directoryKey = await realpath(directory);
  if (ancestors.has(directoryKey))
    throw new Error(`Directory contains a symlink cycle: ${directory}`);
  const parents = new Set([...ancestors, directoryKey]);
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const files = [];
  for (const entry of entries) {
    const file = join(directory, entry.name);
    const relativeFile = `${relativeDirectory}/${entry.name}`;
    const fileStat = await statIfPresent(file, allowMissing);
    if (fileStat === undefined) continue;
    if (fileStat.isDirectory())
      files.push(...(await walkFiles(file, relativeFile, allowMissing, parents)));
    else if (fileStat.isFile()) files.push({ file, path: relativeFile });
  }
  return files;
};

const fixedFile = async (projectRoot, relativeFile, allowMissing) => {
  const file = resolve(projectRoot, relativeFile);
  const fileStat = await statIfPresent(file, allowMissing);
  if (fileStat === undefined) return [];
  if (!fileStat.isFile()) throw new Error(`Expected a file: ${file}`);
  return [{ file, path: relativeFile }];
};

const hashFiles = async (files, allowMissing) => {
  const values = [];
  for (const entry of files) {
    try {
      const contents = await readFile(entry.file);
      values.push([entry.path, createHash("sha256").update(contents).digest("hex")]);
    } catch (error) {
      if (allowMissing && missing(error)) continue;
      throw error;
    }
  }
  return canonicalRecord(Object.fromEntries(values));
};

const rootTsconfigPaths = async (projectRoot, allowMissing) => {
  try {
    const entries = await readdir(projectRoot, { withFileTypes: true });
    return entries
      .map((entry) => entry.name)
      .filter((name) => /^tsconfig.*\.json$/.test(name))
      .sort();
  } catch (error) {
    if (allowMissing && missing(error)) return [];
    throw error;
  }
};

const inputFiles = async (projectRoot, allowMissing) => {
  const files = [];
  const sourceFiles = await walkFiles(resolve(projectRoot, "src"), "src", allowMissing);
  files.push(...sourceFiles.filter((entry) => entry.path !== generatedRouteTree));

  const rootPaths = [...buildInputPaths, ...(await rootTsconfigPaths(projectRoot, allowMissing))];
  for (const relativeFile of rootPaths)
    files.push(...(await fixedFile(projectRoot, relativeFile, allowMissing)));

  for (const packageName of packageNames) {
    const packageRoot = resolve(projectRoot, "node_modules", packageName);
    files.push(
      ...(await fixedFile(projectRoot, `node_modules/${packageName}/package.json`, allowMissing)),
    );
    const libraryFiles = await walkFiles(
      join(packageRoot, "lib"),
      `node_modules/${packageName}/lib`,
      allowMissing,
    );
    files.push(...libraryFiles);
    if (!allowMissing && libraryFiles.length === 0)
      throw new Error(`Installed package has no lib files: ${packageName}`);
  }
  return files;
};

const inputRecord = async (projectRoot, allowMissing) =>
  hashFiles(await inputFiles(projectRoot, allowMissing), allowMissing);

const artifactFiles = async (projectRoot, requireRequired, allowMissing) => {
  const files = await walkFiles(resolve(projectRoot, "dist"), "dist", allowMissing);
  const artifacts = files.filter((entry) => entry.path !== buildEvidencePath);
  if (requireRequired) {
    const paths = new Set(artifacts.map((entry) => entry.path));
    const missingArtifacts = requiredArtifacts.filter((required) => !paths.has(required));
    if (missingArtifacts.length > 0)
      throw new Error(`Build artifacts are incomplete: missing ${missingArtifacts.join(", ")}`);
  }
  return artifacts;
};

const artifactRecord = async (projectRoot, requireRequired, allowMissing) =>
  hashFiles(await artifactFiles(projectRoot, requireRequired, allowMissing), allowMissing);

const verificationExtras = async (projectRoot, allowMissing) => {
  const extraFiles = [];
  for (const relativeFile of verificationInputPaths)
    extraFiles.push(...(await fixedFile(projectRoot, relativeFile, allowMissing)));
  return hashFiles(extraFiles, allowMissing);
};

export async function captureInputs(projectRoot = root) {
  const projectRootPath = resolve(projectRoot);
  const record = await inputRecord(projectRootPath, false);
  return decode(hashRecord, record, "Input hash record");
}

export async function captureArtifacts(projectRoot = root) {
  const projectRootPath = resolve(projectRoot);
  const record = await artifactRecord(projectRootPath, true, false);
  return decode(hashRecord, record, "Artifact hash record");
}

export function changedFiles(before, after) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths]
    .filter(
      (path) =>
        !Object.hasOwn(before, path) || !Object.hasOwn(after, path) || before[path] !== after[path],
    )
    .sort();
}

const loadBuildEvidence = async (projectRoot) => {
  try {
    const text = await readFile(resolve(projectRoot, buildEvidencePath), "utf8");
    return decodeBuildEvidence(JSON.parse(text));
  } catch (error) {
    const reason = missing(error) ? "missing" : `invalid or unreadable: ${messageOf(error)}`;
    throw new Error(`Build evidence at ${buildEvidencePath} is ${reason}`, {
      cause: error,
    });
  }
};

export async function writeBuildEvidence(inputsBefore, projectRoot = root) {
  const projectRootPath = resolve(projectRoot);
  const before = decode(hashRecord, inputsBefore, "Build input snapshot");
  const inputs = await inputRecord(projectRootPath, true);
  const changed = changedFiles(before, inputs);
  if (changed.length > 0)
    throw new Error(
      `Build inputs changed during the build: ${changed.join(", ")}. Run pnpm build.`,
    );
  const artifacts = await captureArtifacts(projectRootPath);
  const evidence = decodeBuildEvidence({ version: 1, inputs, artifacts });
  const file = resolve(projectRootPath, buildEvidencePath);
  await mkdir(resolve(projectRootPath, "dist"), { recursive: true });
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidence;
}

export async function assertCurrentBuild(projectRoot = root) {
  try {
    const projectRootPath = resolve(projectRoot);
    const evidence = await loadBuildEvidence(projectRootPath);
    const inputs = await inputRecord(projectRootPath, true);
    const artifacts = await artifactRecord(projectRootPath, false, true);
    const changed = [
      ...changedFiles(evidence.inputs, inputs),
      ...changedFiles(evidence.artifacts, artifacts),
    ].sort();
    if (changed.length > 0) throw new Error(`Build evidence is stale for ${changed.join(", ")}`);
    return evidence;
  } catch (error) {
    throw new Error(`${messageOf(error)}. Run pnpm build.`, { cause: error });
  }
}

export async function captureVerification(projectRoot = root) {
  const projectRootPath = resolve(projectRoot);
  const build = await assertCurrentBuild(projectRootPath);
  const extras = await verificationExtras(projectRootPath, false);
  return decodeVerificationEvidence({
    version: 1,
    capturedAt: new Date().toISOString(),
    inputs: canonicalRecord({ ...build.inputs, ...extras }),
    artifacts: build.artifacts,
  });
}

export async function compareVerification(record, projectRoot = root) {
  const saved = decodeVerificationEvidence(record);
  const projectRootPath = resolve(projectRoot);
  const inputs = {
    ...(await inputRecord(projectRootPath, true)),
    ...(await verificationExtras(projectRootPath, true)),
  };
  const artifacts = await artifactRecord(projectRootPath, false, true);
  const changed = [
    ...new Set([
      ...changedFiles(saved.inputs, inputs),
      ...changedFiles(saved.artifacts, artifacts),
    ]),
  ].sort();
  return changed.length === 0 ? { status: "current", changed: [] } : { status: "stale", changed };
}
