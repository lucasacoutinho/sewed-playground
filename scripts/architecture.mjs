import { builtinModules } from "node:module";
import { posix } from "node:path";
import { parseSync, visitorKeys } from "oxc-parser";

const hookNames = new Set(["useEffect", "useLayoutEffect"]);
const reservedGlobals = new Set([
  "process",
  "Buffer",
  "require",
  "__dirname",
  "__filename",
  "global",
]);
const sharedDomGlobals = new Set(["window", "document", "navigator"]);
const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".mts", ".cjs", ".cts"]);
const globalObjects = new Set(["globalThis", "global", "window", "self"]);
const dynamicCode = new Set(["eval", "Function"]);
const builtinNames = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const generatedRouteTree = "src/renderer/routeTree.gen.ts";

const projectPath = (file) => posix.normalize(String(file).replaceAll("\\", "/"));
export const isSourceFile = (file) => sourceExtensions.has(posix.extname(file));

const sourceLanguage = (file) => {
  const extension = posix.extname(file);
  if (extension === ".tsx") return "tsx";
  if (extension === ".jsx") return "jsx";
  if ([".ts", ".mts", ".cts"].includes(extension)) return "ts";
  return "js";
};

export const sourceCompartment = (file) => {
  if (!file.startsWith("src/")) return undefined;
  const compartment = file.split("/")[1];
  return ["main", "worker", "shared", "renderer"].includes(compartment) ? compartment : undefined;
};

const filesOf = (files) => {
  if (!(files instanceof Map)) throw new TypeError("Architecture checks require a file Map");
  return new Set([...files.keys()].map(projectPath));
};

const candidatesFor = (target) => {
  const extension = posix.extname(target);
  if (extension === ".js")
    return [target.slice(0, -3) + ".ts", target.slice(0, -3) + ".tsx", target];
  if (extension === ".jsx")
    return [target.slice(0, -4) + ".tsx", target.slice(0, -4) + ".jsx", target];
  if (extension === ".mjs" || extension === ".cjs")
    return [target.slice(0, -4) + (extension === ".mjs" ? ".mts" : ".cts"), target];
  if (extension !== "") return [target];
  return [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    `${target}.js`,
    `${target}.jsx`,
    `${target}/index.ts`,
    `${target}/index.tsx`,
    `${target}/index.js`,
    `${target}/index.jsx`,
  ];
};

const resolveRelative = (file, specifier, files) => {
  const raw = posix.normalize(posix.join(posix.dirname(file), specifier));
  const candidates = candidatesFor(raw);
  return candidates.find((candidate) => files.has(candidate));
};

const packageAllowed = (compartment, specifier) => {
  const builtin = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (builtinNames.has(builtin)) return compartment === "main" || compartment === "worker";
  const starts = (name) => specifier === name || specifier.startsWith(`${name}/`);
  if (starts("effect")) return true;
  if (specifier === "sewed") return true;
  if (compartment === "worker") return specifier === "sewed/worker";
  if (compartment === "main") return specifier === "sewed/main" || specifier === "@sewed/devtools";
  if (compartment === "renderer")
    return (
      specifier === "@sewed/react" ||
      starts("react") ||
      starts("react-dom") ||
      specifier === "@tanstack/react-router"
    );
  return false;
};

const rendererRole = (file) => {
  if (file === "src/renderer/main.tsx") return "entry";
  if (file === "src/renderer/router.ts") return "router";
  if (file === generatedRouteTree) return "route-tree";
  const [directory, feature, source] = file.slice("src/renderer/".length).split("/");
  if (directory === "features")
    return source !== undefined && /^[a-z][a-z0-9-]*$/.test(feature) ? "feature" : undefined;
  if (["app", "routes", "lib"].includes(directory) && feature !== undefined) return directory;
  return undefined;
};

const rendererDependencies = {
  entry: new Set(["router", "app", "lib"]),
  router: new Set(["route-tree", "lib"]),
  "route-tree": new Set(["routes"]),
  routes: new Set(["routes", "app", "feature", "lib"]),
  app: new Set(["app", "feature", "lib"]),
  feature: new Set(["feature", "lib"]),
  lib: new Set(["lib"]),
};

const rendererBoundary = (file, target) => {
  const sourceRole = rendererRole(file);
  const targetRole = rendererRole(target);
  if (!isSourceFile(target) && targetRole === undefined) return undefined;
  if (!rendererDependencies[sourceRole]?.has(targetRole))
    return `Renderer ${sourceRole ?? "unclassified"} code cannot import ${targetRole ?? "unclassified"} code`;
  if (
    sourceRole === "feature" &&
    targetRole === "feature" &&
    file.split("/")[3] !== target.split("/")[3]
  )
    return "A renderer feature cannot import a different feature";
  return undefined;
};

