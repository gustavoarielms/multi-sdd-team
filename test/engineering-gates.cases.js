import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { classifyTestName, UNIT_TEST_NAMES } from "./classified-test.js";
import { fileURLToPath } from "node:url";

import {
  ENGINEERING_EXECUTOR_IDS,
  runBoundedCommand,
  runEngineeringGates,
} from "../src/engineering-gates.js";
import {
  validateEngineeringGateConfiguration,
  validateEngineeringGateRun,
} from "../src/governance-validator.js";
import { runNodeLintComplexity } from "../src/node-lint-complexity-adapter.js";
import {
  COVERAGE_LIMITS,
  meetsCoverageThreshold,
  parseCoverageMapSource,
  readOwnedCoverageMap,
  runNodeCoverage,
  selectChangedCoverage,
} from "../src/node-coverage-adapter.js";
import { collectProductionChanges, parseChangedLineIntervals } from "../src/git-change-selector.js";
import nodeTestReporter from "../src/node-test-reporter.js";
import { runNodeTestSuite } from "../src/node-test-suite-adapter.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "bin", "sdd-codegraph.js");
const comparisonBases = new Map();

const validConfiguration = {
  schema_version: "1.0.0",
  quality_profile: {
    profile_id: "engineering-quality-v1",
    profile_version: "1.0.0",
    adapter_id: "node-v1",
    adapter_version: "1.0.0",
  },
  executors: [
    "javascript_syntax",
    "node_lint_complexity",
    "unit_tests",
    "integration_tests",
    "coverage",
    "governance",
    "production_dependency_audit",
    "npm_package_surface",
    "forbidden_references",
  ],
};

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "engineering-gates-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const LINUX_PROCESS_STAT_LIMIT = 4096;
const LINUX_PROCESS_STATES = new Set(["R", "S", "D", "Z", "T", "t", "X", "x", "K", "W", "P", "I"]);

function parseLinuxProcessState(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > LINUX_PROCESS_STAT_LIMIT) {
    throw new Error("invalid Linux process stat");
  }
  const commandEnd = source.lastIndexOf(") ");
  const state = source[commandEnd + 2];
  if (commandEnd < 2 || source[commandEnd + 3] !== " " || !LINUX_PROCESS_STATES.has(state)) {
    throw new Error("invalid Linux process stat");
  }
  return state;
}

