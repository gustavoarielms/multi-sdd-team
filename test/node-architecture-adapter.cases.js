import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "./classified-test.js";

import { runBoundedCommand } from "../src/engineering-gate-runtime.js";
import { NODE_ARCHITECTURE_ADAPTER_TRUST } from "../src/governance-trust.js";
import { validateArchitectureAdapterTrust } from "../src/governance-validator.js";
import {
  ARCHITECTURE_RULES,
  canonicalizeCycle,
  runNodeArchitecture,
  validateArchitecturePolicy,
} from "../src/node-architecture-adapter.js";
import {
  NODE_ARCHITECTURE_LIMITS,
  compareCodeUnits,
  detailKey,
  graphWithinLimits,
} from "../src/node-architecture-contract.js";
import { runtimeResolutionGraph } from "../src/node-architecture-runtime-topology.js";

const limits = Object.freeze({ timeoutMs: 120000, maxOutputBytes: 262144 });
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

async function repository(t, files) {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "node-architecture-test-"));
  t.after(() => fs.rm(target, { recursive: true, force: true }));
  for (const [relative, source] of Object.entries(files)) {
    const absolute = path.join(target, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, source);
  }
  for (const args of [
    ["init"],
    ["config", "user.name", "Architecture Test"],
    ["config", "user.email", "architecture@example.invalid"],
    ["add", "--", ...Object.keys(files)],
  ]) {
    const result = spawnSync("git", ["-C", target, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return target;
}

async function installAnalyzerFixture(copyRoot, analyzerSource) {
  const runtimeRoot = path.join(copyRoot, NODE_ARCHITECTURE_ADAPTER_TRUST.runtime_root_path);
  const entry = path.join(runtimeRoot, NODE_ARCHITECTURE_ADAPTER_TRUST.runtime_entry);
  const manifestPath = path.join(copyRoot, NODE_ARCHITECTURE_ADAPTER_TRUST.runtime_manifest_path);
  await fs.writeFile(entry, analyzerSource);
  const entryBytes = await fs.readFile(entry);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const declaration = manifest.files.find((file) => file.path === NODE_ARCHITECTURE_ADAPTER_TRUST.runtime_entry);
  declaration.size = entryBytes.length;
  declaration.sha256 = createHash("sha256").update(entryBytes).digest("hex");
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(manifestPath, manifestBytes);
  const digest = createHash("sha256").update(manifestBytes).digest("hex");
  const trustPath = path.join(copyRoot, "src/governance-trust.js");
  const trust = await fs.readFile(trustPath, "utf8");
  await fs.writeFile(trustPath, trust.replace(
    /runtime_manifest_digest: "sha256:[a-f0-9]{64}"/u,
    `runtime_manifest_digest: "sha256:${digest}"`,
  ));
}

function assertSafeArchitectureError(result, reasonCode) {
  assert.equal(result.status, "error");
  assert.equal(result.reason_code, reasonCode);
  assert.deepEqual(Object.keys(result).sort(compareCodeUnits), ["reason_code", "status", "summary"]);
  assert.equal(result.summary, "The package-owned architecture analyzer could not produce trustworthy bounded evidence.");
}

test("the architecture policy and cycle normalization are exact and deterministic", async () => {
  const policy = JSON.parse(await fs.readFile(
    new URL("../governance/adapters/v1/node-dependency-cruiser.json", import.meta.url),
    "utf8",
  ));
  assert.equal(validateArchitecturePolicy(policy), true);
  assert.equal(ARCHITECTURE_RULES.length, 5);
  assert.deepEqual(canonicalizeCycle(["src/z.js", "src/a.js", "src/m.js"]), [
    "src/a.js", "src/m.js", "src/z.js",
  ]);
  assert.deepEqual(canonicalizeCycle(["src/m.js", "src/z.js", "src/a.js"]), [
    "src/a.js", "src/m.js", "src/z.js",
  ]);
  assert.deepEqual(canonicalizeCycle(["src/z.js", "src/a.js", "src/z.js"]), [
    "src/a.js", "src/z.js",
  ]);
  assert.deepEqual(canonicalizeCycle(["src/self.js"]), ["src/self.js"]);
  assert.deepEqual(canonicalizeCycle(["src/self.js", "src/self.js"]), ["src/self.js"]);
  for (const invalid of [[], ["src/a.js", "src/a.js", "src/a.js"], ["README.md", "src/a.js"]]) {
    assert.throws(() => canonicalizeCycle(invalid), /invalid directed cycle/u);
  }
  assert.equal(detailKey({ kind: "cycle", members: ["src/a.js", "src/b.js"] }), "src/a.js\0src/b.js");
  assert.equal(detailKey({ kind: "edge", source: "src/a.js", target: "test/a.js" }), "src/a.js\0test/a.js");
  assert.equal(detailKey({ kind: "unresolved", source: "src/a.js", specifier: "./missing.js" }), "src/a.js\0./missing.js");
  assert.equal(detailKey({ kind: "package", source: "src/a.js", package: "example" }), "src/a.js\0example");
  assert.throws(() => detailKey({ kind: "other" }), /invalid architecture detail/u);
  const weakened = structuredClone(policy);
  weakened.forbidden[0].to.circular = false;
  assert.equal(validateArchitecturePolicy(weakened), false);
  assert.deepEqual(["src/ä.js", "src/z.js", "src/a.js"].sort(compareCodeUnits), [
    "src/a.js", "src/z.js", "src/ä.js",
  ]);
  assert.deepEqual(canonicalizeCycle(["src/ä.js", "src/z.js", "src/a.js"]), [
    "src/a.js", "src/ä.js", "src/z.js",
  ]);
  assert.equal(graphWithinLimits(20000, 100000), true);
  assert.equal(graphWithinLimits(20001, 100000), false);
  assert.equal(graphWithinLimits(20000, 100001), false);

  assert.equal((await validateArchitectureAdapterTrust()).ok, true);
  for (const field of Object.keys(NODE_ARCHITECTURE_ADAPTER_TRUST)) {
    assert.equal((await validateArchitectureAdapterTrust({
      ...NODE_ARCHITECTURE_ADAPTER_TRUST,
      [field]: `${NODE_ARCHITECTURE_ADAPTER_TRUST[field]}-drift`,
    })).ok, false, field);
  }

  const installedGraph = await runtimeResolutionGraph(packageRoot);
  const vendoredGraph = await runtimeResolutionGraph(path.join(packageRoot, "vendor/node-architecture-runtime"));
  assert.deepEqual(vendoredGraph, installedGraph);
  const cruiser = installedGraph.find((item) => item.path === "node_modules/dependency-cruiser");
  const ignore = cruiser.dependencies.find((item) => item.name === "ignore");
  assert.equal(ignore.path, "node_modules/dependency-cruiser/node_modules/ignore");
  assert.equal(ignore.version, "7.0.6");
});

test("the real analyzer passes a contained acyclic production graph", async (t) => {
  const target = await repository(t, {
    "package.json": "{\"type\":\"module\",\"dependencies\":{},\"devDependencies\":{}}\n",
    "src/value.js": "export const value = 1;\n",
    "src/index.js": "import { value } from './value.js'; export { value };\n",
  });
  const result = await runNodeArchitecture({ target, limits });
  assert.equal(result.status, "pass");
  assert.deepEqual(result.checks.map((check) => check.rule_id), ARCHITECTURE_RULES.map((rule) => rule.rule_id));
});

test("the real analyzer rejects every resolved filesystem escape", async (t) => {
  const outside = await repository(t, { "outside.js": "export default 1;\n" });
  const target = await repository(t, {
    "package.json": '{"type":"module"}\n',
    "src/index.js": "export default 1;\n",
  });
  const external = path.join(outside, "outside.js");
  await fs.symlink(external, path.join(target, "src/linked.js"));
  const imports = [path.relative(path.join(target, "src"), external), "./linked.js"];
  const outcomes = [];
  for (const specifier of imports) {
    await fs.writeFile(path.join(target, "src/index.js"), `import ${JSON.stringify(specifier)};\n`);
    outcomes.push(await runNodeArchitecture({ target, limits }));
  }
  for (const outcome of outcomes) assertSafeArchitectureError(outcome, "NODE_ARCHITECTURE_EVIDENCE_INVALID");
});

test("production aliases are rejected by both adapter and worker", async (t) => {
  const target = await repository(t, {
    "package.json": '{"type":"module"}\n',
    "src/index.js": "export default 1;\n",
    "entry.js": "import './test/helper.js';\n",
    "test/helper.js": "export default 1;\n",
  });
  let input;
  await runNodeArchitecture({ target, limits }, {
    runCommand: async (_executable, _args, options) => {
      input = JSON.parse(options.input);
      return { status: "error", reason_code: "COMMAND_FAILED" };
    },
  });
  await fs.rm(path.join(target, "src/index.js"));
  await fs.symlink("../entry.js", path.join(target, "src/index.js"));
  const real = await fs.realpath(path.join(target, "src/index.js"));
  const stat = await fs.stat(real, { bigint: true });
  input.production_files[0].identity = {
    realpath: real, dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtime_ns: String(stat.mtimeNs),
  };
  const worker = spawnSync(process.execPath, [path.join(packageRoot, "src/node-architecture-worker.js")], {
    cwd: target, input: JSON.stringify(input), encoding: "utf8", env: {},
  });
  const adapter = await runNodeArchitecture({ target, limits });
  assert.deepEqual({ exit: worker.status, report: JSON.parse(worker.stdout) }, {
    exit: 2, report: { protocol_version: "1.0.0", error_category: "input" },
  });
  assertSafeArchitectureError(adapter, "NODE_ARCHITECTURE_INPUT_INVALID");
});

test("root dependency declarations govern every production package edge", async (t) => {
  const target = await repository(t, {
    "package.json": '{"type":"module","devDependencies":{"left-pad":"1.3.0"}}\n',
    "src/package.json": '{"type":"module","dependencies":{"left-pad":"1.3.0"}}\n',
    "src/index.js": "import 'left-pad'; import 'left-pad/index.js'; import 'node:fs'; import './data.json' with { type: 'json' }; import '../helper.js';\n",
    "src/data.json": '{}\n',
    "helper.js": "export default 1;\n",
    "node_modules/left-pad/package.json": '{"name":"left-pad","version":"1.3.0","main":"index.js"}\n',
    "node_modules/left-pad/index.js": "module.exports = value => value;\n",
  });
  const nested = await runNodeArchitecture({ target, limits });
  await fs.rm(path.join(target, "src/package.json"));
  await fs.writeFile(path.join(target, "package.json"), '{"type":"module","dependencies":{"left-pad":"1.3.0"},"devDependencies":{"left-pad":"1.3.0"}}\n');
  const overlap = await runNodeArchitecture({ target, limits });
  assert.deepEqual([nested.status, overlap.status], ["fail", "pass"]);
  assert.deepEqual(nested.checks.map((check) => check.status), ["pass", "pass", "pass", "pass", "fail"]);
  assert.equal(nested.evidence.filter((item) => item.summary === "Development-only dependency imported by src/index.js: left-pad.").length, 1);

  const aliases = await repository(t, {
    "package.json": JSON.stringify({
      type: "module", dependencies: { dep: "1.0.0", "@scope/dep": "1.0.0", renamed: "npm:original@1.0.0" },
      imports: { "#dep": "dep", "#scoped": "@scope/dep/sub.js", "#renamed": "renamed/sub.js", "#local": "./helper.js", "#builtin": "fs" },
    }),
    "src/index.js": "import '#dep'; import '#scoped'; import '#renamed'; import '#local';\n",
    "helper.js": "export default 1;\n",
    "node_modules/dep/package.json": '{"name":"dep","version":"1.0.0","main":"index.js"}\n',
    "node_modules/dep/index.js": "module.exports = 1;\n",
    "node_modules/@scope/dep/package.json": '{"name":"@scope/dep","version":"1.0.0"}\n',
    "node_modules/@scope/dep/sub.js": "module.exports = 1;\n",
    "node_modules/renamed/package.json": '{"name":"original","version":"1.0.0"}\n',
    "node_modules/renamed/sub.js": "module.exports = 1;\n",
  });
  const aliasExecution = spawnSync(process.execPath, ["src/index.js"], { cwd: aliases, encoding: "utf8" });
  assert.equal(aliasExecution.status, 0, aliasExecution.stderr);
  const aliasManifest = JSON.parse(await fs.readFile(path.join(aliases, "package.json"), "utf8"));
  const outcomes = [];
  for (const [dependencies, devDependencies] of [
    [aliasManifest.dependencies, {}],
    [{}, aliasManifest.dependencies],
    [aliasManifest.dependencies, aliasManifest.dependencies],
  ]) {
    await fs.writeFile(path.join(aliases, "package.json"), JSON.stringify({ ...aliasManifest, dependencies, devDependencies }));
    outcomes.push(await runNodeArchitecture({ target: aliases, limits }));
  }
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["pass", "fail", "pass"]);
  assert.deepEqual(outcomes[1].checks.map((check) => check.status), ["pass", "pass", "pass", "pass", "fail"]);
  for (const name of ["dep", "@scope/dep", "renamed"]) {
    assert.equal(outcomes[1].evidence.filter((item) => item.summary === `Development-only dependency imported by src/index.js: ${name}.`).length, 1);
  }
  await fs.writeFile(path.join(aliases, "src/index.js"), "import '#builtin';\n");
  assert.equal(spawnSync(process.execPath, ["src/index.js"], { cwd: aliases, encoding: "utf8" }).status, 0);
  // The pinned analyzer reports this builtin alias unresolved; preserve its normal rule failure.
  const builtinAlias = await runNodeArchitecture({ target: aliases, limits });
  assert.equal(builtinAlias.status, "fail");
  assert.deepEqual(builtinAlias.checks.map((check) => check.status), ["pass", "pass", "pass", "fail", "pass"]);
  await fs.writeFile(path.join(aliases, "src/index.js"), "import '#missing';\n");
  const unresolved = await runNodeArchitecture({ target: aliases, limits });
  assert.equal(unresolved.status, "fail");
  assert.deepEqual(unresolved.checks.map((check) => check.status), ["pass", "pass", "pass", "fail", "pass"]);

  const nestedAlias = await repository(t, {
    "package.json": '{"type":"module","devDependencies":{"dep":"1.0.0"},"imports":{"#dep":"dep/node_modules/other/index.js"}}\n',
    "src/index.js": "import 'dep/node_modules/other/index.js';\n",
    "node_modules/dep/package.json": '{"name":"dep","version":"1.0.0","main":"index.js"}\n',
    "node_modules/dep/index.js": "module.exports = 1;\n",
    "node_modules/dep/node_modules/other/package.json": '{"name":"other","version":"1.0.0","main":"index.js"}\n',
    "node_modules/dep/node_modules/other/index.js": "module.exports = 1;\n",
    "node_modules/other/package.json": '{"name":"other","version":"1.0.0","main":"index.js"}\n',
    "node_modules/other/index.js": "module.exports = 1;\n",
  });
  const attributionResults = [];
  for (const directSpecifier of ["dep/node_modules/other/index.js", "dep"]) {
    if (directSpecifier === "dep") {
      await fs.rm(path.join(nestedAlias, "node_modules/dep"), { recursive: true });
      await fs.symlink("other", path.join(nestedAlias, "node_modules/dep"));
      await fs.writeFile(path.join(nestedAlias, "package.json"), '{"type":"module","devDependencies":{"dep":"1.0.0"},"imports":{"#dep":"dep"}}\n');
    }
    for (const specifier of [directSpecifier, "#dep"]) {
      await fs.writeFile(path.join(nestedAlias, "src/index.js"), `import ${JSON.stringify(specifier)};\n`);
      const execution = spawnSync(process.execPath, ["src/index.js"], { cwd: nestedAlias, encoding: "utf8" });
      assert.equal(execution.status, 0, execution.stderr);
      attributionResults.push(await runNodeArchitecture({ target: nestedAlias, limits }));
    }
  }
  assert.deepEqual(attributionResults.map((outcome) => outcome.status), ["fail", "fail", "fail", "fail"]);
  for (const outcome of attributionResults) {
    assert.deepEqual(outcome.checks.map((check) => check.status), ["pass", "pass", "pass", "pass", "fail"]);
    assert.equal(outcome.evidence.filter((item) => item.summary === "Development-only dependency imported by src/index.js: dep.").length, 1);
  }

  const scopedAlias = await repository(t, {
    "package.json": '{"type":"module","dependencies":{"other":"1.0.0"},"devDependencies":{"dep":"1.0.0"},"imports":{"#dep":"other"}}\n',
    "src/package.json": '{"type":"module","imports":{"#dep":{"node":"dep","default":"dep/index.js"}}}\n',
    "src/nested/index.js": "import '#dep';\n",
    "node_modules/dep/package.json": '{"name":"dep","version":"1.0.0","main":"index.js"}\n',
    "node_modules/dep/index.js": "module.exports = 1;\n",
    "node_modules/other/package.json": '{"name":"other","version":"1.0.0","main":"index.js"}\n',
    "node_modules/other/index.js": "module.exports = 1;\n",
  });
  for (const imports of [
    { "#dep": { node: "dep", default: "dep/index.js" } },
    { "#*": "dep/index.js" },
    { "#dep": ["dep", "dep/index.js"] },
  ]) {
    await fs.writeFile(path.join(scopedAlias, "src/package.json"), JSON.stringify({ type: "module", imports }));
    const execution = spawnSync(process.execPath, ["src/nested/index.js"], { cwd: scopedAlias, encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
    const result = await runNodeArchitecture({ target: scopedAlias, limits });
    assert.equal(result.status, "fail");
    assert.deepEqual(result.checks.map((check) => check.status), ["pass", "pass", "pass", "pass", "fail"]);
    assert.equal(result.evidence.filter((item) => item.summary === "Development-only dependency imported by src/nested/index.js: dep.").length, 1);
  }
  for (const imports of [
    { "#dep": { node: "other", default: "dep" } },
    { "#dep": ["other", "dep"] },
    { "#d*": "other", "#*": "dep" },
    { "#dep": { browser: null, default: "other" } },
  ]) {
    await fs.writeFile(path.join(scopedAlias, "src/package.json"), JSON.stringify({ type: "module", imports }));
    const result = await runNodeArchitecture({ target: scopedAlias, limits });
    assert.equal(result.status, "error", JSON.stringify({ imports, result }));
    assertSafeArchitectureError(result, "NODE_ARCHITECTURE_EVIDENCE_INVALID");
  }
  await fs.writeFile(path.join(scopedAlias, "src/package.json"), " ".repeat(NODE_ARCHITECTURE_LIMITS.manifestBytes + 1));
  assertSafeArchitectureError(await runNodeArchitecture({ target: scopedAlias, limits }), "NODE_ARCHITECTURE_INPUT_INVALID");
  await fs.rm(path.join(scopedAlias, "src/package.json"));
  await fs.symlink(path.join(aliases, "package.json"), path.join(scopedAlias, "src/package.json"));
  assertSafeArchitectureError(await runNodeArchitecture({ target: scopedAlias, limits }), "NODE_ARCHITECTURE_INPUT_INVALID");
});

test("the real analyzer reports each approved architecture violation", async (t) => {
  const target = await repository(t, {
    "package.json": "{\"type\":\"module\",\"devDependencies\":{\"left-pad\":\"1.3.0\"}}\n",
    "src/a.js": "import './b.js'; import '../test/helper.js'; import '../bin/entry.js'; import './missing.js'; import 'left-pad';\n",
    "src/b.js": "import './a.js';\n",
    "bin/entry.js": "export const entry = 1;\n",
    "test/helper.js": "export const helper = 1;\n",
  });
  await fs.mkdir(path.join(target, "node_modules", "left-pad"), { recursive: true });
  await fs.writeFile(
    path.join(target, "node_modules", "left-pad", "package.json"),
    "{\"name\":\"left-pad\",\"version\":\"1.3.0\",\"main\":\"index.js\"}\n",
  );
  await fs.writeFile(path.join(target, "node_modules", "left-pad", "index.js"), "module.exports = value => value;\n");
  const result = await runNodeArchitecture({ target, limits });
  assert.equal(result.status, "fail");
  assert.deepEqual(result.checks.map((check) => check.status), ["fail", "fail", "fail", "fail", "fail"]);

  const selfLoop = await repository(t, {
    "package.json": "{\"type\":\"module\"}\n",
    "src/self.js": "import './self.js';\n",
  });
  const selfLoopResult = await runNodeArchitecture({ target: selfLoop, limits });
  assert.equal(selfLoopResult.status, "fail");
  assert.equal(selfLoopResult.reason_code, "NODE_ARCHITECTURE_FAILED");
  assert.deepEqual(selfLoopResult.checks.map((check) => check.rule_id), ARCHITECTURE_RULES.map((rule) => rule.rule_id));
  assert.deepEqual(selfLoopResult.checks.map((check) => check.status), ["fail", "pass", "pass", "pass", "pass"]);
  assert.equal(selfLoopResult.evidence.filter((item) => item.summary === "Directed production cycle: src/self.js -> src/self.js.").length, 1);

  const mixed = await repository(t, {
    "package.json": '{"type":"module"}\n',
    "src/index.js": "import '../test/helper.js';\n",
    "test/helper.js": "import '../src/index.js';\n",
  });
  const mixedResult = await runNodeArchitecture({ target: mixed, limits });
  assert.equal(mixedResult.status, "fail");
  assert.deepEqual(mixedResult.checks.map((check) => check.status), ["pass", "fail", "pass", "pass", "pass"]);
  await fs.writeFile(path.join(mixed, "src/index.js"), "import '../helper.js';\n");
  await fs.writeFile(path.join(mixed, "helper.js"), "import './src/index.js';\n");
  assert.equal((await runNodeArchitecture({ target: mixed, limits })).status, "pass");

  const overlapping = await repository(t, {
    "package.json": '{"type":"module"}\n',
    "src/a.js": "import './b.js'; import '../test/to-c.js';\n",
    "src/b.js": "import './c.js'; import '../test/to-a.js';\n",
    "src/c.js": "import './a.js'; import '../test/to-b.js';\n",
    "test/to-a.js": "import '../src/a.js';\n",
    "test/to-b.js": "import '../src/b.js';\n",
    "test/to-c.js": "import '../src/c.js';\n",
  });
  const overlapResult = await runNodeArchitecture({ target: overlapping, limits });
  assert.equal(overlapResult.status, "fail");
  assert.deepEqual(overlapResult.checks.map((check) => check.status), ["fail", "fail", "pass", "pass", "pass"]);
});

test("target analyzer controls and unsafe manifests fail closed", async (t) => {
  const configured = await repository(t, {
    "package.json": "{\"type\":\"module\"}\n",
    "src/index.js": "export const value = 1;\n",
  });
  const deniedNames = [
    ".dependency-cruiser.js", ".dependency-cruiser.cjs", ".dependency-cruiser.json",
    ".dependency-cruiser.yaml", ".dependency-cruiser.yml", ".dependency-cruiser.mjs",
    "dependency-cruiser.js", "dependency-cruiser.cjs", "dependency-cruiser.json",
    "dependency-cruiser.yaml", "dependency-cruiser.yml", "dependency-cruiser.mjs",
    ".dependency-cruiser-known-violations.json", "dependency-cruiser-known-violations.json",
  ];
  await fs.writeFile(path.join(configured, "dependency-cruiser.local.json"), "{}\n");
  const entryTypes = ["file", "directory", "symlink", "fifo"];
  const fifoSupported = process.platform !== "win32";
  if (!fifoSupported) t.diagnostic("FIFO denylist coverage is not portable on Windows; file, directory, and symlink remain covered.");
  for (const [index, name] of deniedNames.entries()) {
    const candidate = path.join(configured, name);
    const requestedType = entryTypes[index % entryTypes.length];
    const type = requestedType === "fifo" && !fifoSupported ? "directory" : requestedType;
    if (type === "file") await fs.writeFile(candidate, "must not execute\n");
    else if (type === "directory") await fs.mkdir(candidate);
    else if (type === "symlink") await fs.symlink("dependency-cruiser.local.json", candidate);
    else {
      const fifo = spawnSync("mkfifo", [candidate], { encoding: "utf8" });
      assert.equal(fifo.status, 0, `FIFO capability is required on ${process.platform}: ${fifo.stderr}`);
    }
    const denied = await runNodeArchitecture({ target: configured, limits });
    assert.equal(denied.reason_code, "NODE_ARCHITECTURE_MANIFEST_INVALID", `${name}:${type}`);
    assert.equal(Object.hasOwn(denied, "checks"), false);
    await fs.rm(candidate, { recursive: type === "directory" });
  }
  assert.equal((await runNodeArchitecture({ target: configured, limits })).status, "pass");

  const unsafe = await repository(t, {
    "package.json": "{\"dependencyCruiser\":{},\"dependencies\":{}}\n",
    "src/index.js": "export const value = 1;\n",
  });
  const rejected = await runNodeArchitecture({ target: unsafe, limits });
  assert.equal(rejected.reason_code, "NODE_ARCHITECTURE_MANIFEST_INVALID");
  await fs.writeFile(path.join(unsafe, "package.json"), "{\"dependency-cruiser\":{},\"dependencies\":{}}\n");
  assert.equal((await runNodeArchitecture({ target: unsafe, limits })).reason_code, "NODE_ARCHITECTURE_MANIFEST_INVALID");

  for (const manifest of [
    { dependencies: null },
    { dependencies: [] },
    { dependencies: { Invalid: "1.0.0" } },
    { dependencies: { valid: "" } },
    { dependencies: { valid: "\u0001" } },
  ]) {
    await fs.writeFile(path.join(unsafe, "package.json"), `${JSON.stringify(manifest)}\n`);
    assert.equal(
      (await runNodeArchitecture({ target: unsafe, limits })).reason_code,
      "NODE_ARCHITECTURE_MANIFEST_INVALID",
    );
  }
  await fs.writeFile(path.join(unsafe, "package.json"), "{\"dependencies\":{\"__proto__\":\"1.0.0\"}}\n");
  assert.equal((await runNodeArchitecture({ target: unsafe, limits })).reason_code, "NODE_ARCHITECTURE_MANIFEST_INVALID");
  await fs.writeFile(path.join(unsafe, "package.json"), "{\"dependencies\":{\"toString\":\"1.0.0\"}}\n");
  assert.equal((await runNodeArchitecture({ target: unsafe, limits })).reason_code, "NODE_ARCHITECTURE_MANIFEST_INVALID");
  await fs.writeFile(path.join(unsafe, "package.json"), "{\"dependencies\":{\"constructor\":\"1.0.0\"}}\n");
  assert.equal((await runNodeArchitecture({ target: unsafe, limits })).status, "pass");
});

test("the worker launch and report protocol are exact and fail closed", async (t) => {
  const target = await repository(t, {
    "package.json": "{\"type\":\"module\"}\n",
    "src/index.js": "export const value = 1;\n",
    "src/other.js": "export const other = 2;\n",
    "test/helper.js": "export const helper = 1;\n",
  });
  const result = await runNodeArchitecture({ target, limits }, {
    runCommand: async (executable, args, options) => {
      assert.equal(executable, process.execPath);
      assert.equal(args[0], "--max-old-space-size=256");
      assert.match(args[1], /node-architecture-worker\.js$/u);
      assert.deepEqual(options.env, {});
      assert.equal(options.cwd, await fs.realpath(target));
      assert.deepEqual(Object.keys(JSON.parse(options.input)).sort(), [
        "manifest_identity", "production_files", "protocol_version", "target_root", "test_files",
      ]);
      return {
        status: "completed",
        exit_code: 0,
        stdout: "{\"protocol_version\":\"1.0.0\",\"unexpected\":\"secret-value\"}\n",
        stderr: "raw-secret-value",
      };
    },
  });
  assert.equal(result.status, "error");
  assert.equal(result.reason_code, "NODE_ARCHITECTURE_PROTOCOL_INVALID");
  assert.doesNotMatch(JSON.stringify(result), /secret-value/u);

  const invalidWorkerInput = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../src/node-architecture-worker.js", import.meta.url))],
    { input: "{}\n", encoding: "utf8", env: process.env },
  );
  assert.equal(invalidWorkerInput.status, 2);
  assert.deepEqual(JSON.parse(invalidWorkerInput.stdout), {
    protocol_version: "1.0.0",
    error_category: "input",
  });

  for (const [command, expected] of [
    [{ status: "error", reason_code: "COMMAND_TIMEOUT" }, "NODE_ARCHITECTURE_TIMEOUT"],
    [{ status: "error", reason_code: "COMMAND_OUTPUT_LIMIT" }, "NODE_ARCHITECTURE_OUTPUT_LIMIT"],
    [{ status: "error", reason_code: "COMMAND_SIGNALLED" }, "NODE_ARCHITECTURE_SIGNALLED"],
    [{ status: "error", reason_code: "COMMAND_SPAWN_FAILED" }, "NODE_ARCHITECTURE_SPAWN_FAILED"],
    [{ status: "error", reason_code: "COMMAND_FAILED" }, "NODE_ARCHITECTURE_UNAVAILABLE"],
    [{ status: "completed", exit_code: 2, stdout: "{\"protocol_version\":\"1.0.0\",\"error_category\":\"input\"}", stderr: "secret" }, "NODE_ARCHITECTURE_INPUT_INVALID"],
    [{ status: "completed", exit_code: 2, stdout: "{\"protocol_version\":\"1.0.0\",\"error_category\":\"policy\"}", stderr: "secret" }, "NODE_ARCHITECTURE_POLICY_INVALID"],
    [{ status: "completed", exit_code: 2, stdout: "{\"protocol_version\":\"1.0.0\",\"error_category\":\"runtime\"}", stderr: "secret" }, "NODE_ARCHITECTURE_RUNTIME_INVALID"],
    [{ status: "completed", exit_code: 2, stdout: "{\"protocol_version\":\"1.0.0\",\"error_category\":\"manifest\"}", stderr: "secret" }, "NODE_ARCHITECTURE_MANIFEST_INVALID"],
    [{ status: "completed", exit_code: 2, stdout: "{\"protocol_version\":\"1.0.0\",\"error_category\":\"analyzer\"}", stderr: "secret" }, "NODE_ARCHITECTURE_ANALYZER_INVALID"],
    [{ status: "completed", exit_code: 2, stdout: "{\"protocol_version\":\"1.0.0\",\"error_category\":\"resource\"}", stderr: "secret" }, "NODE_ARCHITECTURE_RESOURCE_LIMIT"],
    [{ status: "completed", exit_code: 2, stdout: "{\"protocol_version\":\"1.0.0\",\"error_category\":\"evidence\"}", stderr: "secret" }, "NODE_ARCHITECTURE_EVIDENCE_INVALID"],
    [{ status: "completed", exit_code: 2, stdout: "", stderr: "secret" }, "NODE_ARCHITECTURE_PROTOCOL_INVALID"],
    [{ status: "completed", exit_code: 0, stdout: "not-json", stderr: "secret" }, "NODE_ARCHITECTURE_PROTOCOL_INVALID"],
  ]) {
    const failed = await runNodeArchitecture({ target, limits }, { runCommand: async () => command });
    assert.equal(failed.status, "error");
    assert.equal(failed.reason_code, expected);
    assert.equal(Object.hasOwn(failed, "checks"), false);
    assert.doesNotMatch(JSON.stringify(failed), /secret/u);
  }

  let validCommand;
  assert.equal((await runNodeArchitecture({ target, limits }, {
    runCommand: async (executable, args, options) => {
      validCommand = await runBoundedCommand(executable, args, options);
      return validCommand;
    },
  })).status, "pass");
  const validReport = JSON.parse(validCommand.stdout);

  const invalidGraph = structuredClone(validReport);
  invalidGraph.graph.module_count = -1;
  assert.equal((await runNodeArchitecture({ target, limits }, {
    runCommand: async () => ({ ...validCommand, stdout: JSON.stringify(invalidGraph) }),
  })).reason_code, "NODE_ARCHITECTURE_PROTOCOL_INVALID");

  const boundaryGraph = structuredClone(validReport);
  boundaryGraph.graph = { module_count: 20000, edge_count: 100000 };
  assert.notEqual((await runNodeArchitecture({ target, limits }, {
    runCommand: async () => ({ ...validCommand, stdout: JSON.stringify(boundaryGraph) }),
  })).reason_code, "NODE_ARCHITECTURE_PROTOCOL_INVALID");

  const invalidHeader = structuredClone(validReport);
  invalidHeader.unexpected = true;
  invalidHeader.analyzer = { id: "other", version: "0.0.0", unexpected: true };
  invalidHeader.policy_digest = "sha256:invalid";
  invalidHeader.graph = { module_count: 20001, edge_count: -1, unexpected: true };
  assert.equal((await runNodeArchitecture({ target, limits }, {
    runCommand: async () => ({ ...validCommand, stdout: JSON.stringify(invalidHeader) }),
  })).reason_code, "NODE_ARCHITECTURE_PROTOCOL_INVALID");

  const invalidFiles = structuredClone(validReport);
  invalidFiles.files.push("src/other.js");
  assert.equal((await runNodeArchitecture({ target, limits }, {
    runCommand: async () => ({ ...validCommand, stdout: JSON.stringify(invalidFiles) }),
  })).reason_code, "NODE_ARCHITECTURE_PROTOCOL_INVALID");

  const invalidRules = structuredClone(validReport);
  invalidRules.rules.pop();
  assert.equal((await runNodeArchitecture({ target, limits }, {
    runCommand: async () => ({ ...validCommand, stdout: JSON.stringify(invalidRules) }),
  })).reason_code, "NODE_ARCHITECTURE_PROTOCOL_INVALID");

  const invalidTotal = structuredClone(validReport);
  invalidTotal.rules[0].total = -1;
  assert.equal((await runNodeArchitecture({ target, limits }, {
    runCommand: async () => ({ ...validCommand, stdout: JSON.stringify(invalidTotal) }),
  })).reason_code, "NODE_ARCHITECTURE_PROTOCOL_INVALID");

  const invalidDetail = structuredClone(validReport);
  invalidDetail.rules[0].total = 1;
  invalidDetail.rules[0].details = [{}];
  assert.equal((await runNodeArchitecture({ target, limits }, {
    runCommand: async () => ({ ...validCommand, stdout: JSON.stringify(invalidDetail) }),
  })).reason_code, "NODE_ARCHITECTURE_PROTOCOL_INVALID");

  const invalidCycle = structuredClone(validReport);
  invalidCycle.rules[0].total = 1;
  invalidCycle.rules[0].details = [{ kind: "cycle", members: ["src/index.js", "src/index.js"] }];
  assert.equal((await runNodeArchitecture({ target, limits }, {
    runCommand: async () => ({ ...validCommand, stdout: JSON.stringify(invalidCycle) }),
  })).reason_code, "NODE_ARCHITECTURE_PROTOCOL_INVALID");

  const duplicateCycle = structuredClone(validReport);
  const cycle = { kind: "cycle", members: ["src/index.js", "src/other.js"] };
  duplicateCycle.rules[0].total = 2;
  duplicateCycle.rules[0].details = [cycle, cycle];
  assert.equal((await runNodeArchitecture({ target, limits }, {
    runCommand: async () => ({ ...validCommand, stdout: JSON.stringify(duplicateCycle) }),
  })).reason_code, "NODE_ARCHITECTURE_PROTOCOL_INVALID");

  for (const [relative, source, reason] of [
    ["src/index.js", "export const value = 2;\n", "NODE_ARCHITECTURE_INPUT_INVALID"],
    ["test/helper.js", "export const helper = 2;\n", "NODE_ARCHITECTURE_INPUT_INVALID"],
    ["package.json", "{\"type\":\"module\",\"description\":\"post-worker mutation\"}\n", "NODE_ARCHITECTURE_MANIFEST_INVALID"],
    ["post-worker-target-entry.txt", "changed target identity\n", "NODE_ARCHITECTURE_INPUT_INVALID"],
  ]) {
    const changed = await runNodeArchitecture({ target, limits }, {
      runCommand: async (executable, args, options) => {
        const completed = await runBoundedCommand(executable, args, options);
        assert.equal(completed.exit_code, 0);
        await fs.writeFile(path.join(target, relative), source);
        return completed;
      },
    });
    assertSafeArchitectureError(changed, reason);
  }
});

test("empty, oversized, and escaping production inputs are errors", async (t) => {
  const empty = await repository(t, { "package.json": "{\"type\":\"module\"}\n" });
  assertSafeArchitectureError(
    await runNodeArchitecture({ target: empty, limits }),
    "NODE_ARCHITECTURE_INPUT_INVALID",
  );

  const oversized = await repository(t, {
    "package.json": "{\"type\":\"module\"}\n",
    "src/large.js": "x".repeat(2 * 1024 * 1024 + 1),
  });
  const oversizedResult = await runNodeArchitecture({ target: oversized, limits });
  assertSafeArchitectureError(oversizedResult, "NODE_ARCHITECTURE_RESOURCE_LIMIT");

  const unsafeName = await repository(t, {
    "package.json": "{\"type\":\"module\"}\n",
    "src/control\nname.js": "export const value = 1;\n",
  });
  assertSafeArchitectureError(
    await runNodeArchitecture({ target: unsafeName, limits }),
    "NODE_ARCHITECTURE_INPUT_INVALID",
  );

  const aggregateFiles = Object.fromEntries(Array.from(
    { length: 33 },
    (_, index) => [`src/large-${String(index).padStart(2, "0")}.js`, "x".repeat(2 * 1024 * 1024)],
  ));
  const excessiveAggregate = await repository(t, {
    "package.json": "{\"type\":\"module\"}\n",
    ...aggregateFiles,
  });
  assertSafeArchitectureError(
    await runNodeArchitecture({ target: excessiveAggregate, limits }),
    "NODE_ARCHITECTURE_RESOURCE_LIMIT",
  );

  const excessiveCount = await repository(t, {
    "package.json": "{\"type\":\"module\"}\n",
    "src/c/00000.js": "",
  });
  const countRoot = path.join(excessiveCount, "src/c");
  for (let start = 1; start <= 10000; start += 1000) {
    await Promise.all(Array.from({ length: 1000 }, (_, offset) => fs.writeFile(
      path.join(countRoot, `${String(start + offset).padStart(5, "0")}.js`),
      "",
    )));
  }
  assert.equal(spawnSync("git", ["-C", excessiveCount, "add", "--", "src/c"]).status, 0);
  assertSafeArchitectureError(
    await runNodeArchitecture({ target: excessiveCount, limits }),
    "NODE_ARCHITECTURE_RESOURCE_LIMIT",
  );

  const escaping = await repository(t, {
    "package.json": "{\"type\":\"module\"}\n",
    "src/valid.js": "export const value = 1;\n",
  });
  const outside = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "architecture-outside-")), "escape.js");
  t.after(() => fs.rm(path.dirname(outside), { recursive: true, force: true }));
  await fs.writeFile(outside, "export const escaped = true;\n");
  await fs.symlink(outside, path.join(escaping, "src/escape.js"));
  assert.equal(spawnSync("git", ["-C", escaping, "add", "--", "src/escape.js"]).status, 0);
  assertSafeArchitectureError(
    await runNodeArchitecture({ target: escaping, limits }),
    "NODE_ARCHITECTURE_INPUT_INVALID",
  );

  const manifestOversized = await repository(t, {
    "package.json": JSON.stringify({ description: "x".repeat(1024 * 1024) }),
    "src/valid.js": "export const value = 1;\n",
  });
  const manifestResult = await runNodeArchitecture({ target: manifestOversized, limits });
  assertSafeArchitectureError(manifestResult, "NODE_ARCHITECTURE_MANIFEST_INVALID");

  const manifestEscaping = await repository(t, {
    "package.json": "{\"type\":\"module\"}\n",
    "src/valid.js": "export const value = 1;\n",
  });
  const outsideManifestRoot = await fs.mkdtemp(path.join(os.tmpdir(), "architecture-manifest-outside-"));
  t.after(() => fs.rm(outsideManifestRoot, { recursive: true, force: true }));
  const outsideManifest = path.join(outsideManifestRoot, "package.json");
  await fs.writeFile(outsideManifest, "{\"type\":\"module\"}\n");
  await fs.rm(path.join(manifestEscaping, "package.json"));
  await fs.symlink(outsideManifest, path.join(manifestEscaping, "package.json"));
  assertSafeArchitectureError(
    await runNodeArchitecture({ target: manifestEscaping, limits }),
    "NODE_ARCHITECTURE_MANIFEST_INVALID",
  );
});

