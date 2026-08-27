import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isBuiltin } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isContained } from "./engineering-gate-runtime.js";
import {
  ARCHITECTURE_RULES,
  NODE_ARCHITECTURE_ANALYZER,
  NODE_ARCHITECTURE_LIMITS,
  NODE_ARCHITECTURE_PATHS,
  NODE_ARCHITECTURE_POLICY_DIGEST,
  NODE_ARCHITECTURE_PROTOCOL_VERSION,
  NODE_ARCHITECTURE_RUNTIME_MANIFEST_DIGEST,
  canonicalizeCycle,
  compareCodeUnits,
  detailKey,
  exactKeys,
  graphWithinLimits,
  safeJavaScriptPath,
  safeRelativePath,
  safeText,
  validateArchitecturePolicy,
} from "./node-architecture-contract.js";

const workerPath = fileURLToPath(import.meta.url);
const packageRootPath = path.resolve(path.dirname(workerPath), "..");
const policyPath = path.join(packageRootPath, NODE_ARCHITECTURE_PATHS.policy);
const runtimeManifestPath = path.join(packageRootPath, NODE_ARCHITECTURE_PATHS.runtimeManifest);
const runtimeRootPath = path.join(packageRootPath, NODE_ARCHITECTURE_PATHS.runtimeRoot);
const ERROR_CATEGORIES = Object.freeze(new Set([
  "input", "manifest", "policy", "runtime", "analyzer", "resource", "evidence",
]));
const DENIED_ROOT_ENTRIES = Object.freeze([
  ".dependency-cruiser.js",
  ".dependency-cruiser.cjs",
  ".dependency-cruiser.json",
  ".dependency-cruiser.yaml",
  ".dependency-cruiser.yml",
  ".dependency-cruiser.mjs",
  "dependency-cruiser.js",
  "dependency-cruiser.cjs",
  "dependency-cruiser.json",
  "dependency-cruiser.yaml",
  "dependency-cruiser.yml",
  "dependency-cruiser.mjs",
  ".dependency-cruiser-known-violations.json",
  "dependency-cruiser-known-violations.json",
]);

class ArchitectureWorkerError extends Error {
  constructor(category) {
    super(category);
    this.category = category;
  }
}

function fail(category) {
  throw new ArchitectureWorkerError(category);
}

async function phase(category, action) {
  try {
    return await action();
  } catch (error) {
    if (ERROR_CATEGORIES.has(error?.category)) throw error;
    throw new ArchitectureWorkerError(category);
  }
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function capturedIdentity(stat, realpath) {
  return {
    realpath,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: Number(stat.size),
    mtime_ns: stat.mtimeNs.toString(),
  };
}

async function captureFile(file, root, maximum = Number.MAX_SAFE_INTEGER) {
  const real = await fs.realpath(file);
  if (!isContained(root, real)) throw new Error("path containment failed");
  const stat = await fs.stat(real, { bigint: true });
  if (!stat.isFile() || stat.size > BigInt(maximum)) throw new Error("invalid file identity");
  return capturedIdentity(stat, real);
}

async function captureDirectory(directory, root) {
  const real = await fs.realpath(directory);
  if (!isContained(root, real)) throw new Error("directory containment failed");
  const stat = await fs.stat(real, { bigint: true });
  if (!stat.isDirectory()) throw new Error("invalid directory identity");
  return capturedIdentity(stat, real);
}

function sameIdentity(expected, actual) {
  return exactKeys(expected, ["realpath", "dev", "ino", "size", "mtime_ns"])
    && exactKeys(actual, ["realpath", "dev", "ino", "size", "mtime_ns"])
    && Object.keys(expected).every((key) => expected[key] === actual[key]);
}

async function readInput() {
  let source = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    source += chunk;
    if (Buffer.byteLength(source) > 96 * 1024 * 1024) throw new Error("worker input limit exceeded");
  }
  const value = JSON.parse(source);
  if (!exactKeys(value, ["protocol_version", "target_root", "production_files", "test_files", "manifest_identity"])
    || value.protocol_version !== NODE_ARCHITECTURE_PROTOCOL_VERSION || !path.isAbsolute(value.target_root)
    || !Array.isArray(value.production_files) || !Array.isArray(value.test_files)) throw new Error("invalid input protocol");
  return value;
}

