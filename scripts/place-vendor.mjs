// Copies the vendored Sewed tarballs to the sibling path package.json names, for a checkout that
// has no Sewed checkout beside it (CI).
import { cpSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const specifier = { ...manifest.dependencies, ...manifest.devDependencies }.sewed;
if (typeof specifier !== "string" || !specifier.startsWith("file:"))
  throw new Error("package.json does not consume Sewed from a tarball");
const target = dirname(resolve(specifier.slice("file:".length)));
mkdirSync(target, { recursive: true });
for (const name of readdirSync("vendor/sewed")) cpSync(resolve("vendor/sewed", name), resolve(target, name));
console.log(`Placed vendored tarballs in ${target}`);
