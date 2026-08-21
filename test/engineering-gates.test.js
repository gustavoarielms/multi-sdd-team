import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
    "test_suite",
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

test("engineering gate configuration is strict and requires the exact executor allowlist", async () => {
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
    executors: executorSet({ test_suite: "fail", npm_package_surface: "fail" }),
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
  missingGovernanceCheck.results[3].checks = [{
    check_id: "governance_catalog_integrity",
    rule_id: "GOV-CATALOG-INTEGRITY-001",
    status: "pass",
    gate_effect: "block",
    summary: "Incomplete governance detail.",
    evidence_ids: missingGovernanceCheck.results[3].evidence_ids,
  }];
  assert.equal((await validateEngineeringGateRun(missingGovernanceCheck)).ok, false);

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
    ["pass", "pass", "pass", "pass", "error", "not_run", "not_run"],
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
  executors.production_dependency_audit = () => new Promise(() => {});
  const nativeSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => (
    nativeSetTimeout(callback, delay === 60000 ? 20 : delay, ...args)
  ));

  const result = await runConfiguredGates(target, { executors });
  assert.equal(result.exitCode, 2);
  assert.equal(result.document.outcome, "blocked");
  assert.equal(result.document.results[4].status, "error");
  assert.equal(result.document.results[4].reason_code, "EXECUTOR_TIMEOUT");
  assert.equal(result.document.results.slice(5).every((item) => item.status === "not_run"), true);
  assert.equal((await validateEngineeringGateRun(result.document)).ok, true);
});

test("bounded command execution distinguishes timeout, overflow, and functional exit", async () => {
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
  const sha = comparisonBases.get(target);
  const result = await runEngineeringGates(target, { comparisonBase: sha, executors: executorSet() });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.document.comparison_base, {
    supplied_sha: sha,
    effective_merge_base_sha: sha,
  });
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
  const unknown = await runConfiguredGates(target);
  assert.equal(unknown.exitCode, 2);
  assert.equal(unknown.document.results[3].reason_code, "GOVERNANCE_UNTRUSTWORTHY");
  assert.equal(unknown.document.results.slice(4).every((item) => item.status === "not_run"), true);
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
});
