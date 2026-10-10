import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFiles, checkSource } from "./architecture.mjs";

const violations = (file, source, files = [file]) => {
  const fileMap = files instanceof Map ? new Map(files) : new Map(files.map((name) => [name, ""]));
  fileMap.set(file, source);
  return checkSource(file, source, fileMap);
};
const hasRule = (diagnostics, rule) => diagnostics.some((diagnostic) => diagnostic.rule === rule);

test("compartments reject boundary crossings through imports and reexports", () => {
  const files = [
    "src/renderer/features/alpha/view.tsx",
    "src/renderer/features/beta/view.tsx",
    "src/renderer/app/App.tsx",
    "src/renderer/routes/index.tsx",
    "src/renderer/lib/client.ts",
    "src/shared/model.ts",
    "src/main/app.ts",
  ];
  assert.ok(
    hasRule(
      violations(
        files[0],
        `export { value } from "../beta/view.js";\nexport * from "../../app/App.js";`,
        files,
      ),
      "renderer-boundary",
    ),
  );
  assert.ok(
    hasRule(
      violations(files[4], `export { value } from "../app/App.js";`, files),
      "renderer-boundary",
    ),
  );
  assert.ok(
    hasRule(
      violations("src/shared/model.ts", `import { value } from "../main/app.js";`, files),
      "compartment",
    ),
  );
  assert.ok(
    hasRule(
      violations("src/worker/compute.ts", `import { value } from "../renderer/app/App.js";`, [
        ...files,
        "src/renderer/app/App.tsx",
        "src/worker/compute.ts",
      ]),
      "compartment",
    ),
  );
});

test("renderer features and utilities cannot route dependencies through entry files", () => {
  const files = [
    "src/renderer/features/alpha/view.tsx",
    "src/renderer/lib/helper.ts",
    "src/renderer/main.tsx",
    "src/renderer/router.ts",
    "src/renderer/routeTree.gen.ts",
    "src/renderer/routes/index.tsx",
    "src/renderer/app/App.tsx",
  ];
  for (const file of files.slice(0, 2)) {
    for (const entry of ["main", "router", "routeTree.gen"]) {
      const prefix = file.includes("/features/") ? "../.." : "..";
      assert.ok(
        hasRule(
          violations(file, `export * from "${prefix}/${entry}.js";`, files),
          "renderer-boundary",
        ),
        `${file} imported ${entry}`,
      );
    }
  }
  assert.ok(
    hasRule(violations(files[6], `import "../routes/index.js";`, files), "renderer-boundary"),
  );
  assert.deepEqual(
    violations(files[2], `import "./router.js"; import "./lib/helper.js";`, files),
    [],
  );
  assert.deepEqual(violations(files[3], `import "./routeTree.gen.js";`, files), []);
  assert.deepEqual(violations(files[4], `import "./routes/index.js";`, files), []);
  assert.deepEqual(violations(files[5], `import "../app/App.js";`, files), []);
});

test("renderer code has a declared role instead of an unchecked helper directory", () => {
  for (const file of [
    "src/renderer/shortcut.ts",
    "src/renderer/helpers/shortcut.ts",
    "src/renderer/features/loose.ts",
  ]) {
    assert.ok(hasRule(violations(file, "export const value = 1;"), "renderer-structure"), file);
  }
});

test("module extensions cannot bypass architecture checks", () => {
  for (const extension of ["mts", "mjs", "cts", "cjs"]) {
    const file = `src/renderer/features/alpha/view.${extension}`;
    assert.ok(
      hasRule(checkFiles(new Map([[file, 'import "electron";']])), "dependency"),
      extension,
    );
  }
  const files = new Map([
    ["src/renderer/features/alpha/view.mts", 'export * from "../beta/view.mjs";'],
    ["src/renderer/features/beta/view.mts", "export const value = 1;"],
  ]);
  assert.ok(hasRule(checkFiles(files), "renderer-boundary"));
  assert.ok(hasRule(violations("src/main/legacy.cts", "export const value = 1;"), "module-syntax"));
});