function validProtocolIdentity(value, target) {
  return exactKeys(value, ["realpath", "dev", "ino", "size", "mtime_ns"])
    && path.isAbsolute(value.realpath) && isContained(target, value.realpath)
    && /^\d+$/u.test(value.dev) && /^\d+$/u.test(value.ino) && /^\d+$/u.test(value.mtime_ns)
    && Number.isSafeInteger(value.size) && value.size >= 0;
}

async function validateInputs(input) {
  const target = await fs.realpath(input.target_root);
  if (target !== input.target_root) throw new Error("target identity mismatch");
  const targetIdentity = await captureDirectory(target, target);
  const combined = [...input.production_files, ...input.test_files];
  if ([input.production_files.length > 0, combined.length <= NODE_ARCHITECTURE_LIMITS.fileCount].includes(false)) {
    throw new Error("invalid inventory size");
  }
  await validateInventoryMembers(input, combined, target);
  const productionPaths = input.production_files.map((file) => file.path);
  const testPaths = input.test_files.map((file) => file.path);
  if ([
    JSON.stringify(productionPaths) === JSON.stringify([...productionPaths].sort(compareCodeUnits)),
    JSON.stringify(testPaths) === JSON.stringify([...testPaths].sort(compareCodeUnits)),
  ].includes(false)) throw new Error("unsorted inventory");
  if (!validProtocolIdentity(input.manifest_identity, target)) throw new Error("invalid manifest identity");
  const manifest = await captureFile(path.join(target, "package.json"), target, NODE_ARCHITECTURE_LIMITS.manifestBytes);
  if (!sameIdentity(input.manifest_identity, manifest)) throw new Error("manifest identity mismatch");
  return { target, targetIdentity };
}

function validInventoryMember(file, production, target, seen) {
  return [
    exactKeys(file, ["path", "identity"]),
    safeJavaScriptPath(file?.path),
    validProtocolIdentity(file?.identity, target),
    !seen.has(file?.path),
    production === (file?.path?.startsWith("src/") || file?.path?.startsWith("bin/")),
  ].every(Boolean);
}

async function validateInventoryMembers(input, combined, target) {
  let aggregate = 0;
  const seen = new Set();
  for (const [index, file] of combined.entries()) {
    const production = index < input.production_files.length;
    if (!validInventoryMember(file, production, target, seen)) throw new Error("invalid input inventory");
    const current = await captureFile(path.join(target, file.path), target, NODE_ARCHITECTURE_LIMITS.fileBytes);
    if (!sameIdentity(file.identity, current)) throw new Error("input identity mismatch");
    if (production && path.relative(target, current.realpath).split(path.sep).join("/") !== file.path) {
      throw new Error("production identity changed rule domain");
    }
    aggregate += current.size;
    if (aggregate > NODE_ARCHITECTURE_LIMITS.aggregateBytes) throw new Error("aggregate source limit");
    seen.add(file.path);
  }
}

function validDependencyName(name) {
  return safeText(name, 214) && name !== "__proto__"
    && /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(name);
}

function validateDependencyMap(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid dependency map");
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(value, key) || !validDependencyName(key)
      || !safeText(value[key], 1024)) throw new Error("invalid dependency declaration");
  }
  return value;
}

async function readTargetManifest(target) {
  const bytes = await fs.readFile(path.join(target, "package.json"));
  if (bytes.length > NODE_ARCHITECTURE_LIMITS.manifestBytes) throw new Error("manifest size limit");
  const value = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid target manifest");
  if (Object.hasOwn(value, "dependency-cruiser") || Object.hasOwn(value, "dependencyCruiser")) {
    throw new Error("target analyzer control denied");
  }
  return {
    dependencies: validateDependencyMap(value.dependencies),
    devDependencies: validateDependencyMap(value.devDependencies),
    imports: value.imports,
  };
}

