import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFiles, formatDiagnostic, isSourceFile } from "./architecture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = resolve(root, "src");

const collect = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(file)));
    else files.push(file);
  }
  return files;
};

const files = await collect(sourceRoot);
const sources = new Map(
  await Promise.all(
    files.map(async (file) => {
      const name = relative(root, file).replaceAll("\\", "/");
      return [name, isSourceFile(file) ? await readFile(file, "utf8") : ""];
    }),
  ),
);
const diagnostics = checkFiles(sources);
if (diagnostics.length > 0) {
  for (const diagnostic of diagnostics) console.error(formatDiagnostic(diagnostic));
  process.exitCode = 1;
} else {
  console.log(`architecture check passed (${files.filter(isSourceFile).length} source files)`);
}