test("global object properties and dynamic code cannot evade source rules", () => {
  const diagnostics = violations(
    "src/renderer/features/alpha/view.tsx",
    'globalThis.process; window["Buffer"]; globalThis["eval"]("work()"); new Function("work()");',
  );
  assert.equal(diagnostics.filter(({ rule }) => rule === "reserved-global").length, 2);
  assert.equal(diagnostics.filter(({ rule }) => rule === "dynamic-code").length, 2);
  assert.ok(hasRule(violations("src/shared/model.ts", "globalThis.document;"), "reserved-global"));
  assert.deepEqual(
    violations(
      "src/renderer/features/alpha/view.tsx",
      'const value = { process: "label" }; value.process;',
    ),
    [],
  );
});

test("literal dynamic dependencies are checked while nonliteral bypasses fail", () => {
  const file = "src/main/app.ts";
  const files = [file, "src/shared/model.ts"];
  const diagnostics = violations(
    file,
    `export * from "../shared/model.js";\nconst good = import("../shared/model.js");\nconst bad = import(path);\nrequire(path);\nimport fs = require("fs");\nimport value = external.value;`,
    files,
  );
  assert.ok(hasRule(diagnostics, "nonliteral-import"));
  assert.equal(diagnostics.filter(({ rule }) => rule === "nonliteral-import").length, 3);
  assert.equal(diagnostics.filter(({ rule }) => rule === "module-syntax").length, 3);
  assert.equal(hasRule(diagnostics, "compartment"), false);
  assert.equal(hasRule(diagnostics, "dependency"), false);
});

test("aliased and namespace effect hooks are detected from AST nodes", () => {
  const diagnostics = violations(
    "src/renderer/features/alpha/hooks.tsx",
    `import { useEffect as run } from "react";\nimport * as ReactAlias from "react";\nrun(() => undefined);\nReactAlias.useLayoutEffect(() => undefined);\nReactAlias["useEffect"](() => undefined);`,
  );
  assert.ok(hasRule(diagnostics, "effect-hook"));
  assert.ok(diagnostics.filter(({ rule }) => rule === "effect-hook").length >= 3);
});

test("Vite glob imports cannot bypass explicit dependency checks", () => {
  const diagnostics = violations(
    "src/renderer/app/App.tsx",
    `const modules = import.meta.glob("../../main/*.ts", { eager: true });
const computed = import.meta["glob"]("../features/*/*.tsx");
const legacy = import.meta.globEager("../features/*/*.tsx");
const hot = import.meta.hot;
const url = import.meta.url;`,
  );
  assert.equal(diagnostics.length, 3);
  assert.ok(diagnostics.every(({ rule }) => rule === "module-syntax"));
});

test("comments, any, nonnull assertions, and casts are rejected but as const is allowed", () => {
  const diagnostics = violations(
    "src/worker/compute.ts",
    `// handwritten\nconst value: any = input!;\nconst typed = input as string;\nconst literal = input as const;`,
  );
  assert.ok(hasRule(diagnostics, "comment"));
  assert.ok(hasRule(diagnostics, "any"));
  assert.ok(hasRule(diagnostics, "non-null"));
  assert.equal(diagnostics.filter(({ rule }) => rule === "assertion").length, 1);
});

test("public bindings and ordinary React pass, including hook-shaped strings", () => {
  const files = [
    "src/main/app.ts",
    "src/worker/compute.ts",
    "src/shared/model.ts",
    "src/renderer/app/App.tsx",
    "src/shared/contracts.ts",
  ];
  assert.deepEqual(
    violations(
      files[0],
      `import { Effect } from "effect";\nimport { App } from "sewed/main";\nimport { DevTools } from "@sewed/devtools";\nimport fs from "node:fs";\nconst text = "useEffect and // comments stay in strings";`,
      files,
    ),
    [],
  );
  assert.deepEqual(
    violations(
      files[1],
      `import { Effect } from "effect";\nimport * as Worker from "sewed/worker";\nimport path from "node:path";`,
      files,
    ),
    [],
  );
  assert.deepEqual(
    violations(
      files[2],
      `import { Schema } from "effect";\nimport { Binding } from "sewed";`,
      files,
    ),
    [],
  );
  assert.deepEqual(
    violations(
      files[3],
      `import { createElement } from "react";\nimport { RouterProvider } from "@tanstack/react-router";\nexport const View = () => createElement("div");`,
      files,
    ),
    [],
  );
});