async function rejectTargetControls(target) {
  for (const entry of DENIED_ROOT_ENTRIES) {
    try {
      await fs.lstat(path.join(target, entry));
      throw new Error("target analyzer control denied");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function walkRuntime(directory, prefix = "") {
  const files = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => compareCodeUnits(a.name, b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("runtime symlink denied");
    if (entry.isDirectory()) files.push(...await walkRuntime(absolute, relative));
    else if (entry.isFile()) files.push({ relative, absolute });
    else throw new Error("runtime special file denied");
  }
  return files;
}

function validRuntimeManifest(manifest) {
  return [
    exactKeys(manifest, ["schema_version", "entry", "files"]),
    manifest?.schema_version === "1.0.0",
    manifest?.entry === NODE_ARCHITECTURE_PATHS.runtimeEntry,
    Array.isArray(manifest?.files),
  ].every(Boolean);
}

function validRuntimeDeclaration(declared, discovered, previous) {
  return [
    exactKeys(declared, ["path", "size", "sha256"]),
    safeRelativePath(declared?.path),
    declared?.path === discovered.relative,
    previous === undefined || compareCodeUnits(previous, declared?.path) < 0,
    Number.isSafeInteger(declared?.size),
    declared?.size >= 0,
    /^[a-f0-9]{64}$/u.test(declared?.sha256),
  ].every(Boolean);
}

async function verifyRuntimeMember(declared, discovered, runtimeRoot, previous) {
  if (!validRuntimeDeclaration(declared, discovered, previous)) throw new Error("invalid runtime member declaration");
  const memberIdentity = await captureFile(discovered.absolute, runtimeRoot);
  const bytes = await fs.readFile(memberIdentity.realpath);
  if ([memberIdentity.size === declared.size, digest(bytes) === `sha256:${declared.sha256}`].includes(false)) {
    throw new Error("runtime member digest mismatch");
  }
  return memberIdentity;
}

async function verifyRuntime() {
  const packageRoot = await fs.realpath(packageRootPath);
  const packageIdentity = await captureDirectory(packageRoot, packageRoot);
  const workerIdentity = await captureFile(workerPath, packageRoot);
  const { policyIdentity, policy } = await phase("policy", async () => {
    const identity = await captureFile(policyPath, packageRoot);
    const bytes = await fs.readFile(identity.realpath);
    if (digest(bytes) !== NODE_ARCHITECTURE_POLICY_DIGEST) fail("policy");
    const value = JSON.parse(bytes.toString("utf8"));
    if (!validateArchitecturePolicy(value)) fail("policy");
    return { policyIdentity: identity, policy: value };
  });
  const runtimeManifestIdentity = await captureFile(runtimeManifestPath, packageRoot);
  const runtimeIdentity = await captureDirectory(runtimeRootPath, packageRoot);
  const manifestBytes = await fs.readFile(runtimeManifestIdentity.realpath);
  if (digest(manifestBytes) !== NODE_ARCHITECTURE_RUNTIME_MANIFEST_DIGEST) fail("runtime");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (!validRuntimeManifest(manifest)) fail("runtime");
  const actual = (await walkRuntime(runtimeIdentity.realpath))
    .sort((left, right) => compareCodeUnits(left.relative, right.relative));
  if (actual.length !== manifest.files.length) fail("runtime");
  const memberIdentities = [];
  let previous;
  for (let index = 0; index < manifest.files.length; index += 1) {
    const declared = manifest.files[index];
    const discovered = actual[index];
    const memberIdentity = await verifyRuntimeMember(declared, discovered, runtimeIdentity.realpath, previous);
    memberIdentities.push([discovered.absolute, memberIdentity, declared.sha256]);
    previous = declared.path;
  }
  if (!manifest.files.some((file) => file.path === manifest.entry)) fail("runtime");
  const entryPath = path.join(runtimeIdentity.realpath, manifest.entry);
  const analyzerManifest = JSON.parse(await fs.readFile(path.join(
    runtimeIdentity.realpath,
    "node_modules/dependency-cruiser/package.json",
  ), "utf8"));
  if ([
    analyzerManifest.name === NODE_ARCHITECTURE_ANALYZER.id,
    analyzerManifest.version === NODE_ARCHITECTURE_ANALYZER.version,
  ].includes(false)) fail("runtime");
  return {
    packageRoot,
    packageIdentity,
    workerIdentity,
    policyIdentity,
    runtimeManifestIdentity,
    runtimeIdentity,
    memberIdentities,
    policy,
    entryPath,
  };
}

async function localPath(target, candidate) {
  if (!safeText(candidate) || candidate.includes("\\")) throw new Error("unsafe analyzer path");
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(target, candidate);
  const captured = await captureFile(absolute, target);
  const relative = path.relative(target, captured.realpath).split(path.sep).join("/");
  if (!safeRelativePath(relative)) throw new Error("invalid analyzer local path");
  return relative;
}

function graphPathKind(value, candidate) {
  if (!safeText(candidate) || candidate.includes("\\")) throw new Error("invalid graph path");
  if (["coreModule", "couldNotResolve"].some((key) => Object.hasOwn(value, key) && typeof value[key] !== "boolean")) {
    throw new Error("invalid graph flags");
  }
  if (value.coreModule === true) {
    if (value.couldNotResolve === true || !isBuiltin(candidate) && !isBuiltin(`node:${candidate}`)) {
      throw new Error("invalid builtin graph node");
    }
    return "builtin";
  }
  return value.couldNotResolve === true ? "unresolved" : "file";
}

function validGraphEdge(edge) {
  return edge && typeof edge === "object" && !Array.isArray(edge)
    && safeText(edge.module) && typeof edge.coreModule === "boolean"
    && typeof edge.couldNotResolve === "boolean" && Array.isArray(edge.dependencyTypes)
    && edge.dependencyTypes.every((type) => safeText(type));
}

function repeatedGraphLeaf(previous, current, context) {
  return !context.production.has(current.source) && previous.kind === current.kind && previous.source === current.source
    && previous.dependencies.length === 0 && current.dependencies.length === 0;
}

async function validateGraphModules(modules, context) {
  const graph = new Map();
  const physical = new Set();
  for (const module of modules) {
    const kind = graphPathKind(module, module.source);
    const source = kind === "file" ? await localPath(context.target, module.source) : module.source;
    const previous = graph.get(module.source);
    if (previous) {
      if (!repeatedGraphLeaf(previous, { kind, source, dependencies: module.dependencies }, context)) {
        throw new Error("ambiguous graph module");
      }
      continue;
    }
    if (kind === "file") {
      if (physical.has(source)) throw new Error("ambiguous physical graph module");
      physical.add(source);
    } else if (module.dependencies.length !== 0) throw new Error("invalid virtual graph module");
    graph.set(module.source, { kind, source, dependencies: module.dependencies });
  }
  for (const source of context.production) {
    const module = graph.get(source);
    if (module?.kind !== "file" || module.source !== source) throw new Error("incomplete production graph");
  }
  return graph;
}

async function validateGraphEdges(graph, context) {
  for (const module of graph.values()) {
    for (const edge of module.dependencies) {
      if (!validGraphEdge(edge)) throw new Error("invalid graph edge");
      const kind = graphPathKind(edge, edge.resolved);
      const targetModule = graph.get(edge.resolved);
      if (targetModule?.kind !== kind) throw new Error("incomplete dependency graph");
      if (kind === "file" && await localPath(context.target, edge.resolved) !== targetModule.source) {
        throw new Error("inconsistent dependency graph");
      }
    }
  }
}

async function captureImportScope(directory, state) {
  if (directory === state.target) return undefined;
  if (state.scopes.has(directory)) return state.scopes.get(directory);
  state.directories.set(directory, await captureDirectory(directory, state.target));
  const manifestPath = path.join(directory, "package.json");
  let scope;
  try {
    scope = { path: manifestPath, identity: await captureFile(manifestPath, state.target, NODE_ARCHITECTURE_LIMITS.manifestBytes) };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    scope = await captureImportScope(path.dirname(directory), state);
  }
  state.scopes.set(directory, scope);
  return scope;
}

async function captureImportScopes(input, target) {
  const state = { target, scopes: new Map(), directories: new Map() };
  for (const file of input.production_files) await captureImportScope(path.dirname(path.join(target, file.path)), state);
  return state;
}

async function revalidateImportScopes(state) {
  for (const [directory, identity] of state.directories) {
    if (!sameIdentity(identity, await captureDirectory(directory, state.target))) fail("input");
  }
  for (const scope of new Set(state.scopes.values())) {
    if (scope && !sameIdentity(scope.identity, await captureFile(scope.path, state.target))) fail("input");
  }
}

async function sourceImports(source, context) {
  const directory = path.dirname(path.join(context.target, source));
  const scope = context.importScopes.scopes.get(directory);
  if (!scope) return context.targetManifest.imports;
  if (!sameIdentity(scope.identity, await captureFile(scope.path, context.target))) fail("input");
  const value = JSON.parse(await fs.readFile(scope.identity.realpath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid alias scope");
  return value.imports;
}

function aliasTargets(imports, specifier) {
  if (!imports || typeof imports !== "object" || Array.isArray(imports)) throw new Error("missing alias provenance");
  if (Object.hasOwn(imports, specifier)) return [imports[specifier]];
  const matches = Object.keys(imports).filter((key) => {
    const parts = key.split("*");
    return parts.length === 2 && specifier.startsWith(parts[0]) && specifier.endsWith(parts[1]);
  });
  return matches.map((key) => imports[key]);
}

function unambiguousAliasPackage(targets) {
  const pending = [...targets];
  const names = new Set();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") names.add(packageName(value));
    else if (value && typeof value === "object") pending.push(...Object.values(value));
    else throw new Error("ambiguous alias target");
  }
  if (names.size !== 1) throw new Error("ambiguous alias package");
  return [...names][0];
}

async function npmEdgePackage(edge, context, source) {
  if (!edge.dependencyTypes.some((type) => /^npm(?:-|$)/u.test(type))) return undefined;
  if (!edge.module.startsWith("#")) return packageName(edge.module);
  const resolved = context.graph.get(edge.resolved);
  if (resolved?.kind !== "file") throw new Error("invalid resolved package alias");
  // The declaration retains the npm key across nested subpaths and physical symlinks.
  return unambiguousAliasPackage(aliasTargets(await sourceImports(source, context), edge.module));
}

function isDevelopmentOnly(name, manifest) {
  return Object.hasOwn(manifest.devDependencies, name) && !Object.hasOwn(manifest.dependencies, name);
}

async function collectDevelopmentPackages(graph, context, details) {
  for (const source of context.production) {
    for (const edge of graph.get(source).dependencies) {
      const name = await npmEdgePackage(edge, context, source);
      if (name && isDevelopmentOnly(name, context.targetManifest)) {
        const detail = { kind: "package", source, package: name };
        details.set(detailKey(detail), detail);
      }
    }
  }
}

function packageName(specifier) {
  if (!safeText(specifier, 1024)) throw new Error("invalid package specifier");
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (!validDependencyName(name)) throw new Error("invalid package name");
  return name;
}

function validateDirectedCycle(members, target, context) {
  if (new Set(members).size !== members.length || !members.includes(context.source)
    || members[(members.indexOf(context.source) + 1) % members.length] !== target) {
    throw new Error("inconsistent directed cycle");
  }
  for (const [index, member] of members.entries()) {
    const next = members[(index + 1) % members.length];
    if (!context.graph.get(member)?.dependencies.some((edge) => context.graph.get(edge.resolved)?.source === next)) {
      throw new Error("cycle edge outside graph");
    }
  }
}

function productionCycle(source, target, context) {
  if (!context.production.has(target)) return undefined;
  // A native witness may detour outside production. Find one return path, never enumerate cycles.
  const queue = [target];
  const previous = new Map([[target, undefined]]);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === source) {
      const backwards = [];
      for (let member = source; member !== undefined; member = previous.get(member)) backwards.push(member);
      return [source, ...backwards.reverse().slice(0, -1)];
    }
    const targets = context.graph.get(current).dependencies
      .map((edge) => context.graph.get(edge.resolved).source)
      .filter((member) => context.production.has(member)).sort(compareCodeUnits);
    for (const member of targets) {
      if (previous.has(member)) continue;
      previous.set(member, current);
      queue.push(member);
    }
  }
  return undefined;
}

async function cycleDetail(violation, context) {
  if (violation.cycle !== undefined && !Array.isArray(violation.cycle)) throw new Error("invalid cycle declaration");
  const reportedCycle = (violation.cycle ?? []).map((member) => member?.name);
  const raw = reportedCycle.length > 0 ? reportedCycle : [context.source, violation.to];
  const normalized = [];
  for (const member of raw) {
    const local = await localPath(context.target, member);
    if (context.graph.get(member)?.source !== local) throw new Error("cycle member outside graph");
    normalized.push(local);
  }
  if (normalized.length > 1 && normalized.at(-1) === normalized[0]) normalized.pop();
  const target = await localPath(context.target, violation.to);
  validateDirectedCycle(normalized, target, context);
  const members = normalized.every((member) => context.production.has(member))
    ? normalized : productionCycle(context.source, target, context);
  return members ? { kind: "cycle", members: canonicalizeCycle(members) } : undefined;
}

async function productionTestDetail(violation, context) {
  const targetPath = await localPath(context.target, violation.to);
  if ([context.tests.has(targetPath), targetPath.startsWith("test/")].includes(false)) {
    throw new Error("test edge outside inventory");
  }
  return { kind: "edge", source: context.source, target: targetPath };
}

async function sourceBinDetail(violation, context) {
  const targetPath = await localPath(context.target, violation.to);
  if ([
    context.source.startsWith("src/"),
    context.production.has(targetPath),
    targetPath.startsWith("bin/"),
  ].includes(false)) throw new Error("bin edge outside inventory");
  return { kind: "edge", source: context.source, target: targetPath };
}

function unresolvedDetail(violation, context) {
  const specifier = violation.unresolvedTo ?? violation.to;
  if (!safeText(specifier, 1024)) throw new Error("invalid unresolved specifier");
  return { kind: "unresolved", source: context.source, specifier };
}

async function developmentPackageDetail(violation, context) {
  const edges = context.graph.get(context.source).dependencies.filter((edge) => edge.resolved === violation.to
    && (violation.unresolvedTo === undefined || edge.module === violation.unresolvedTo));
  const names = new Set(await Promise.all(edges.map((edge) => npmEdgePackage(edge, context, context.source))));
  if (names.size !== 1 || names.has(undefined) || !edges.every((edge) => edge.dependencyTypes.includes("npm-dev"))) {
    throw new Error("ambiguous development dependency violation");
  }
  const name = [...names][0];
  return isDevelopmentOnly(name, context.targetManifest)
    ? { kind: "package", source: context.source, package: name }
    : undefined;
}

async function normalizeViolation(violation, context) {
  const name = violation?.rule?.name;
  const rule = ARCHITECTURE_RULES.find((candidate) => candidate.check_id === name);
  if (!rule || violation.rule.severity !== "error") throw new Error("unexpected analyzer violation");
  const source = await localPath(context.target, violation.from);
  if (!context.production.has(source)) throw new Error("violation source outside inventory");
  const detailContext = { ...context, source };
  const normalizers = {
    "ARCH-NO-CYCLES-001": cycleDetail,
    "ARCH-PROD-NO-TEST-001": productionTestDetail,
    "ARCH-SRC-NO-BIN-001": sourceBinDetail,
    "ARCH-IMPORT-RESOLUTION-001": unresolvedDetail,
    "ARCH-PROD-NO-DEV-DEPS-001": developmentPackageDetail,
  };
  return { rule, detail: await normalizers[rule.rule_id](violation, detailContext) };
}

async function normalizeViolations(result, input, target, targetManifest, importScopes) {
  if ([
    Boolean(result && typeof result === "object"),
    Array.isArray(result?.modules),
    Boolean(result?.summary),
    Array.isArray(result?.summary?.violations),
  ].includes(false)) throw new Error("malformed analyzer result");
  const moduleCount = result.modules.length;
  const edgeCount = result.modules.reduce((total, module) => {
    if (!module || typeof module !== "object" || !Array.isArray(module.dependencies)) throw new Error("malformed module graph");
    return total + module.dependencies.length;
  }, 0);
  if (!graphWithinLimits(moduleCount, edgeCount)) fail("resource");
  const production = new Set(input.production_files.map((file) => file.path));
  const tests = new Set(input.test_files.map((file) => file.path));
  const context = { target, targetManifest, production, tests, importScopes };
  context.graph = await validateGraphModules(result.modules, context);
  await validateGraphEdges(context.graph, context);
  const details = new Map(ARCHITECTURE_RULES.map((rule) => [rule.check_id, new Map()]));
  await collectDevelopmentPackages(context.graph, context, details.get("production_must_not_import_dev_dependencies"));
  for (const violation of result.summary.violations) {
    const { rule, detail } = await normalizeViolation(violation, context);
    if (detail) details.get(rule.check_id).set(detailKey(detail), detail);
  }
  return {
    graph: { module_count: moduleCount, edge_count: edgeCount },
    rules: ARCHITECTURE_RULES.map((rule) => {
      const ordered = [...details.get(rule.check_id)].sort(([left], [right]) => compareCodeUnits(left, right));
      return {
        check_id: rule.check_id,
        rule_id: rule.rule_id,
        total: ordered.length,
        details: ordered.slice(0, NODE_ARCHITECTURE_LIMITS.detailCount).map(([, detail]) => detail),
      };
    }),
  };
}

async function revalidate(input, targetState, runtimeState) {
  await phase("input", async () => {
    if (!sameIdentity(targetState.targetIdentity, await captureDirectory(targetState.target, targetState.target))) fail("input");
    for (const file of [...input.production_files, ...input.test_files]) {
      if (!sameIdentity(file.identity, await captureFile(path.join(targetState.target, file.path), targetState.target))) {
        fail("input");
      }
    }
    if (!sameIdentity(input.manifest_identity, await captureFile(path.join(targetState.target, "package.json"), targetState.target))) {
      fail("input");
    }
  });
  await phase("runtime", async () => {
    if (!sameIdentity(runtimeState.packageIdentity, await captureDirectory(runtimeState.packageRoot, runtimeState.packageRoot))
      || !sameIdentity(runtimeState.workerIdentity, await captureFile(workerPath, runtimeState.packageRoot))
      || !sameIdentity(runtimeState.policyIdentity, await captureFile(policyPath, runtimeState.packageRoot))
      || !sameIdentity(runtimeState.runtimeManifestIdentity, await captureFile(runtimeManifestPath, runtimeState.packageRoot))
      || !sameIdentity(runtimeState.runtimeIdentity, await captureDirectory(runtimeRootPath, runtimeState.packageRoot))) fail("runtime");
    for (const [file, expected, expectedDigest] of runtimeState.memberIdentities) {
      const current = await captureFile(file, runtimeState.runtimeIdentity.realpath);
      if (!sameIdentity(expected, current) || digest(await fs.readFile(current.realpath)) !== `sha256:${expectedDigest}`) {
        fail("runtime");
      }
    }
  });
}

async function analyze() {
  const input = await phase("input", readInput);
  const targetState = await phase("input", () => validateInputs(input));
  const targetManifest = await phase("manifest", async () => {
    await rejectTargetControls(targetState.target);
    return readTargetManifest(targetState.target);
  });
  const importScopes = await phase("input", () => captureImportScopes(input, targetState.target));
  const runtimeState = await phase("runtime", verifyRuntime);
  const output = await phase("analyzer", async () => {
    const analyzer = await import(pathToFileURL(runtimeState.entryPath).href);
    if (typeof analyzer.cruise !== "function") fail("analyzer");
    const result = await analyzer.cruise(
      input.production_files.map((file) => file.identity.realpath),
      {
        ruleSet: runtimeState.policy,
        validate: true,
        outputType: "json",
        doNotFollow: { path: "(^|/)node_modules(/|$)" },
      },
    );
    if (!exactKeys(result, ["output", "exitCode"]) || result.exitCode !== 0 || typeof result.output !== "string") {
      fail("analyzer");
    }
    return result.output;
  });
  const normalized = await phase("evidence", () => normalizeViolations(
    JSON.parse(output), input, targetState.target, targetManifest, importScopes,
  ));
  await phase("input", () => revalidateImportScopes(importScopes));
  await revalidate(input, targetState, runtimeState);
  return {
    protocol_version: NODE_ARCHITECTURE_PROTOCOL_VERSION,
    analyzer: NODE_ARCHITECTURE_ANALYZER,
    policy_digest: NODE_ARCHITECTURE_POLICY_DIGEST,
    files: input.production_files.map((file) => file.path),
    graph: normalized.graph,
    rules: normalized.rules,
  };
}

try {
  process.stdout.write(`${JSON.stringify(await analyze())}\n`);
} catch (error) {
  const errorCategory = ERROR_CATEGORIES.has(error?.category) ? error.category : "evidence";
  process.stdout.write(`${JSON.stringify({
    protocol_version: NODE_ARCHITECTURE_PROTOCOL_VERSION,
    error_category: errorCategory,
  })}\n`);
  process.exitCode = 2;
}