const startsBinding = (parent, key) => {
  if (parent.type === "VariableDeclarator" && key === "id") return true;
  if (
    (parent.type === "FunctionDeclaration" ||
      parent.type === "FunctionExpression" ||
      parent.type === "ArrowFunctionExpression") &&
    (key === "id" || key === "params")
  )
    return true;
  if (parent.type === "ClassDeclaration" || parent.type === "ClassExpression") return key === "id";
  if (parent.type === "CatchClause" && key === "param") return true;
  if (parent.type.startsWith("Import") && key === "local") return true;
  if (parent.type === "TSImportEqualsDeclaration" && key === "id") return true;
  return false;
};

const continuesBinding = (parent, key) => {
  if (parent.type === "AssignmentPattern") return key === "left";
  if (parent.type === "RestElement") return key === "argument";
  if (parent.type === "ArrayPattern" || parent.type === "ObjectPattern") return true;
  if (parent.type === "Property")
    return key === "value" || (key === "key" && parent.computed === false);
  if (parent.type === "TSParameterProperty") return key === "parameter";
  return false;
};

const isIdentifierReference = (parent, key, binding) => {
  if (binding) return false;
  if (parent === undefined) return false;
  if (parent.type === "MemberExpression" && key === "property" && !parent.computed) return false;
  if (
    (parent.type === "Property" ||
      parent.type === "PropertyDefinition" ||
      parent.type === "MethodDefinition" ||
      parent.type === "TSPropertySignature" ||
      parent.type === "TSMethodSignature") &&
    key === "key" &&
    !parent.computed
  )
    return parent.shorthand === true;
  if (
    (parent.type === "LabeledStatement" ||
      parent.type === "BreakStatement" ||
      parent.type === "ContinueStatement") &&
    key === "label"
  )
    return false;
  if (parent.type === "ExportSpecifier" && key === "exported") return false;
  if (parent.type === "ImportSpecifier" && key === "imported") return false;
  if (parent.type === "TSQualifiedName" && key === "right") return false;
  return true;
};

export const formatDiagnostic = (diagnostic) =>
  `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} [${diagnostic.rule}] ${diagnostic.message}`;