test("architecture evidence is capped, sorted, and retains full totals", async (t) => {
  const secret = "customer-SECRET-48291-ä";
  const imports = [
    `import './${secret}.js';`,
    ...Array.from({ length: 24 }, (_, index) => `import './missing-${String(index).padStart(2, "0")}.js';`),
  ].join("\n");
  const target = await repository(t, {
    "package.json": "{\"type\":\"module\"}\n",
    "src/index.js": `${imports}\n`,
  });
  const result = await runNodeArchitecture({ target, limits });
  assert.equal(result.status, "fail");
  const check = result.checks.find((candidate) => candidate.rule_id === "ARCH-IMPORT-RESOLUTION-001");
  assert.equal(check.status, "fail");
  assert.equal(check.evidence_ids.length, 21);
  assert.match(check.summary, /25/);
  assert.doesNotMatch(JSON.stringify(result), /SECRET-48291|customer|ä/u);
});

test("package runtime assets fail closed before analyzer import", async (t) => {
  const target = await repository(t, {
    "package.json": "{\"type\":\"module\"}\n",
    "src/index.js": "export const value = 1;\n",
  });
  const copyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "architecture-package-copy-"));
  t.after(() => fs.rm(copyRoot, { recursive: true, force: true }));
  for (const directory of ["src", "governance", "vendor"]) {
    await fs.cp(path.join(packageRoot, directory), path.join(copyRoot, directory), { recursive: true });
  }
  const copied = await import(pathToFileURL(path.join(copyRoot, "src/node-architecture-adapter.js")));
  const policy = path.join(copyRoot, NODE_ARCHITECTURE_ADAPTER_TRUST.policy_path);
  const manifest = path.join(copyRoot, NODE_ARCHITECTURE_ADAPTER_TRUST.runtime_manifest_path);
  const runtimeMember = path.join(copyRoot, "vendor/node-architecture-runtime/node_modules/dependency-cruiser/package.json");
  const runtimeEntry = path.join(
    copyRoot,
    NODE_ARCHITECTURE_ADAPTER_TRUST.runtime_root_path,
    NODE_ARCHITECTURE_ADAPTER_TRUST.runtime_entry,
  );
  const sentinel = path.join(copyRoot, "untrusted-analyzer-imported");
  const policyBytes = await fs.readFile(policy);
  const manifestBytes = await fs.readFile(manifest);
  const runtimeBytes = await fs.readFile(runtimeMember);
  const runtimeEntryBytes = await fs.readFile(runtimeEntry);
  const raceMember = path.join(copyRoot, "vendor/node-architecture-runtime/licenses/inventory.json");
  const raceBytes = await fs.readFile(raceMember);

  for (const [file, bytes, expected] of [
    [policy, policyBytes, "NODE_ARCHITECTURE_POLICY_INVALID"],
    [manifest, manifestBytes, "NODE_ARCHITECTURE_RUNTIME_INVALID"],
    [runtimeMember, runtimeBytes, "NODE_ARCHITECTURE_RUNTIME_INVALID"],
  ]) {
    await fs.writeFile(file, Buffer.concat([bytes, Buffer.from("modified")]));
    assert.equal((await copied.runNodeArchitecture({ target, limits })).reason_code, expected);
    await fs.writeFile(file, bytes);
  }

  const extra = path.join(copyRoot, "vendor/node-architecture-runtime/extra.js");
  await fs.writeFile(extra, "export default true;\n");
  assert.equal((await copied.runNodeArchitecture({ target, limits })).reason_code, "NODE_ARCHITECTURE_RUNTIME_INVALID");
  await fs.rm(extra);

  await fs.rm(runtimeMember);
  assert.equal((await copied.runNodeArchitecture({ target, limits })).reason_code, "NODE_ARCHITECTURE_RUNTIME_INVALID");
  await fs.writeFile(runtimeMember, runtimeBytes);

  await fs.writeFile(runtimeEntry, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(sentinel)}, "unsafe");\n`);
  assert.equal((await copied.runNodeArchitecture({ target, limits })).reason_code, "NODE_ARCHITECTURE_RUNTIME_INVALID");
  await assert.rejects(fs.access(sentinel), { code: "ENOENT" });
  await fs.writeFile(runtimeEntry, runtimeEntryBytes);

  const timer = setInterval(async () => {
    await fs.writeFile(raceMember, Buffer.concat([raceBytes, Buffer.from("racing")])).catch(() => {});
    await fs.writeFile(raceMember, raceBytes).catch(() => {});
  }, 5);
  try {
    assert.equal((await copied.runNodeArchitecture({ target, limits })).reason_code, "NODE_ARCHITECTURE_RUNTIME_INVALID");
  } finally {
    clearInterval(timer);
    await fs.writeFile(raceMember, raceBytes);
  }

  for (const analyzerSource of [
    `export async function cruise() {
      const modules = Array.from({ length: 20001 }, () => ({ dependencies: [] }));
      return { exitCode: 0, output: JSON.stringify({ modules, summary: { violations: [] } }) };
    }\n`,
    `export async function cruise() {
      const modules = [{ dependencies: Array.from({ length: 100001 }, () => null) }];
      return { exitCode: 0, output: JSON.stringify({ modules, summary: { violations: [] } }) };
    }\n`,
  ]) {
    await installAnalyzerFixture(copyRoot, analyzerSource);
    const resource = await copied.runNodeArchitecture({ target, limits });
    assertSafeArchitectureError(resource, "NODE_ARCHITECTURE_RESOURCE_LIMIT");
    assert.doesNotMatch(JSON.stringify(resource), /20001|100001|dependencies/u);
  }

  const module = { source: "src/index.js", dependencies: [] };
  const edge = { module: "./missing.js", resolved: "missing.js", coreModule: false, couldNotResolve: false, dependencyTypes: ["local", "import"] };
  const malformedGraphs = [
    [{ ...module, coreModule: "false" }],
    [],
    [module, module],
    [{ ...module, source: "src\\index.js" }],
    [{ ...module, source: "not-present.js" }],
    [{ ...module, dependencies: [null] }],
    [{ ...module, dependencies: [edge] }],
    [{ ...module, dependencies: [{ ...edge, coreModule: true }] }],
    [{ ...module, dependencies: [{ ...edge, dependencyTypes: "npm-dev" }] }],
    [{ ...module, dependencies: [{ ...edge, couldNotResolve: "false" }] }],
    [{ ...module, dependencies: [{ ...edge, module: "#ambiguous", resolved: "src/index.js", dependencyTypes: ["npm-no-pkg"] }] }],
  ];
  for (const modules of malformedGraphs) {
    await installAnalyzerFixture(copyRoot, `export async function cruise() {
      return { exitCode: 0, output: ${JSON.stringify(JSON.stringify({ modules, summary: { violations: [] } }))} };
    }\n`);
    assertSafeArchitectureError(await copied.runNodeArchitecture({ target, limits }), "NODE_ARCHITECTURE_EVIDENCE_INVALID");
  }
  for (const initial of [undefined, '{"imports":{"#dep":"dep"}}\n']) {
    const scopePath = path.join(target, "src/package.json");
    if (initial !== undefined) await fs.writeFile(scopePath, initial);
    await installAnalyzerFixture(copyRoot, `import fs from "node:fs/promises";
      export async function cruise() {
        await fs.writeFile(${JSON.stringify(scopePath)}, '{"imports":{"#dep":"other"}}');
        return { exitCode: 0, output: ${JSON.stringify(JSON.stringify({ modules: [module], summary: { violations: [] } }))} };
      }\n`);
    assertSafeArchitectureError(await copied.runNodeArchitecture({ target, limits }), "NODE_ARCHITECTURE_INPUT_INVALID");
    await fs.rm(scopePath);
  }
  for (const violation of [
    { from: "src/index.js", to: "missing.js", rule: { name: "unknown", severity: "error" } },
    { from: "missing.js", to: "missing.js", rule: { name: "production_must_not_import_dev_dependencies", severity: "error" } },
    { from: "src/index.js", to: "missing.js", rule: { name: "production_must_not_import_dev_dependencies", severity: "error" } },
    { from: "src/index.js", to: "missing.js", rule: { name: "production_must_not_import_dev_dependencies", severity: "warning" } },
    { from: "src/index.js", to: "src/index.js", rule: { name: "no_production_cycles", severity: "error" } },
  ]) {
    await installAnalyzerFixture(copyRoot, `export async function cruise() {
      return { exitCode: 0, output: ${JSON.stringify(JSON.stringify({ modules: [module], summary: { violations: [violation] } }))} };
    }\n`);
    assertSafeArchitectureError(await copied.runNodeArchitecture({ target, limits }), "NODE_ARCHITECTURE_EVIDENCE_INVALID");
  }

  const selfEdge = { ...edge, module: "./index.js", resolved: "src/index.js" };
  for (const cycle of [
    null, {}, [{ name: "src/index.js" }, {}],
    [{ name: "src/index.js" }, { name: "missing.js" }],
    [{ name: "src/index.js" }, { name: path.join(packageRoot, "src/node-architecture-worker.js") }],
    [{ name: "src/index.js" }, { name: "src/index.js" }, { name: "src/index.js" }],
  ]) {
    const invalidCycle = {
      modules: [{ ...module, dependencies: [selfEdge] }],
      summary: { violations: [{ from: "src/index.js", to: "src/index.js", cycle, rule: { name: "no_production_cycles", severity: "error" } }] },
    };
    await installAnalyzerFixture(copyRoot, `export async function cruise() {
      return { exitCode: 0, output: ${JSON.stringify(JSON.stringify(invalidCycle))} };
    }\n`);
    assertSafeArchitectureError(await copied.runNodeArchitecture({ target, limits }), "NODE_ARCHITECTURE_EVIDENCE_INVALID");
  }

  const cycleTarget = await repository(t, {
    "package.json": '{"type":"module"}\n',
    "src/a.js": "import './b.js';\n",
    "src/b.js": "import '../helper.js'; import './a.js';\n",
    "helper.js": "import './src/a.js';\n",
  });
  const cycleGraph = {
    modules: [
      { source: "src/a.js", dependencies: [{ ...edge, module: "./b.js", resolved: "src/b.js" }] },
      { source: "src/b.js", dependencies: [{ ...edge, module: "../helper.js", resolved: "helper.js" }, { ...edge, module: "./a.js", resolved: "src/a.js" }] },
      { source: "helper.js", dependencies: [{ ...edge, module: "./src/a.js", resolved: "src/a.js" }] },
    ],
    summary: { violations: [
      ["src/a.js", "src/b.js", "helper.js"], ["src/b.js", "src/a.js"], ["src/b.js", "helper.js", "src/a.js"],
    ].map((members) => ({
      from: members[0], to: members[1], cycle: members.map((name) => ({ name })), rule: { name: "no_production_cycles", severity: "error" },
    })) },
  };
  const permuted = structuredClone(cycleGraph);
  permuted.modules.reverse();
  for (const entry of permuted.modules) entry.dependencies.reverse();
  permuted.summary.violations.reverse();
  for (const violation of permuted.summary.violations) violation.cycle.push(violation.cycle.shift());
  const reports = [];
  for (const graph of [cycleGraph, permuted]) {
    await installAnalyzerFixture(copyRoot, `export async function cruise() {
      return { exitCode: 0, output: ${JSON.stringify(JSON.stringify(graph))} };
    }\n`);
    const report = await copied.runNodeArchitecture({ target: cycleTarget, limits });
    assert.equal(report.status, "fail");
    assert.deepEqual(report.checks.map((check) => check.status), ["fail", "pass", "pass", "pass", "pass"]);
    reports.push(report.evidence.map(({ evidence_id, check_id, summary, location }) => ({ evidence_id, check_id, summary, location })));
  }
  assert.deepEqual(reports[0], reports[1]);
  assert.equal(reports[0].filter((item) => item.summary === "Directed production cycle: src/a.js -> src/b.js -> src/a.js.").length, 1);
});