test("private dependencies and paths outside src are rejected", () => {
  const diagnostics = violations(
    "src/main/app.ts",
    `import { BrowserWindow } from "electron";\nimport { secret } from "sewed/internal/secret";\nimport outside from "../../outside.js";`,
    ["src/main/app.ts"],
  );
  assert.ok(hasRule(diagnostics, "dependency"));
  assert.ok(hasRule(diagnostics, "source-boundary"));
});

test("renderer and shared source reject reserved globals without flagging property names", () => {
  const rendererDiagnostics = violations(
    "src/renderer/app/App.tsx",
    `const value = process.env.VALUE;\nconst bytes = Buffer.from("x");\nconst folder = __dirname;\nconst file = __filename;\nconst nodeGlobal = global;\nconst object = { process: "safe", Buffer: "safe" };\nobject.process;\nconst { process: local } = object;`,
  );
  assert.equal(rendererDiagnostics.filter(({ rule }) => rule === "reserved-global").length, 5);

  const sharedDiagnostics = violations(
    "src/shared/model.ts",
    `const value = window.document.title;\nconst location = navigator.userAgent;\nconst object = { window: "safe", document: "safe", navigator: "safe" };\nobject.window;`,
  );
  assert.equal(sharedDiagnostics.filter(({ rule }) => rule === "reserved-global").length, 2);

  const referenceDiagnostics = violations(
    "src/renderer/app/App.tsx",
    `const read = (value = process.env.VALUE) => value;
const object = { [process.env.KEY]: "safe" };`,
  );
  assert.equal(referenceDiagnostics.filter(({ rule }) => rule === "reserved-global").length, 2);

  assert.deepEqual(
    violations(
      "src/renderer/app/App.tsx",
      `interface Model { process: string; Buffer(): number }
class Record { process = "label"; Buffer() { return 0 } }`,
    ),
    [],
  );
});

test("type imports and node builtins obey renderer dependency boundaries", () => {
  const typeImportDiagnostics = violations(
    "src/renderer/app/App.tsx",
    `type Main = import("../../main/app.js").App;`,
    new Map([
      ["src/renderer/app/App.tsx", ""],
      ["src/main/app.ts", ""],
    ]),
  );
  assert.equal(typeImportDiagnostics.filter(({ rule }) => rule === "compartment").length, 1);

  const builtinDiagnostics = violations("src/renderer/app/App.tsx", `import fs from "node:fs";`);
  assert.equal(builtinDiagnostics.filter(({ rule }) => rule === "dependency").length, 1);
});

test("relative imports resolve against every file, including CSS assets", () => {
  const file = "src/renderer/app/App.tsx";
  const files = new Map([
    [file, ""],
    ["src/renderer/style.css", ""],
  ]);
  const diagnostics = violations(
    file,
    `import "../style.css";
import "./missing.css";`,
    files,
  );
  assert.equal(diagnostics.filter(({ rule }) => rule === "unresolved-import").length, 1);
  const feature = "src/renderer/features/alpha/view.tsx";
  assert.ok(
    hasRule(
      violations(feature, 'import "../beta/style.css";', [
        feature,
        "src/renderer/features/beta/style.css",
      ]),
      "renderer-boundary",
    ),
  );
});

test("generated route trees keep generated policy exemptions while checking imports", () => {
  const file = "src/renderer/routeTree.gen.ts";
  const diagnostics = violations(
    file,
    `// generated\nconst value: any = useEffect;\nimport { App } from "../main/app.js";`,
    [file, "src/main/app.ts"],
  );
  assert.equal(hasRule(diagnostics, "comment"), false);
  assert.equal(hasRule(diagnostics, "any"), false);
  assert.equal(hasRule(diagnostics, "effect-hook"), true);
  assert.ok(hasRule(diagnostics, "compartment"));
});