export const checkSource = (file, source, files = new Map([[file, source]])) => {
  const name = projectPath(file);
  const fileSet = filesOf(files);
  const diagnostics = [];
  const seen = new Set();
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1)
    if (source[index] === "\n") lineStarts.push(index + 1);
  const position = (offset) => {
    const value = Math.max(0, Math.min(offset ?? 0, source.length));
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle] <= value) low = middle;
      else high = middle;
    }
    return { line: low + 1, column: value - lineStarts[low] + 1 };
  };
  const add = (rule, message, offset = 0) => {
    const place = position(offset);
    const key = `${rule}:${offset}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push({
      file: name,
      line: place.line,
      column: place.column,
      rule,
      message,
      offset,
    });
  };
  const compartment = sourceCompartment(name);
  if (compartment === undefined)
    add(
      "source-boundary",
      "Source files must belong to src/main, src/worker, src/shared, or src/renderer",
    );
  if (compartment === "renderer" && rendererRole(name) === undefined)
    add(
      "renderer-structure",
      "Renderer code must belong to a feature, app, route, lib, or declared entry file",
    );
  if ([".cjs", ".cts"].includes(posix.extname(name)))
    add("module-syntax", "Application source uses ESM; CommonJS source files are not allowed");

  const parsed = parseSync(name, source, {
    lang: sourceLanguage(name),
    astType: "ts",
    sourceType: "module",
  });
  for (const error of parsed.errors) add("syntax", error.message, error.labels[0]?.start ?? 0);
  if (parsed.errors.length > 0)
    return diagnostics
      .sort((left, right) => left.offset - right.offset)
      .map(({ offset, ...diagnostic }) => diagnostic);

  const generated = name === generatedRouteTree;
  if (!generated)
    for (const comment of parsed.comments)
      add("comment", "Handwritten comments are not allowed in application source", comment.start);

  const checkModule = (specifier, offset) => {
    if (typeof specifier !== "string") {
      add("nonliteral-import", "Module specifiers must be string literals", offset);
      return;
    }
    if (specifier.startsWith("/")) {
      add("source-boundary", `Import path '${specifier}' is outside src`, offset);
      return;
    }
    if (!specifier.startsWith(".")) {
      if (!packageAllowed(compartment, specifier))
        add(
          "dependency",
          `Package '${specifier}' is not allowed in the ${compartment ?? "unknown"} compartment`,
          offset,
        );
      return;
    }
    const raw = posix.normalize(posix.join(posix.dirname(name), specifier));
    const target = resolveRelative(name, specifier, fileSet);
    if (target === undefined) {
      if (raw === "src" || raw.startsWith("src/"))
        add(
          "unresolved-import",
          `Relative import '${specifier}' does not resolve to a file`,
          offset,
        );
      else add("source-boundary", `Import path '${specifier}' resolves outside src`, offset);
      return;
    }
    const targetCompartment = sourceCompartment(target);
    if (targetCompartment === undefined) {
      add("source-boundary", `Import path '${specifier}' resolves outside src`, offset);
      return;
    }
    const allowedCompartments = {
      main: new Set(["main", "shared"]),
      worker: new Set(["worker", "shared"]),
      shared: new Set(["shared"]),
      renderer: new Set(["renderer", "shared"]),
    }[compartment];
    if (allowedCompartments === undefined || !allowedCompartments.has(targetCompartment)) {
      add(
        "compartment",
        `${compartment ?? "unknown"} code cannot import ${targetCompartment} code`,
        offset,
      );
      return;
    }
    if (compartment === "renderer" && targetCompartment === "renderer") {
      const violation = rendererBoundary(name, target);
      if (violation !== undefined) add("renderer-boundary", violation, offset);
    }
  };

  const checkLiteralModule = (node) => {
    if (node?.type === "Literal" && typeof node.value === "string")
      checkModule(node.value, node.start);
    else add("nonliteral-import", "Module specifiers must be string literals", node?.start ?? 0);
  };

  const forbiddenGlobal = (identifier) =>
    (compartment === "renderer" || compartment === "shared") &&
    (reservedGlobals.has(identifier) ||
      (compartment === "shared" && sharedDomGlobals.has(identifier)));

  const checkGlobal = (identifier, offset) => {
    if (dynamicCode.has(identifier))
      add("dynamic-code", "Dynamic code evaluation is not allowed in application source", offset);
    if (forbiddenGlobal(identifier))
      add(
        "reserved-global",
        `Global '${identifier}' is not allowed in ${compartment} source`,
        offset,
      );
  };

  const visit = (node, parent, key, binding = false) => {
    if (node === null || typeof node !== "object" || typeof node.type !== "string") return;
    switch (node.type) {
      case "ImportDeclaration":
        checkLiteralModule(node.source);
        break;
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        if (node.source !== null && node.source !== undefined) checkLiteralModule(node.source);
        break;
      case "ImportExpression":
        checkLiteralModule(node.source);
        break;
      case "TSImportType":
        checkLiteralModule(node.source);
        break;
      case "TSImportEqualsDeclaration":
        add(
          "module-syntax",
          "TypeScript import-equals declarations are not allowed; use an ESM import",
          node.start,
        );
        if (node.moduleReference?.type === "TSExternalModuleReference")
          checkLiteralModule(node.moduleReference.expression);
        else
          add(
            "nonliteral-import",
            "Import-equals module references must be string literals",
            node.start,
          );
        break;
      case "CallExpression":
        if (node.callee?.type === "Identifier" && node.callee.name === "require") {
          add(
            "module-syntax",
            "CommonJS require calls are not allowed; use an ESM import",
            node.start,
          );
          checkLiteralModule(node.arguments[0]);
        }
        break;
      case "MemberExpression":
        if (
          node.object?.type === "Identifier" &&
          globalObjects.has(node.object.name) &&
          !forbiddenGlobal(node.object.name)
        )
          checkGlobal(
            node.computed ? node.property.value : node.property.name,
            node.property.start,
          );
        if (
          node.object?.type === "MetaProperty" &&
          node.object.meta.name === "import" &&
          ["glob", "globEager"].includes(node.computed ? node.property.value : node.property.name)
        )
          add(
            "module-syntax",
            "Glob imports are not allowed; declare each dependency explicitly",
            node.start,
          );
        if (
          node.computed &&
          node.property?.type === "Literal" &&
          hookNames.has(node.property.value)
        )
          add(
            "effect-hook",
            `Effect hook '${node.property.value}' is not allowed`,
            node.property.start,
          );
        break;
      case "Identifier":
        if (hookNames.has(node.name))
          add("effect-hook", `Effect hook '${node.name}' is not allowed`, node.start);
        if (isIdentifierReference(parent, key, binding)) checkGlobal(node.name, node.start);
        break;
      case "TSAnyKeyword":
        if (!generated) add("any", "The any type is not allowed", node.start);
        break;
      case "TSNonNullExpression":
        if (!generated) add("non-null", "Non-null assertions are not allowed", node.start);
        break;
      case "TSTypeAssertion":
        if (!generated)
          add("assertion", "Type assertions are not allowed; use a typed boundary", node.start);
        break;
      case "TSAsExpression":
        if (
          !generated &&
          !(
            node.typeAnnotation?.type === "TSTypeReference" &&
            node.typeAnnotation.typeName?.type === "Identifier" &&
            node.typeAnnotation.typeName.name === "const"
          )
        )
          add("assertion", "Type assertions are not allowed except 'as const'", node.start);
        break;
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const child = node[key];
      const childBinding = binding ? continuesBinding(node, key) : startsBinding(node, key);
      if (Array.isArray(child)) for (const value of child) visit(value, node, key, childBinding);
      else visit(child, node, key, childBinding);
    }
  };
  visit(parsed.program);
  return diagnostics
    .sort((left, right) => left.offset - right.offset || left.rule.localeCompare(right.rule))
    .map(({ offset, ...diagnostic }) => diagnostic);
};

export const checkFiles = (sources) => {
  if (!(sources instanceof Map)) throw new TypeError("Architecture checks require a file Map");
  return [...sources.entries()]
    .filter(([file]) => isSourceFile(file))
    .flatMap(([file, source]) => checkSource(file, source, sources));
};