async function readLinuxProcessState(pid) {
  const handle = await fs.open(`/proc/${pid}/stat`, "r");
  try {
    const buffer = Buffer.alloc(LINUX_PROCESS_STAT_LIMIT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseLinuxProcessState(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

async function processExited(pid, dependencies) {
  try {
    dependencies.probe(pid);
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
  if (dependencies.platform !== "linux") return false;
  try {
    return await dependencies.readLinuxState(pid) === "Z";
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function assertProcessExited(pid, injected = {}) {
  const timeoutMs = injected.timeoutMs ?? 1000;
  const now = injected.now ?? (() => performance.now());
  const wait = injected.wait ?? ((delay) => new Promise((resolve) => { setTimeout(resolve, delay); }));
  const dependencies = {
    platform: injected.platform ?? process.platform,
    probe: injected.probe ?? ((candidate) => process.kill(candidate, 0)),
    readLinuxState: injected.readLinuxState ?? readLinuxProcessState,
  };
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (await processExited(pid, dependencies)) return;
    await wait(Math.min(10, deadline - now()));
  }
  assert.fail(`Process ${pid} remained observable after ${timeoutMs} ms.`);
}

async function configuredTarget(t, configuration = validConfiguration) {
  const target = await temporaryDirectory(t);
  await fs.mkdir(path.join(target, ".sdd-codegraph"), { recursive: true });
  await fs.writeFile(path.join(target, ".sdd-codegraph", "gates.json"), `${JSON.stringify(configuration)}\n`);
  for (const args of [
    ["init"],
    ["config", "user.name", "Gate Test"],
    ["config", "user.email", "gate-test@example.invalid"],
    ["add", ".sdd-codegraph/gates.json"],
    ["commit", "-m", "fixture"],
  ]) {
    const execution = spawnSync("git", ["-C", target, ...args], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  }
  comparisonBases.set(
    target,
    execFileSync("git", ["-C", target, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  );
  return target;
}

function runConfiguredGates(target, options = {}) {
  return runEngineeringGates(target, {
    ...options,
    comparisonBase: options.comparisonBase ?? comparisonBases.get(target),
  });
}

function executorSet(statuses = {}) {
  return Object.fromEntries(ENGINEERING_EXECUTOR_IDS.map((executorId) => [
    executorId,
    async () => {
      const status = statuses[executorId] ?? "pass";
      if (executorId === "coverage" && status !== "error") {
        const collectedAt = new Date().toISOString();
        const definitions = [
          ["coverage_global", "TEST-COVERAGE-GLOBAL-001"],
          ["coverage_changed", "TEST-COVERAGE-CHANGED-001"],
        ];
        const evidence = definitions.map(([checkId], index) => ({
          schema_version: "1.0.0",
          evidence_id: `evidence:${checkId}`,
          kind: "test_result",
          level: "deterministic",
          outcome: status === "fail" && index === 1 ? "fail" : "pass",
          summary: `${checkId} exact counts were evaluated.`,
          check_id: checkId,
          collected_at: collectedAt,
          collected_by: { kind: "deterministic", id: "sdd_engineering_gates", runtime: "ci" },
          redaction: { applied: false, categories: [] },
        }));
        const checks = definitions.map(([checkId, ruleId], index) => ({
          check_id: checkId,
          rule_id: ruleId,
          status: status === "fail" && index === 1 ? "fail" : "pass",
          gate_effect: "block",
          summary: `${checkId} exact counts were evaluated.`,
          evidence_ids: [`evidence:${checkId}`],
        }));
        return { status, reason_code: `COVERAGE_${status.toUpperCase()}`, summary: "Coverage was evaluated.", evidence, checks };
      }
      if (executorId !== "governance" || status === "error") {
        return {
          status,
          reason_code: `${executorId.toUpperCase()}_${status.toUpperCase()}`,
          summary: `${executorId} produced a bounded test result.`,
        };
      }
      const definitions = [
        ["governance_catalog_integrity", "GOV-CATALOG-INTEGRITY-001"],
        ["codex_role_catalog", "GOV-CODEX-ROLE-CATALOG-001"],
        ["reviewer_report_only", "GOV-REVIEW-REPORTONLY-001"],
        ["review_handoff_contract", "GOV-REVIEW-HANDOFF-001"],
        ["pipeline_dependency_order", "GOV-PIPELINE-ORDER-001"],
      ];
      const collectedAt = new Date().toISOString();
      const evidence = definitions.map(([checkId], index) => ({
        schema_version: "1.0.0",
        evidence_id: `evidence:${checkId}`,
        kind: "static_analysis",
        level: "deterministic",
        outcome: status === "fail" && index === 0 ? "fail" : "pass",
        summary: `${checkId} produced bounded evidence.`,
        check_id: checkId,
        collected_at: collectedAt,
        collected_by: { kind: "deterministic", id: "sdd_governance_checker", runtime: "ci" },
        redaction: { applied: false, categories: [] },
      }));
      const checks = definitions.map(([checkId, ruleId], index) => ({
        check_id: checkId,
        rule_id: ruleId,
        status: status === "fail" && index === 0 ? "fail" : "pass",
        gate_effect: "block",
        summary: `${checkId} produced a bounded test result.`,
        evidence_ids: [`evidence:${checkId}`],
      }));
      return {
        status,
        reason_code: `GOVERNANCE_${status.toUpperCase()}`,
        summary: `governance produced a bounded test result.`,
        evidence,
        checks,
      };
    },
  ]));
}

function complexitySource(symbol, branches) {
  const conditions = Array.from(
    { length: branches },
    (_, index) => `  if (values[${index}]) score += 1;`,
  ).join("\n");
  return `export function ${symbol}(values) {\n  let score = 0;\n${conditions}\n  return score;\n}\n`;
}

function syntheticCoverage(file, uncovered = false, baselineFile) {
  const fileCoverage = (coverageFile, count, covered) => {
    const locations = Object.fromEntries(Array.from({ length: count }, (_, index) => [
      String(index),
      { start: { line: index + 1, column: 0 }, end: { line: index + 1, column: 10 } },
    ]));
    const counters = Object.fromEntries(Object.keys(locations).map((identifier) => [identifier, covered ? 1 : 0]));
    return {
      path: coverageFile,
      statementMap: locations,
      s: counters,
      fnMap: Object.fromEntries(Object.entries(locations).map(([identifier, loc]) => [identifier, {
        name: `function_${identifier}`, decl: loc, loc, line: loc.start.line,
      }])),
      f: counters,
      branchMap: Object.fromEntries(Object.entries(locations).map(([identifier, loc]) => [identifier, {
        type: "if", line: loc.start.line, locations: [loc],
      }])),
      b: Object.fromEntries(Object.entries(counters).map(([identifier, hits]) => [identifier, [hits]])),
    };
  };
  return {
    [file]: fileCoverage(file, 10, !uncovered),
    ...(baselineFile ? { [baselineFile]: fileCoverage(baselineFile, 100, true) } : {}),
  };
}

test("engineering gate configuration is strict and requires the exact executor allowlist", async () => {
  const inventoryFiles = [
    "engineering-gates.cases.js",
    "governance-checks.cases.js",
    "governance-schema.cases.js",
    "installer.cases.js",
    "node-lint-complexity-adapter.cases.js",
    "integration/node-lint-complexity-distribution.test.js",
  ];
  const inventory = (await Promise.all(inventoryFiles.map(async (relative) => {
    const source = await fs.readFile(path.join(repositoryRoot, "test", relative), "utf8");
    return [...source.matchAll(/^test\("([^"]+)"/gm)].map((match) => match[1]);
  }))).flat();
  assert.equal(UNIT_TEST_NAMES.size, 17);
  assert.equal(inventory.length, 89);
  assert.equal(new Set(inventory).size, 89);
  assert.equal(inventory.filter((name) => classifyTestName(name) === "unit").length, 17);
  assert.equal(inventory.filter((name) => classifyTestName(name) === "integration").length, 72);
  const unitFiles = (await fs.readdir(path.join(repositoryRoot, "test", "unit"))).filter((name) => name.endsWith(".test.js"));
  const integrationFiles = (await fs.readdir(path.join(repositoryRoot, "test", "integration"))).filter((name) => name.endsWith(".test.js"));
  assert.equal(unitFiles.length, 5);
  assert.equal(integrationFiles.length, 6);
  assert.equal(meetsCoverageThreshold({ covered: 89, total: 100 }, 90), false);
  assert.equal(meetsCoverageThreshold({ covered: 9, total: 10 }, 90), true);
  assert.equal(meetsCoverageThreshold({ covered: 0, total: 0 }, 90), true);
  const changedLineTwo = { intervals: [{ start: 2, end: 2 }], total: 1, sourceLineCount: 5 };
  assert.deepEqual(selectChangedCoverage({
    statementMap: { "0": { start: { line: 1, column: 0 }, end: { line: 3, column: 1 } } },
    s: { "0": 1 },
    fnMap: { "0": { loc: { start: { line: 4, column: 0 }, end: { line: 4, column: 8 } } } },
    f: { "0": 0 },
    branchMap: { "0": { locations: [
      { start: { line: 2, column: 0 }, end: { line: 2, column: 5 } },
      { start: { line: 5, column: 0 }, end: { line: 5, column: 5 } },
    ] } },
    b: { "0": [1, 0] },
    getLineCoverage: () => ({ 1: 1, 2: 1, 4: 0 }),
  }, changedLineTwo), {
    lines: { covered: 1, total: 1 },
    branches: { covered: 1, total: 1 },
    functions: { covered: 0, total: 0 },
    statements: { covered: 1, total: 1 },
  });
  assert.throws(() => selectChangedCoverage({
    statementMap: { "0": { start: { line: 2, column: 0 }, end: { line: 1, column: 0 } } },
    s: { "0": 1 }, fnMap: {}, f: {}, branchMap: {}, b: {}, getLineCoverage: () => ({}),
  }, { intervals: [{ start: 1, end: 1 }], total: 1, sourceLineCount: 2 }), /invalid coverage location/i);
  const otherwiseEmptyCoverage = {
    statementMap: {}, s: {}, fnMap: {}, f: {}, branchMap: {}, b: {}, getLineCoverage: () => ({}),
  };
  assert.throws(() => selectChangedCoverage({
    ...otherwiseEmptyCoverage,
    statementMap: { "0": { start: { line: 1, column: 0 }, end: { line: 6, column: 0 } } },
    s: { "0": 1 },
  }, changedLineTwo), /invalid coverage location/i);
  assert.throws(() => selectChangedCoverage({
    ...otherwiseEmptyCoverage,
    statementMap: { "0": { start: { column: 0 }, end: { line: 1, column: 0 } } },
    s: { "0": 1 },
  }, changedLineTwo), /invalid coverage location/i);
  assert.throws(() => selectChangedCoverage({
    ...otherwiseEmptyCoverage,
    statementMap: { "0": {
      start: { line: 1, column: 0 },
      end: { line: Number.MAX_SAFE_INTEGER + 1, column: 0 },
    } },
    s: { "0": 1 },
  }, changedLineTwo), /invalid coverage location/i);
  assert.throws(() => selectChangedCoverage({
    ...otherwiseEmptyCoverage,
    statementMap: { "0": {
      start: { line: 1, column: 0 },
      end: { line: COVERAGE_LIMITS.maxLocationSpanLines + 1, column: 0 },
    } },
    s: { "0": 1 },
  }, {
    intervals: [{ start: 1, end: 1 }],
    total: 1,
    sourceLineCount: COVERAGE_LIMITS.maxLocationSpanLines + 1,
  }), /invalid coverage location/i);
  assert.throws(() => selectChangedCoverage({
    ...otherwiseEmptyCoverage,
    statementMap: { "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } } },
    s: { "0": 1 },
  }, { intervals: [{ start: 1, end: 1 }], total: 1, sourceLineCount: 1 }, {
    used: COVERAGE_LIMITS.maxChangedLocations,
  }), /invalid coverage location/i);
  async function* reporterEvents() {
    yield { type: "test:pass", data: { name: "passing" } };
    yield { type: "test:pass", data: { name: "skipped", skip: "reason" } };
  }
  const reporterChunks = [];
  for await (const chunk of nodeTestReporter(reporterEvents())) reporterChunks.push(chunk);
  const reporterResult = JSON.parse(reporterChunks.join(""));
  assert.deepEqual(reporterResult.counts, {
    tests: 2, passed: 1, failed: 0, cancelled: 0, skipped: 1, todo: 0, suites: 0,
  });

  assert.equal((await validateEngineeringGateConfiguration(validConfiguration)).valid, true);
  assert.equal((await validateEngineeringGateConfiguration({ ...validConfiguration, command: "npm test" })).valid, false);
  assert.equal((await validateEngineeringGateConfiguration({
    ...validConfiguration,
    quality_profile: { ...validConfiguration.quality_profile, complexity: 99 },
  })).valid, false);
  assert.equal((await validateEngineeringGateConfiguration({
    ...validConfiguration,
    executors: validConfiguration.executors.slice(0, -1),
  })).valid, false);
  assert.equal((await validateEngineeringGateConfiguration({
    ...validConfiguration,
    executors: [...validConfiguration.executors.slice(0, -1), "javascript_syntax"],
  })).valid, false);
  assert.equal((await validateEngineeringGateConfiguration({
    ...validConfiguration,
    executors: [...validConfiguration.executors.slice(0, -1), "custom_executor"],
  })).valid, false);
  assert.equal((await validateEngineeringGateConfiguration({
    ...validConfiguration,
    gate_effect: "none",
  })).valid, false);
  assert.equal((await validateEngineeringGateConfiguration({
    ...validConfiguration,
    schema_version: "2.0.0",
  })).valid, false);
});

test("passing and functional-failure runs preserve canonical status and exit semantics", async (t) => {
  const target = await configuredTarget(t);
  const passing = await runConfiguredGates(target, { executors: executorSet() });
  assert.equal(passing.exitCode, 0);
  assert.equal(passing.document.outcome, "passed");
  assert.deepEqual(passing.document.quality_profile, {
    profile_id: "engineering-quality-v1",
    profile_version: "1.0.0",
    profile_digest: "sha256:a428ece53d85b3af2f5fb0987cb08f45ace2dab43df28da95cbd15f581ff0348",
    adapter_id: "node-v1",
    adapter_version: "1.0.0",
  });
  assert.deepEqual(passing.document.results.map((item) => item.executor_id), ENGINEERING_EXECUTOR_IDS);
  assert.equal(passing.document.results.every((item) => item.gate_effect === "block"), true);
  assert.equal((await validateEngineeringGateRun(passing.document)).ok, true);

  const failed = await runConfiguredGates(target, {
    executors: executorSet({ integration_tests: "fail", npm_package_surface: "fail" }),
  });
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.document.outcome, "failed");
  assert.equal(failed.document.results.at(-1).status, "pass");
  assert.equal((await validateEngineeringGateRun(failed.document)).ok, true);
});

test("the real Node lint and complexity adapter preserves runner exit and evidence semantics", async (t) => {
  const target = await configuredTarget(t);
  await fs.mkdir(path.join(target, "src"));
  await fs.writeFile(path.join(target, "src", "clean.js"), "export const clean = 1;\n");
  assert.equal(spawnSync("git", ["-C", target, "add", "--", "src/clean.js"]).status, 0);
  const executors = executorSet();
  executors.node_lint_complexity = runNodeLintComplexity;

  const passing = await runConfiguredGates(target, { executors });
  assert.equal(passing.exitCode, 0);
  assert.equal(passing.document.results[1].status, "pass");
  assert.deepEqual(passing.document.results[1].rule_ids, [
    "ENG-LINT-ERRORS-001",
    "ENG-CYCLOMATIC-COMPLEXITY-001",
  ]);

  await fs.writeFile(path.join(target, "src", "too-complex.js"), complexitySource("tooComplex", 15));
  assert.equal(spawnSync("git", ["-C", target, "add", "--", "src/too-complex.js"]).status, 0);
  const failing = await runConfiguredGates(target, { executors });
  assert.equal(failing.exitCode, 1);
  assert.equal(failing.document.results[1].status, "fail");
  assert.equal(
    failing.document.evidence.some((item) => item.location?.symbol === "tooComplex" && item.outcome === "fail"),
    true,
  );
  assert.equal((await validateEngineeringGateRun(failing.document)).ok, true);

  const coverageTarget = await configuredTarget(t);
  const productionFile = path.join(await fs.realpath(coverageTarget), "src", "coverage-target.js");
  const baselineFile = path.join(await fs.realpath(coverageTarget), "src", "baseline.js");
  await fs.mkdir(path.dirname(productionFile));
  await fs.mkdir(path.join(coverageTarget, "test", "unit"), { recursive: true });
  await fs.mkdir(path.join(coverageTarget, "test", "integration"), { recursive: true });
  await fs.writeFile(baselineFile, Array.from({ length: 100 }, (_, index) => `export const baseline${index} = ${index};`).join("\n"));
  await fs.writeFile(path.join(coverageTarget, "package.json"), '{"type":"module"}\n');
  await fs.writeFile(path.join(coverageTarget, "test", "unit", "sample.test.js"), "export default true;\n");
  await fs.writeFile(path.join(coverageTarget, "test", "integration", "sample.test.js"), "export default true;\n");
  assert.equal(spawnSync("git", ["-C", coverageTarget, "add", "src/baseline.js"], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("git", ["-C", coverageTarget, "commit", "-m", "coverage baseline"], { encoding: "utf8" }).status, 0);
  const coverageBase = execFileSync("git", ["-C", coverageTarget, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  await fs.writeFile(productionFile, Array.from({ length: 10 }, (_, index) => `export const value${index} = ${index};`).join("\n"));
  assert.equal(spawnSync("git", ["-C", coverageTarget, "add", "src/coverage-target.js"], { encoding: "utf8" }).status, 0);
  const coverageContext = {
    target: await fs.realpath(coverageTarget),
    comparisonBase: { effective_merge_base_sha: coverageBase },
    limits: { timeoutMs: 30000, maxOutputBytes: 262144 },
  };
  const coverageRunner = (uncoveredLast, mapMode = "valid") => async (executable, args, options) => {
    if (executable === "git") return runBoundedCommand(executable, args, options);
    assert.equal(executable, process.execPath);
    assert.match(args[0], /node_modules\/c8\/bin\/c8\.js$/);
    const configPath = args.find((value) => value.startsWith("--config=")).slice("--config=".length);
    assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), {});
    assert.equal((await fs.lstat(configPath)).isSymbolicLink(), false);
    assert.equal(options.env.SDD_TEST_SUITE === "unit" || options.env.SDD_TEST_SUITE === "integration", true);
    assert.deepEqual(Object.keys(options.env).sort(), ["PATH", "SDD_TEST_SUITE"]);
    const reportDirectory = args.find((value) => value.startsWith("--reports-dir=")).slice("--reports-dir=".length);
    const mapPath = path.join(reportDirectory, "coverage-final.json");
    if (mapMode === "symlink") {
      const outsideMap = path.join(coverageTarget, `outside-${options.env.SDD_TEST_SUITE}.json`);
      await fs.writeFile(outsideMap, JSON.stringify(syntheticCoverage(productionFile, uncoveredLast, baselineFile)));
      await fs.symlink(outsideMap, mapPath);
    } else {
      const mapValue = syntheticCoverage(productionFile, uncoveredLast, baselineFile);
      const firstStatement = mapValue[productionFile].statementMap["0"];
      if (mapMode === "out-of-file") firstStatement.end.line = 11;
      if (mapMode === "missing-location") delete firstStatement.start.line;
      if (mapMode === "overflow-location") firstStatement.end.line = Number.MAX_SAFE_INTEGER + 1;
      let mapSource = JSON.stringify(mapValue);
      if (mapMode === "malformed") mapSource = "not-json";
      if (mapMode === "oversize") mapSource = " ".repeat(10 * 1024 * 1024 + 1);
      if (mapMode === "deep") mapSource = `${"[".repeat(65)}0${"]".repeat(65)}`;
      await fs.writeFile(
        mapPath,
        mapSource,
      );
    }
    return { status: "completed", exit_code: 0, stdout: "", stderr: "" };
  };
  const changedFailure = await runNodeCoverage(coverageContext, coverageRunner(true));
  assert.equal(changedFailure.status, "fail", JSON.stringify(changedFailure));
  assert.deepEqual(changedFailure.checks.map((check) => [check.check_id, check.status]), [
    ["coverage_global", "pass"],
    ["coverage_changed", "fail"],
  ]);
  const coveragePassing = await runNodeCoverage(coverageContext, coverageRunner(false));
  assert.equal(coveragePassing.status, "pass");
  const outsideSuite = await temporaryDirectory(t);
  await fs.writeFile(path.join(outsideSuite, "external.test.js"), "throw new Error('external suite executed');\n");
  const integrationRoot = path.join(coverageTarget, "test", "integration");
  const savedIntegrationRoot = path.join(coverageTarget, "test", "integration-owned");
  await fs.rename(integrationRoot, savedIntegrationRoot);
  await fs.symlink(outsideSuite, integrationRoot);
  const invokedCoverageSuites = [];
  const symlinkRunner = async (executable, args, options) => {
    if (executable !== "git") invokedCoverageSuites.push(options.env.SDD_TEST_SUITE);
    return coverageRunner(false)(executable, args, options);
  };
  const unsafeSuite = await runNodeCoverage(coverageContext, symlinkRunner);
  assert.equal(unsafeSuite.reason_code, "COVERAGE_INTEGRATION_EXECUTION_ERROR");
  assert.deepEqual(invokedCoverageSuites, ["unit"]);
  await fs.rm(integrationRoot);
  await fs.rename(savedIntegrationRoot, integrationRoot);
  assert.equal((await runNodeCoverage(coverageContext, coverageRunner(false, "malformed"))).reason_code, "COVERAGE_MAP_INVALID");
  assert.equal((await runNodeCoverage(coverageContext, coverageRunner(false, "symlink"))).reason_code, "COVERAGE_MAP_INVALID");
  assert.equal((await runNodeCoverage(coverageContext, coverageRunner(false, "oversize"))).reason_code, "COVERAGE_MAP_INVALID");
  assert.equal((await runNodeCoverage(coverageContext, coverageRunner(false, "deep"))).reason_code, "COVERAGE_MAP_INVALID");
  for (const mode of ["out-of-file", "missing-location", "overflow-location"]) {
    assert.equal((await runNodeCoverage(coverageContext, coverageRunner(false, mode))).reason_code, "COVERAGE_EVALUATION_INVALID");
  }

  const atomicRoot = await temporaryDirectory(t);
  const atomicMap = path.join(atomicRoot, "coverage-final.json");
  const replacementMap = path.join(atomicRoot, "replacement.json");
  const atomicSource = JSON.stringify(syntheticCoverage(productionFile, false, baselineFile));
  await fs.writeFile(atomicMap, atomicSource);
  await fs.writeFile(replacementMap, atomicSource);
  await assert.rejects(readOwnedCoverageMap(
    atomicMap,
    atomicRoot,
    coverageTarget,
    new Set(["src/coverage-target.js", "src/baseline.js"]),
    coverageContext.limits,
    {
      open: async (...args) => {
        const handle = await fs.open(...args);
        await fs.rename(replacementMap, atomicMap);
        return handle;
      },
    },
  ), /unsafe coverage map/i);
  await fs.writeFile(atomicMap, atomicSource);
  await assert.rejects(readOwnedCoverageMap(
    atomicMap,
    atomicRoot,
    coverageTarget,
    new Set(["src/coverage-target.js", "src/baseline.js"]),
    coverageContext.limits,
    {
      open: async (...args) => {
        const handle = await fs.open(...args);
        let grew = false;
        return {
          stat: (...statArgs) => handle.stat(...statArgs),
          read: async (...readArgs) => {
            if (!grew) {
              grew = true;
              await fs.appendFile(atomicMap, " ");
            }
            return handle.read(...readArgs);
          },
          close: () => handle.close(),
        };
      },
    },
  ), /unsafe coverage map/i);
  const parseController = new AbortController();
  const parsing = parseCoverageMapSource(`${atomicSource}${" ".repeat(8 * 1024 * 1024)}`, {
    signal: parseController.signal,
    timeoutMs: 30000,
  });
  parseController.abort();
  await assert.rejects(parsing, /aborted/i);

  assert.equal(spawnSync("git", ["-C", coverageTarget, "commit", "-m", "changed production"], { encoding: "utf8" }).status, 0);
  const noChangeBase = execFileSync("git", ["-C", coverageTarget, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const noChange = await runNodeCoverage({
    ...coverageContext,
    comparisonBase: { effective_merge_base_sha: noChangeBase },
  }, coverageRunner(false));
  assert.equal(noChange.status, "pass");
  assert.equal(noChange.checks[1].gate_effect, "none");
  assert.equal(noChange.evidence[1].outcome, "not_applicable");

  const abortController = new AbortController();
  let ownedCoverageRoot;
  const abortingRunner = async (executable, args, options) => {
    if (executable === "git") return runBoundedCommand(executable, args, options);
    ownedCoverageRoot = path.dirname(args.find((value) => value.startsWith("--reports-dir=")).slice("--reports-dir=".length));
    setTimeout(() => abortController.abort(), 10);
    await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
    return { status: "error", reason_code: "EXECUTOR_ABORTED" };
  };
  const abortedCoverage = await runNodeCoverage({
    ...coverageContext,
    comparisonBase: { effective_merge_base_sha: noChangeBase },
    limits: { ...coverageContext.limits, signal: abortController.signal },
  }, abortingRunner);
  assert.equal(abortedCoverage.reason_code, "EXECUTOR_ABORTED");
  await assert.rejects(fs.access(ownedCoverageRoot), { code: "ENOENT" });

  await fs.writeFile(path.join(coverageTarget, ".c8rc"), "{}\n");
  assert.equal((await runNodeCoverage(coverageContext, coverageRunner(false))).reason_code, "COVERAGE_CONFIGURATION_REJECTED");
  await fs.rm(path.join(coverageTarget, ".c8rc"));
  await fs.writeFile(path.join(coverageTarget, "package.json"), '{"type":"module","c8":{}}\n');
  assert.equal((await runNodeCoverage(coverageContext, coverageRunner(false))).reason_code, "COVERAGE_CONFIGURATION_REJECTED");
  await fs.writeFile(path.join(coverageTarget, "package.json"), '{"type":"module"}\n');
  await fs.writeFile(productionFile, "/* c8 ignore next */\nexport const ignored = true;\n");
  assert.equal((await runNodeCoverage(coverageContext, coverageRunner(false))).reason_code, "COVERAGE_CONFIGURATION_REJECTED");
});

test("a syntax failure remains completed when the real Node adapter observes the parse error", async (t) => {
  const target = await configuredTarget(t);
  await fs.mkdir(path.join(target, "src"));
  await fs.writeFile(path.join(target, "src", "invalid.js"), "export function invalid( {\n");
  assert.equal(spawnSync("git", ["-C", target, "add", "--", "src/invalid.js"]).status, 0);
  const executors = executorSet({ javascript_syntax: "fail" });
  executors.node_lint_complexity = runNodeLintComplexity;

  const result = await runConfiguredGates(target, { executors });

  assert.equal(result.exitCode, 1);
  assert.equal(result.document.outcome, "failed");
  assert.equal(result.document.results[0].status, "fail");
  assert.equal(result.document.results[1].status, "fail");
  assert.equal(result.document.results[2].status, "pass");
  assert.equal((await validateEngineeringGateRun(result.document)).ok, true);
});

test("executor output cannot weaken package-owned deterministic policy", async (t) => {
  const target = await configuredTarget(t);
  const executors = executorSet();
  executors.javascript_syntax = async () => ({
    status: "fail",
    gate_effect: "none",
    reason_code: "SOURCE_SYNTAX_FAILED",
    summary: "A functional failure attempted to override its effect.",
  });
  const result = await runConfiguredGates(target, { executors });
  assert.equal(result.exitCode, 1);
  assert.equal(result.document.results[0].gate_effect, "block");
});

test("executors receive immutable package-owned quality profile identity", async (t) => {
  const target = await configuredTarget(t);
  const executors = executorSet();
  executors.javascript_syntax = async ({ qualityProfile }) => {
    assert.equal(Object.isFrozen(qualityProfile), true);
    assert.deepEqual(qualityProfile, {
      profile_id: "engineering-quality-v1",
      profile_version: "1.0.0",
      profile_digest: "sha256:a428ece53d85b3af2f5fb0987cb08f45ace2dab43df28da95cbd15f581ff0348",
      adapter_id: "node-v1",
      adapter_version: "1.0.0",
    });
    return {
      status: "pass",
      reason_code: "SOURCE_SYNTAX_PASS",
      summary: "The immutable profile context was received.",
    };
  };
  const result = await runConfiguredGates(target, { executors });
  assert.equal(result.exitCode, 0);
});

test("result validation enforces complete governance details and evidence ownership", async (t) => {
  const target = await configuredTarget(t);
  const result = await runConfiguredGates(target, { executors: executorSet() });

  const missingComparisonBase = structuredClone(result.document);
  delete missingComparisonBase.comparison_base;
  const missingComparisonBaseValidation = await validateEngineeringGateRun(missingComparisonBase);
  assert.equal(missingComparisonBaseValidation.ok, false);
  assert.equal(missingComparisonBaseValidation.errors.some((error) => error.includes("comparison_base")), true);

  const wrongRunProducer = structuredClone(result.document);
  wrongRunProducer.producer.id = "arbitrary_producer";
  assert.equal((await validateEngineeringGateRun(wrongRunProducer)).ok, false);

  const wrongRunProducerRuntime = structuredClone(result.document);
  wrongRunProducerRuntime.producer.runtime = "manual";
  assert.equal((await validateEngineeringGateRun(wrongRunProducerRuntime)).ok, false);

  const wrongExecutorEvidenceProducer = structuredClone(result.document);
  wrongExecutorEvidenceProducer.evidence[0].collected_by = {
    kind: "human",
    id: "arbitrary_collector",
    runtime: "manual",
  };
  assert.equal((await validateEngineeringGateRun(wrongExecutorEvidenceProducer)).ok, false);

  const wrongGovernanceEvidenceProducer = structuredClone(result.document);
  const governanceEvidence = wrongGovernanceEvidenceProducer.evidence.find(
    (evidence) => evidence.check_id === "governance_catalog_integrity",
  );
  governanceEvidence.collected_by.runtime = "manual";
  assert.equal((await validateEngineeringGateRun(wrongGovernanceEvidenceProducer)).ok, false);

  const missingGovernanceCheck = structuredClone(result.document);
  missingGovernanceCheck.results[5].checks = [{
    check_id: "governance_catalog_integrity",
    rule_id: "GOV-CATALOG-INTEGRITY-001",
    status: "pass",
    gate_effect: "block",
    summary: "Incomplete governance detail.",
    evidence_ids: missingGovernanceCheck.results[5].evidence_ids,
  }];
  assert.equal((await validateEngineeringGateRun(missingGovernanceCheck)).ok, false);

  const noChangedCoverage = structuredClone(result.document);
  const coverageResult = noChangedCoverage.results[4];
  const changedCheck = coverageResult.checks[1];
  changedCheck.gate_effect = "none";
  const changedEvidence = noChangedCoverage.evidence.find((item) => item.check_id === "coverage_changed");
  changedEvidence.outcome = "not_applicable";
  assert.equal((await validateEngineeringGateRun(noChangedCoverage)).ok, true);

  const globalNonBlocking = structuredClone(result.document);
  globalNonBlocking.results[4].checks[0].gate_effect = "none";
  assert.equal((await validateEngineeringGateRun(globalNonBlocking)).ok, false);

  const changedNonBlocking = structuredClone(result.document);
  changedNonBlocking.results[4].checks[1].gate_effect = "none";
  assert.equal((await validateEngineeringGateRun(changedNonBlocking)).ok, false);

  const changedNotApplicableWithTwoEvidence = structuredClone(noChangedCoverage);
  changedNotApplicableWithTwoEvidence.results[4].checks[1].evidence_ids.push(
    changedNotApplicableWithTwoEvidence.results[4].checks[0].evidence_ids[0],
  );
  assert.equal((await validateEngineeringGateRun(changedNotApplicableWithTwoEvidence)).ok, false);

  const extraCoverageEvidence = structuredClone(result.document);
  const extraGlobalEvidence = {
    ...extraCoverageEvidence.evidence.find((item) => item.check_id === "coverage_global"),
    evidence_id: "evidence:coverage_global_extra",
  };
  extraCoverageEvidence.evidence.push(extraGlobalEvidence);
  extraCoverageEvidence.results[4].checks[0].evidence_ids.push(extraGlobalEvidence.evidence_id);
  extraCoverageEvidence.results[4].evidence_ids.push(extraGlobalEvidence.evidence_id);
  assert.equal((await validateEngineeringGateRun(extraCoverageEvidence)).ok, false);

  const reorderedCoverageEvidence = structuredClone(result.document);
  reorderedCoverageEvidence.results[4].evidence_ids.reverse();
  assert.equal((await validateEngineeringGateRun(reorderedCoverageEvidence)).ok, false);

  const erroredCoverage = await runConfiguredGates(target, { executors: executorSet({ coverage: "error" }) });
  assert.equal((await validateEngineeringGateRun(erroredCoverage.document)).ok, true);
  const erroredCoverageWithChecks = structuredClone(erroredCoverage.document);
  erroredCoverageWithChecks.results[4].checks = structuredClone(result.document.results[4].checks);
  assert.equal((await validateEngineeringGateRun(erroredCoverageWithChecks)).ok, false);

  const reorderedCoverage = structuredClone(result.document);
  reorderedCoverage.results[4].checks.reverse();
  assert.equal((await validateEngineeringGateRun(reorderedCoverage)).ok, false);

  const orphanEvidence = structuredClone(result.document);
  orphanEvidence.evidence.push({
    ...orphanEvidence.evidence[0],
    evidence_id: "evidence:orphan_engineering_result",
  });
  assert.equal((await validateEngineeringGateRun(orphanEvidence)).ok, false);

  const unexplainedNotRun = structuredClone(result.document);
  unexplainedNotRun.results[0].status = "not_run";
  unexplainedNotRun.results[0].summary = "This executor was not run.";
  unexplainedNotRun.results[0].reason_code = "NOT_RUN";
  unexplainedNotRun.evidence[0].outcome = "inconclusive";
  unexplainedNotRun.outcome = "blocked";
  assert.equal((await validateEngineeringGateRun(unexplainedNotRun)).ok, false);
});

test("an executor error exits two and leaves following executors not_run", async (t) => {
  const target = await configuredTarget(t);
  const result = await runConfiguredGates(target, {
    executors: executorSet({ production_dependency_audit: "error" }),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.document.outcome, "blocked");
  assert.deepEqual(
    result.document.results.map((item) => item.status),
    ["pass", "pass", "pass", "pass", "pass", "pass", "error", "not_run", "not_run"],
  );
  assert.equal((await validateEngineeringGateRun(result.document)).ok, true);
});

test("lint warnings are observed evidence but primary executor evidence remains mandatory", async (t) => {
  const target = await configuredTarget(t);
  const executors = executorSet();
  const collectedAt = new Date().toISOString();
  executors.node_lint_complexity = async () => ({
    status: "pass",
    reason_code: "NODE_LINT_COMPLEXITY_PASSED",
    summary: "Lint passed with one informational warning.",
    evidence: [
      {
        schema_version: "1.0.0",
        evidence_id: "evidence:node_lint_complexity_summary",
        kind: "static_analysis",
        level: "deterministic",
        outcome: "pass",
        summary: "Package-owned lint and complexity policy passed.",
        check_id: "node_lint_complexity",
        collected_at: collectedAt,
        collected_by: { kind: "deterministic", id: "sdd_engineering_gates", runtime: "ci" },
        redaction: { applied: false, categories: [] },
      },
      {
        schema_version: "1.0.0",
        evidence_id: "evidence:node_lint_complexity_warning_1",
        kind: "source_location",
        level: "deterministic",
        outcome: "observed",
        summary: "One package-owned informational warning was observed.",
        location: { path: "src/example.js", line_start: 1 },
        check_id: "node_lint_complexity",
        collected_at: collectedAt,
        collected_by: { kind: "deterministic", id: "sdd_engineering_gates", runtime: "ci" },
        redaction: { applied: false, categories: [] },
      },
    ],
  });
  const result = await runConfiguredGates(target, { executors });
  assert.equal(result.exitCode, 0);
  assert.equal((await validateEngineeringGateRun(result.document)).ok, true);

  const noPrimary = structuredClone(result.document);
  noPrimary.evidence.find(
    (item) => item.evidence_id === "evidence:node_lint_complexity_summary",
  ).outcome = "observed";
  assert.equal((await validateEngineeringGateRun(noPrimary)).ok, false);
});

test("missing, malformed, unknown, and unsafe configuration fail closed before execution", async (t) => {
  const missingTarget = await temporaryDirectory(t);
  const missing = await runEngineeringGates(missingTarget, { executors: executorSet() });
  assert.equal(missing.exitCode, 2);
  assert.equal(missing.document.run_error.reason_code, "CONFIGURATION_MISSING");
  assert.equal(missing.document.results.every((item) => item.status === "not_run"), true);

  const malformedTarget = await configuredTarget(t);
  await fs.writeFile(path.join(malformedTarget, ".sdd-codegraph", "gates.json"), "{invalid");
  const malformed = await runEngineeringGates(malformedTarget, { executors: executorSet() });
  assert.equal(malformed.document.run_error.reason_code, "CONFIGURATION_INVALID");

  const unknownTarget = await configuredTarget(t, { ...validConfiguration, baseline: "main" });
  const unknown = await runEngineeringGates(unknownTarget, { executors: executorSet() });
  assert.equal(unknown.document.run_error.reason_code, "CONFIGURATION_INVALID");

  const outside = await temporaryDirectory(t);
  const unsafeTarget = await temporaryDirectory(t);
  await fs.writeFile(path.join(outside, "gates.json"), `${JSON.stringify({ ...validConfiguration, secret: "do-not-leak" })}\n`);
  await fs.mkdir(path.join(unsafeTarget, ".sdd-codegraph"));
  await fs.symlink(path.join(outside, "gates.json"), path.join(unsafeTarget, ".sdd-codegraph", "gates.json"));
  const unsafe = await runEngineeringGates(unsafeTarget, { executors: executorSet() });
  assert.equal(unsafe.document.run_error.reason_code, "CONFIGURATION_UNSAFE_PATH");
  assert.doesNotMatch(JSON.stringify(unsafe.document), /do-not-leak/);
});

test("executor exceptions are bounded and redaction-safe", async (t) => {
  const target = await configuredTarget(t);
  const executors = executorSet();
  executors.javascript_syntax = async () => { throw new Error("token=raw-sensitive-value"); };
  const result = await runConfiguredGates(target, { executors });
  assert.equal(result.exitCode, 2);
  assert.equal(result.document.results[0].reason_code, "EXECUTOR_EXCEPTION");
  assert.doesNotMatch(JSON.stringify(result.document), /raw-sensitive-value/);

  const invalidExecutors = executorSet();
  invalidExecutors.javascript_syntax = async () => null;
  const invalid = await runConfiguredGates(target, { executors: invalidExecutors });
  assert.equal(invalid.exitCode, 2);
  assert.equal(invalid.document.results[0].reason_code, "EXECUTOR_INVALID_RESULT");

  const adapterExecutors = executorSet();
  adapterExecutors.node_lint_complexity = async () => { throw new Error("token=adapter-sensitive-value"); };
  const adapterException = await runConfiguredGates(target, { executors: adapterExecutors });
  assert.equal(adapterException.exitCode, 2);
  assert.equal(adapterException.document.results[1].reason_code, "EXECUTOR_EXCEPTION");
  assert.equal(adapterException.document.results.slice(2).every((item) => item.status === "not_run"), true);
  assert.doesNotMatch(JSON.stringify(adapterException.document), /adapter-sensitive-value/);
});

test("the orchestrator times out an executor that never resolves", async (t) => {
  const target = await configuredTarget(t);
  const executors = executorSet();
  let cleanupCompleted = false;
  executors.production_dependency_audit = ({ signal }) => new Promise((resolve) => {
    signal.addEventListener("abort", () => {
      setTimeout(() => {
        cleanupCompleted = true;
        resolve({ status: "error", reason_code: "EXECUTOR_ABORTED" });
      }, 30);
    }, { once: true });
  });
  const nativeSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => (
    nativeSetTimeout(callback, delay === 60000 ? 20 : delay === 1000 ? 50 : delay, ...args)
  ));

  const result = await runConfiguredGates(target, { executors });
  assert.equal(cleanupCompleted, true);
  assert.equal(result.exitCode, 2);
  assert.equal(result.document.outcome, "blocked");
  assert.equal(result.document.results[6].status, "error");
  assert.equal(result.document.results[6].reason_code, "EXECUTOR_TIMEOUT");
  assert.equal(result.document.results.slice(7).every((item) => item.status === "not_run"), true);
  assert.equal((await validateEngineeringGateRun(result.document)).ok, true);

  const nonCooperativeExecutors = executorSet();
  nonCooperativeExecutors.production_dependency_audit = () => new Promise(() => {});
  const nonCooperativeStarted = Date.now();
  const nonCooperative = await runConfiguredGates(target, { executors: nonCooperativeExecutors });
  assert.ok(Date.now() - nonCooperativeStarted < 250);
  assert.equal(nonCooperative.exitCode, 2);
  assert.equal(nonCooperative.document.results[6].reason_code, "EXECUTOR_TIMEOUT");
  assert.equal(nonCooperative.document.results.slice(7).every((item) => item.status === "not_run"), true);
  assert.equal((await validateEngineeringGateRun(nonCooperative.document)).ok, true);
});

test("bounded command execution distinguishes timeout, overflow, and functional exit", async (t) => {
  let transitionProbes = 0;
  await assertProcessExited(123, {
    platform: "linux",
    timeoutMs: 10,
    now: () => 0,
    wait: async () => {},
    probe: () => {
      transitionProbes += 1;
      if (transitionProbes === 3) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
    readLinuxState: async () => "R",
  });
  assert.equal(transitionProbes, 3);
  assert.equal(parseLinuxProcessState("123 (fixture ) worker) Z 1 2 3\n"), "Z");
  assert.throws(() => parseLinuxProcessState("123 malformed\n"), /invalid Linux process stat/);
  assert.throws(() => parseLinuxProcessState("x".repeat(4097)), /invalid Linux process stat/);
  let zombieElapsed = 0;
  await assertProcessExited(123, {
    platform: "linux",
    timeoutMs: 2,
    now: () => zombieElapsed,
    wait: async (delay) => { zombieElapsed += delay; },
    probe: () => {},
    readLinuxState: async () => "Z",
  });
  let deadlineElapsed = 0;
  await assert.rejects(assertProcessExited(123, {
    platform: "linux",
    timeoutMs: 2,
    now: () => deadlineElapsed,
    wait: async (delay) => { deadlineElapsed += delay; },
    probe: () => {},
    readLinuxState: async () => "R",
  }), /remained observable/);
  await assert.rejects(assertProcessExited(123, {
    probe: () => { throw Object.assign(new Error("unexpected probe failure"), { code: "EPERM" }); },
  }), { code: "EPERM" });
  await assert.rejects(assertProcessExited(123, {
    platform: "linux",
    probe: () => {},
    readLinuxState: async () => { throw Object.assign(new Error("unexpected proc failure"), { code: "EIO" }); },
  }), { code: "EIO" });

  const timedOut = await runBoundedCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repositoryRoot,
    timeoutMs: 20,
    maxOutputBytes: 1024,
  });
  assert.equal(timedOut.reason_code, "COMMAND_TIMEOUT");

  const overflow = await runBoundedCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], {
    cwd: repositoryRoot,
    timeoutMs: 1000,
    maxOutputBytes: 64,
  });
  assert.equal(overflow.reason_code, "COMMAND_OUTPUT_LIMIT");

  const functional = await runBoundedCommand(process.execPath, ["-e", "process.exit(7)"], {
    cwd: repositoryRoot,
    timeoutMs: 1000,
    maxOutputBytes: 64,
  });
  assert.equal(functional.status, "completed");
  assert.equal(functional.exit_code, 7);

  const spawnFailure = await runBoundedCommand(path.join(repositoryRoot, "missing-executable"), [], {
    cwd: repositoryRoot,
    timeoutMs: 1000,
    maxOutputBytes: 64,
  });
  assert.equal(spawnFailure.reason_code, "COMMAND_SPAWN_FAILED");

  const treeDirectory = await temporaryDirectory(t);
  const grandchildPidPath = path.join(treeDirectory, "grandchild.pid");
  const controller = new AbortController();
  const treeExecution = runBoundedCommand(process.execPath, ["-e", [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(child.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n")], {
    cwd: repositoryRoot,
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 150);
  assert.equal((await treeExecution).reason_code, "EXECUTOR_ABORTED");
  const grandchildPid = Number(await fs.readFile(grandchildPidPath, "utf8"));
  await assertProcessExited(grandchildPid);

  const injectedTreeDirectory = await temporaryDirectory(t);
  const injectedGrandchildPath = path.join(injectedTreeDirectory, "grandchild.pid");
  const injectedController = new AbortController();
  let injectedTerminationCompleted = false;
  const injectedTreeExecution = runBoundedCommand(process.execPath, ["-e", [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(injectedGrandchildPath)}, String(child.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n")], {
    cwd: repositoryRoot,
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    signal: injectedController.signal,
    terminationControl: {
      platform: "win32",
      windowsExecutable: "C:\\Windows\\System32\\taskkill.exe",
      terminateWindows: async ({ executable, args, pid }) => {
        assert.equal(executable, "C:\\Windows\\System32\\taskkill.exe");
        assert.deepEqual(args, ["/pid", String(pid), "/t", "/f"]);
        const injectedGrandchildPid = Number(await fs.readFile(injectedGrandchildPath, "utf8"));
        for (const candidate of [injectedGrandchildPid, pid]) {
          try { process.kill(candidate, "SIGKILL"); } catch { /* Already terminated. */ }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        injectedTerminationCompleted = true;
      },
    },
  });
  setTimeout(() => injectedController.abort(), 150);
  assert.equal((await injectedTreeExecution).reason_code, "EXECUTOR_ABORTED");
  assert.equal(injectedTerminationCompleted, true);
  const injectedGrandchildPid = Number(await fs.readFile(injectedGrandchildPath, "utf8"));
  await assertProcessExited(injectedGrandchildPid);

  const suiteTarget = await temporaryDirectory(t);
  await fs.mkdir(path.join(suiteTarget, "test", "unit"), { recursive: true });
  const suiteFile = path.join(suiteTarget, "test", "unit", "sample.test.js");
  await fs.writeFile(path.join(suiteTarget, "package.json"), '{"type":"module"}\n');
  await fs.writeFile(suiteFile, "import test from 'node:test';\ntest('fixture pass', () => {});\n");
  const report = (counts, status = "pass") => `${JSON.stringify({
    protocol_version: "1.0.0",
    suite: "unit",
    status,
    counts,
    failures: status === "fail" ? [{ name: "bounded failure" }] : [],
  })}\n`;
  const baseCounts = { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0 };
  const suiteContext = { target: suiteTarget, limits: { timeoutMs: 1000, maxOutputBytes: 1024 } };
  assert.equal((await runNodeTestSuite(suiteContext, "unit")).status, "pass");
  await fs.writeFile(suiteFile, "import test from 'node:test';\ntest('fixture failure', () => { throw new Error('expected'); });\n");
  assert.equal((await runNodeTestSuite(suiteContext, "unit")).status, "fail");
  await fs.writeFile(suiteFile, "import test from 'node:test';\ntest.skip('fixture skipped', () => {});\n");
  assert.equal((await runNodeTestSuite(suiteContext, "unit")).status, "error");
  assert.equal((await runNodeTestSuite(suiteContext, "unit", async () => ({
    status: "completed", exit_code: 0, stdout: report(baseCounts), stderr: "",
  }))).status, "pass");
  assert.equal((await runNodeTestSuite(suiteContext, "unit", async () => ({
    status: "completed", exit_code: 1,
    stdout: report({ ...baseCounts, passed: 0, failed: 1 }, "fail"), stderr: "",
  }))).status, "fail");
  for (const stdout of [
    "not-json\n",
    report({ ...baseCounts, skipped: 1, passed: 0 }),
    report({ ...baseCounts, tests: 0, passed: 0 }),
  ]) {
    const result = await runNodeTestSuite(suiteContext, "unit", async () => ({
      status: "completed", exit_code: 0, stdout, stderr: "",
    }));
    assert.equal(result.status, "error");
  }
});

test("comparison-base rejects non-full commit identifiers before execution", async (t) => {
  const target = await configuredTarget(t);
  const result = await runEngineeringGates(target, {
    comparisonBase: "HEAD~1",
    executors: executorSet(),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.document.run_error.reason_code, "COMPARISON_BASE_INVALID");
  assert.equal(result.document.results.every((item) => item.status === "not_run"), true);
});

test("the selected blocking changed-code profile requires an explicit comparison base", async (t) => {
  const target = await configuredTarget(t);
  const result = await runEngineeringGates(target, { executors: executorSet() });
  assert.equal(result.exitCode, 2);
  assert.equal(result.document.run_error.reason_code, "COMPARISON_BASE_REQUIRED");
});

test("comparison-base resolves a full commit to its effective merge base", async (t) => {
  const target = await configuredTarget(t);
  await fs.mkdir(path.join(target, "src"));
  await fs.writeFile(path.join(target, "src", "renamed.js"), "export const value = 1;\n");
  await fs.writeFile(path.join(target, "src", "deleted.js"), "export const deleted = true;\n");
  assert.equal(spawnSync("git", ["-C", target, "add", "src"], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("git", ["-C", target, "commit", "-m", "production base"], { encoding: "utf8" }).status, 0);
  const sha = execFileSync("git", ["-C", target, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  await fs.writeFile(path.join(target, "src", "renamed.js"), "export const value = 2;\n");
  await fs.rm(path.join(target, "src", "deleted.js"));
  await fs.writeFile(path.join(target, "src", "untracked.js"), "export const untracked = true;\n");
  const result = await runEngineeringGates(target, { comparisonBase: sha, executors: executorSet() });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.document.comparison_base, {
    supplied_sha: sha,
    effective_merge_base_sha: sha,
  });

  const production = await collectProductionChanges(target, sha, { timeoutMs: 30000, maxOutputBytes: 262144 });
  assert.equal(production.status, "completed");
  assert.deepEqual(production.tracked, ["src/renamed.js"]);
  assert.deepEqual(production.untracked, ["src/untracked.js"]);
  assert.deepEqual([...production.changed.keys()], ["src/renamed.js", "src/untracked.js"]);
  assert.deepEqual(production.changed.get("src/renamed.js"), {
    intervals: [{ start: 1, end: 1 }], total: 1, sourceLineCount: 1,
  });
  assert.deepEqual(production.changed.get("src/untracked.js"), {
    intervals: [{ start: 1, end: 1 }], total: 1, sourceLineCount: 1,
  });

  assert.throws(() => parseChangedLineIntervals(
    "@@ -1 +1,2 @@\n@@ -2 +2,1 @@\n",
    3,
    { lines: 0, hunks: 0 },
  ), /invalid git hunk/i);
  assert.throws(() => parseChangedLineIntervals(
    "@@ -1 +9007199254740991,2 @@\n",
    Number.MAX_SAFE_INTEGER,
    { lines: 0, hunks: 0 },
  ), /invalid git hunk/i);
  assert.throws(() => parseChangedLineIntervals(
    "@@ -1 +2,1 @@\n",
    1,
    { lines: 0, hunks: 0 },
  ), /invalid git hunk/i);
  const manyHunks = Array.from(
    { length: 10000 },
    (_, index) => `@@ -${index * 10 + 1},10 +${index * 10 + 1},10 @@`,
  ).join("\n");
  const aggregate = { lines: 0, hunks: 0 };
  for (let index = 0; index < 5; index += 1) {
    assert.equal(parseChangedLineIntervals(manyHunks, 100000, aggregate).total, 100000);
  }
  assert.throws(() => parseChangedLineIntervals("@@ -1 +1,1 @@\n", 1, aggregate), /invalid git hunk/i);

  const hostile = await collectProductionChanges(target, sha, { timeoutMs: 100, maxOutputBytes: 1024 }, async (_command, args, options) => {
    assert.ok(args.includes("core.hooksPath=/dev/null"));
    assert.equal(options.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal("HOME" in options.env, false);
    return { status: "completed", exit_code: 0, stdout: "src/unterminated.js", stderr: "" };
  });
  assert.equal(hostile.status, "error");
  assert.equal(hostile.reason_code, "GIT_OUTPUT_MALFORMED");
});

test("unsafe tracked source paths and unknown governance layouts block execution", async (t) => {
  const target = await configuredTarget(t);
  const outside = await temporaryDirectory(t);
  await fs.writeFile(path.join(outside, "escaped.js"), "export default true;\n");
  await fs.symlink(path.join(outside, "escaped.js"), path.join(target, "escaped.js"));
  assert.equal(spawnSync("git", ["-C", target, "add", "."], { encoding: "utf8" }).status, 0);

  const unsafe = await runConfiguredGates(target);
  assert.equal(unsafe.exitCode, 2);
  assert.equal(unsafe.document.results[0].reason_code, "SOURCE_UNSAFE_PATH");
  assert.equal(unsafe.document.results.slice(1).every((item) => item.status === "not_run"), true);

  await fs.rm(path.join(target, "escaped.js"));
  assert.equal(spawnSync("git", ["-C", target, "add", "-u"], { encoding: "utf8" }).status, 0);
  const unknown = await runConfiguredGates(target, { executors: executorSet({ governance: "error" }) });
  assert.equal(unknown.exitCode, 2);
  assert.equal(unknown.document.results[5].reason_code, "GOVERNANCE_ERROR");
  assert.equal(unknown.document.results.slice(6).every((item) => item.status === "not_run"), true);
});

test("invalid generated evidence fails the complete result contract without leaking values", async (t) => {
  const target = await configuredTarget(t);
  const executors = executorSet();
  executors.javascript_syntax = async () => ({
    status: "pass",
    reason_code: "SOURCE_SYNTAX_PASSED",
    summary: "Generated invalid evidence.",
    evidence: [{ secret: "generated-sensitive-value" }],
  });
  const result = await runConfiguredGates(target, { executors });
  assert.equal(result.exitCode, 2);
  assert.equal(result.document.run_error.reason_code, "RESULT_VALIDATION_FAILED");
  assert.doesNotMatch(JSON.stringify(result.document), /generated-sensitive-value/);
});

test("run-gates CLI emits exactly one canonical document for missing configuration", async (t) => {
  const target = await temporaryDirectory(t);
  const execution = spawnSync(process.execPath, [cliPath, "run-gates", target], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(execution.status, 2);
  assert.equal(execution.stderr, "");
  const document = JSON.parse(execution.stdout);
  assert.equal(document.outcome, "blocked");
  assert.equal(document.run_error.reason_code, "CONFIGURATION_MISSING");
  assert.equal((await validateEngineeringGateRun(document)).ok, true);
});

test("source, project-local, and global package CLIs enforce the same target contract", async (t) => {
  const root = await temporaryDirectory(t);
  const target = path.join(root, "target-without-configuration");
  const packDirectory = path.join(root, "pack");
  const project = path.join(root, "project-consumer");
  const globalPrefix = path.join(root, "global-prefix");
  const npmCache = path.join(root, "npm-cache");
  await Promise.all([
    fs.mkdir(target),
    fs.mkdir(packDirectory),
    fs.mkdir(project),
  ]);
  await fs.writeFile(path.join(project, "package.json"), "{\"private\":true}\n");
  const env = { ...process.env, NPM_CONFIG_CACHE: npmCache };
  const [packed] = JSON.parse(execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
    { cwd: repositoryRoot, encoding: "utf8", env },
  ));
  const tarball = path.join(packDirectory, packed.filename);
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: project, encoding: "utf8", env },
  );
  execFileSync(
    "npm",
    ["install", "--global", "--prefix", globalPrefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: root, encoding: "utf8", env },
  );

  const installedRelative = path.join(
    "node_modules",
    "@gustavoarielms",
    "sdd-codegraph-cli",
    "bin",
    "sdd-codegraph.js",
  );
  const entrypoints = [
    cliPath,
    path.join(project, installedRelative),
    path.join(globalPrefix, "lib", installedRelative),
  ];
  const packageRoots = [
    repositoryRoot,
    path.join(project, "node_modules", "@gustavoarielms", "sdd-codegraph-cli"),
    path.join(globalPrefix, "lib", "node_modules", "@gustavoarielms", "sdd-codegraph-cli"),
  ];
  for (const entrypoint of entrypoints) {
    const execution = spawnSync(process.execPath, [entrypoint, "run-gates", target], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    assert.equal(execution.status, 2);
    assert.equal(execution.stderr, "");
    const document = JSON.parse(execution.stdout);
    assert.equal(document.run_error.reason_code, "CONFIGURATION_MISSING");
    assert.equal((await validateEngineeringGateRun(document)).ok, true);
  }
  for (const packageRoot of packageRoots) {
    const adapterUrl = new URL(`file://${path.join(packageRoot, "src", "node-coverage-adapter.js")}`).href;
    const execution = spawnSync(process.execPath, ["-e", [
      "(async () => {",
      `  const { parseCoverageMapSource } = await import(${JSON.stringify(adapterUrl)});`,
      "  const value = await parseCoverageMapSource('{}', { timeoutMs: 1000 });",
      "  if (Object.keys(value).length !== 0) process.exit(1);",
      "})().catch((error) => { console.error(error); process.exit(1); });",
    ].join("\n")], { cwd: root, encoding: "utf8", env });
    assert.equal(execution.status, 0, execution.stderr);
  }
});
