import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import test from "./classified-test.js";
import {
  validateAgentResult,
  validateAgentResultText,
  validateGovernanceCatalog,
  validateGovernanceCheckResult,
  validateGovernanceDocument,
  validateEngineeringQualityProfile,
} from "../src/governance-validator.js";

const root = new URL("../", import.meta.url);
const schemasUrl = new URL("governance/schemas/v1/", root);
const examplesUrl = new URL("governance/examples/v1/", root);
const catalogUrl = new URL("governance/rules/v1/catalog.json", root);
const registryUrl = new URL("governance/checks/v1/registry.json", root);
const qualityProfileUrl = new URL("governance/profiles/v1/engineering-quality-profile.json", root);

async function readJson(url) {
  return JSON.parse(await fs.readFile(url, "utf8"));
}

test("all governance schemas compile in strict Draft 2020-12 mode", async () => {
  const files = (await fs.readdir(schemasUrl))
    .filter((name) => name.endsWith(".schema.json"))
    .sort();

  for (const file of files) {
    const result = await validateGovernanceDocument(file, {});
    assert.equal(typeof result.valid, "boolean", file);
  }
});

test("canonical Engineering Quality Profile v1 is strict, approved, and trust-bound", async () => {
  const profile = await readJson(qualityProfileUrl);
  assert.equal((await validateEngineeringQualityProfile(profile)).ok, true);
  assert.equal(profile.metrics.cyclomatic_complexity.maximum, 15);
  assert.deepEqual(profile.metrics.coverage.repository_wide, {
    lines: 85,
    branches: 80,
    functions: 85,
    statements: 85,
  });
  assert.deepEqual(profile.metrics.coverage.changed_code, {
    lines: 90,
    branches: 85,
    functions: 90,
    statements: 90,
  });

  const weakened = structuredClone(profile);
  weakened.metrics.cyclomatic_complexity.maximum = 16;
  assert.equal((await validateEngineeringQualityProfile(weakened)).ok, false);

  const unsupported = structuredClone(profile);
  unsupported.profile_version = "2.0.0";
  assert.equal((await validateEngineeringQualityProfile(unsupported)).ok, false);

  const extra = structuredClone(profile);
  extra.baseline = "legacy";
  assert.equal((await validateEngineeringQualityProfile(extra)).ok, false);
});

test("governance examples satisfy their schemas and cross-reference integrity", async () => {
  const agentResult = await readJson(new URL("architecture-review-result.json", examplesUrl));
  const rule = await readJson(new URL("approved-architecture-rule.json", examplesUrl));
  const exception = await readJson(new URL("active-rule-exception.json", examplesUrl));

  assert.deepEqual(await validateAgentResult(agentResult, {
    expectedAgent: "architecture-reviewer",
  }), { ok: true, value: agentResult, errors: [] });
  assert.equal((await validateGovernanceDocument("rule.schema.json", rule)).valid, true);
  assert.equal((await validateGovernanceDocument("exception.schema.json", exception)).valid, true);
});

test("candidate, unverified, or unreproduced findings cannot recommend a blocking gate effect", async () => {
  const result = await readJson(new URL("architecture-review-result.json", examplesUrl));
  const finding = result.findings[0];

  const candidate = structuredClone(finding);
  candidate.rule_status = "candidate";
  assert.equal((await validateGovernanceDocument("finding.schema.json", candidate)).valid, false);

  const unverified = structuredClone(finding);
  unverified.validation_status = "unverified";
  assert.equal((await validateGovernanceDocument("finding.schema.json", unverified)).valid, false);

  const notReproduced = structuredClone(finding);
  notReproduced.validation_status = "not_reproduced";
  assert.equal((await validateGovernanceDocument("finding.schema.json", notReproduced)).valid, false);
});

test("a passing gate cannot retain blocking findings", async () => {
  const result = await readJson(new URL("architecture-review-result.json", examplesUrl));
  const gate = structuredClone(result.gate_decisions[0]);
  gate.status = "pass";

  assert.equal((await validateGovernanceDocument("gate-decision.schema.json", gate)).valid, false);
});

test("a gate cannot pass by omitting an eligible blocking finding", async () => {
  const result = await readJson(new URL("architecture-review-result.json", examplesUrl));
  result.gate_decisions[0].status = "pass";
  result.gate_decisions[0].blocking_finding_ids = [];

  const validation = await validateAgentResult(result, { expectedAgent: "architecture-reviewer" });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join(" "), /eligible blocking finding/);
});

test("approved rules and exceptions require human authority", async () => {
  const rule = await readJson(new URL("approved-architecture-rule.json", examplesUrl));
  const exception = await readJson(new URL("active-rule-exception.json", examplesUrl));

  delete rule.approval;
  assert.equal((await validateGovernanceDocument("rule.schema.json", rule)).valid, false);

  exception.approved_by = {
    kind: "agent",
    id: "architecture_reviewer",
    role: "architecture_reviewer",
    runtime: "codex",
  };
  assert.equal((await validateGovernanceDocument("exception.schema.json", exception)).valid, false);
});

test("evidence rejects raw output fields and inconsistent redaction metadata", async () => {
  const result = await readJson(new URL("architecture-review-result.json", examplesUrl));
  const evidence = result.evidence[0];

  const rawOutput = structuredClone(evidence);
  rawOutput.raw_output = "unbounded command output";
  assert.equal((await validateGovernanceDocument("evidence.schema.json", rawOutput)).valid, false);

  const inconsistentRedaction = structuredClone(evidence);
  inconsistentRedaction.redaction.categories = ["secret"];
  assert.equal((await validateGovernanceDocument("evidence.schema.json", inconsistentRedaction)).valid, false);
});

test("pure JSON parser rejects markdown fences and surrounding prose", async () => {
  const result = await readJson(new URL("architecture-review-result.json", examplesUrl));
  const json = JSON.stringify(result);

  assert.equal((await validateAgentResultText(`\`\`\`json\n${json}\n\`\`\``)).ok, false);
  assert.equal((await validateAgentResultText(`Review complete.\n${json}`)).ok, false);
});

test("review validation rejects role, non-Codex runtime, gate count, and reference mismatches", async () => {
  const base = await readJson(new URL("architecture-review-result.json", examplesUrl));

  assert.deepEqual(
    (await validateAgentResult(base, { expectedAgent: "tester-reviewer" })).errors,
    [
      "producer role does not match the expected agent",
      "producer identifier does not match the expected agent",
      "gate type does not match the expected review agent",
    ],
  );
  const wrongRuntime = structuredClone(base);
  wrongRuntime.producer.runtime = "ci";
  assert.equal((await validateAgentResult(wrongRuntime, { expectedAgent: "architecture-reviewer" })).ok, false);

  const noGate = structuredClone(base);
  noGate.gate_decisions = [];
  assert.deepEqual(
    (await validateAgentResult(noGate, { expectedAgent: "architecture-reviewer" })).errors,
    ["review agents must emit exactly one gate decision"],
  );

  const dangling = structuredClone(base);
  dangling.findings[0].evidence_ids = ["evidence:missing"];
  dangling.gate_decisions[0].blocking_finding_ids = ["finding:missing"];
  assert.deepEqual(
    (await validateAgentResult(dangling, { expectedAgent: "architecture-reviewer" })).errors,
    [
      "finding references missing evidence",
      "gate omits finding evidence",
      "gate omits an eligible blocking finding",
      "blocking finding is absent from gate findings",
    ],
  );

  const omitted = structuredClone(base);
  omitted.gate_decisions[0].finding_ids = [];
  omitted.gate_decisions[0].evaluated_rule_ids = [];
  omitted.gate_decisions[0].evidence_ids = ["evidence:unrelated"];
  omitted.evidence.push({
    ...structuredClone(base.evidence[0]),
    evidence_id: "evidence:unrelated",
  });
  assert.deepEqual(
    (await validateAgentResult(omitted, { expectedAgent: "architecture-reviewer" })).errors,
    ["gate omits a reported finding", "gate omits a finding rule", "gate omits finding evidence", "blocking finding is absent from gate findings"],
  );
});

test("validation errors do not echo rejected payload values", async () => {
  const result = await readJson(new URL("architecture-review-result.json", examplesUrl));
  result.evidence[0].raw_output = "SECRET_VALUE_MUST_NOT_BE_ECHOED";

  const validation = await validateAgentResult(result);
  assert.equal(validation.ok, false);
  assert.equal(validation.errors.join(" ").includes("SECRET_VALUE_MUST_NOT_BE_ECHOED"), false);
});

test("CLI validates files and stdin with expected provenance", async () => {
  const cli = new URL("../bin/sdd-codegraph.js", import.meta.url);
  const example = new URL("architecture-review-result.json", examplesUrl);
  const fileResult = execFileSync(process.execPath, [
    cli.pathname,
    "validate-result",
    example.pathname,
    "--agent",
    "architecture-reviewer",
  ], { encoding: "utf8" });
  assert.match(fileResult, /Governance result valid for architecture_reviewer/);

  const input = await fs.readFile(example, "utf8");
  const stdinResult = execFileSync(process.execPath, [
    cli.pathname,
    "validate-result",
    "-",
    "--agent",
    "architecture-reviewer",
  ], { encoding: "utf8", input });
  assert.match(stdinResult, /gate status: fail/);

  const removedOption = spawnSync(process.execPath, [
    cli.pathname,
    "validate-result",
    example.pathname,
    "--runtime",
    "codex",
  ], { encoding: "utf8" });
  assert.equal(removedOption.status, 1);
  assert.match(removedOption.stderr, /Unexpected argument/);
});

test("versioned governance catalog and check registry are valid and linked", async () => {
  const catalog = await readJson(catalogUrl);
  const registry = await readJson(registryUrl);
  const validation = await validateGovernanceCatalog(catalog, registry);

  assert.deepEqual(validation, { ok: true, value: catalog, errors: [] });
  assert.deepEqual(
    catalog.rules.filter((rule) => rule.status === "approved"
      && rule.enforcement.mode === "deterministic"
      && rule.enforcement.gate_effect === "block")
      .map((rule) => rule.rule_id),
    [
      "GOV-CATALOG-INTEGRITY-001",
      "GOV-CODEX-ROLE-CATALOG-001",
      "GOV-REVIEW-REPORTONLY-001",
      "GOV-REVIEW-HANDOFF-001",
      "GOV-PIPELINE-ORDER-001",
      "GOV-MANAGED-PROMPT-PROTECTION-001",
      "ENG-SOURCE-SYNTAX-001",
      "SEC-PRODUCTION-DEPS-001",
      "ENG-PACKAGE-SURFACE-001",
      "GOV-FORBIDDEN-SURFACE-001",
      "ENG-LINT-ERRORS-001",
      "ENG-CYCLOMATIC-COMPLEXITY-001",
      "TEST-UNIT-SUITE-001",
      "TEST-INTEGRATION-SUITE-001",
      "TEST-COVERAGE-GLOBAL-001",
      "TEST-COVERAGE-CHANGED-001",
      "ARCH-NO-CYCLES-001",
      "ARCH-PROD-NO-TEST-001",
      "ARCH-SRC-NO-BIN-001",
      "ARCH-IMPORT-RESOLUTION-001",
      "ARCH-PROD-NO-DEV-DEPS-001",
    ],
  );
  assert.equal(
    catalog.rules.find((rule) => rule.rule_id === "GOV-REMEDIATION-LOOP-001").enforcement.gate_effect,
    "warn",
  );
  const approvedInventory = [
    "GOV-ORCHESTRATOR-AUTHORITY-001",
    "GOV-ROLE-CAPABILITY-001",
    "GOV-ARCH-REVIEW-SCOPE-001",
    "GOV-SECURITY-ACTIVE-001",
    "ENG-IMPLEMENTER-TDD-001",
    "GOV-FAILED-GATE-001",
    "GOV-DETERMINISTIC-PRECEDENCE-001",
    "GOV-EVIDENCE-SAFE-001",
    "GOV-CANDIDATE-NONBLOCKING-001",
    "GOV-HUMAN-AUTHORITY-001",
    "GOV-EXCEPTION-LIFECYCLE-001",
    "GOV-CHECK-RULE-LINK-001",
    "GOV-INSTALL-PARITY-001",
  ];
  assert.deepEqual(
    approvedInventory.filter((ruleId) => catalog.rules.find((rule) => rule.rule_id === ruleId)?.status !== "approved"),
    [],
  );
  assert.equal(catalog.rules.find((rule) => rule.rule_id === "GOV-ARCH-REVIEW-SCOPE-001").enforcement.gate_effect, "warn");
  assert.equal(catalog.rules.find((rule) => rule.rule_id === "ENG-IMPLEMENTER-TDD-001").enforcement.gate_effect, "warn");
  assert.equal(catalog.rules.find((rule) => rule.rule_id === "GOV-REVIEW-REPORTONLY-001").version, 2);
  assert.equal(catalog.rules.find((rule) => rule.rule_id === "GOV-REVIEW-HANDOFF-001").version, 2);
  assert.equal(catalog.rules.find((rule) => rule.rule_id === "GOV-ROLE-CAPABILITY-001").version, 2);
  assert.equal(catalog.rules.find((rule) => rule.rule_id === "GOV-SECURITY-ACTIVE-001").version, 2);
  assert.equal(catalog.rules.find((rule) => rule.rule_id === "ENG-IMPLEMENTER-TDD-001").version, 2);
  assert.ok(approvedInventory
    .filter((ruleId) => !["GOV-ARCH-REVIEW-SCOPE-001", "ENG-IMPLEMENTER-TDD-001"].includes(ruleId))
    .every((ruleId) => catalog.rules.find((rule) => rule.rule_id === ruleId).enforcement.gate_effect === "block"));
  assert.ok(catalog.rules.filter((rule) => rule.status === "proposed")
    .every((rule) => rule.enforcement.gate_effect === "none"));
});

test("engineering gate registry safety limits are exact trusted bindings", async () => {
  const catalog = await readJson(catalogUrl);
  const registry = await readJson(registryUrl);
  const gateRegistry = await readJson(new URL("governance/gates/v1/registry.json", root));
  assert.equal(gateRegistry.executors.find((executor) => executor.executor_id === "coverage").timeout_ms, 180000);
  assert.equal(
    gateRegistry.executors.find((executor) => executor.executor_id === "production_dependency_audit").timeout_ms,
    120000,
  );
  gateRegistry.executors[0].timeout_ms += 1;
  const validation = await validateGovernanceCatalog(catalog, registry, gateRegistry);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("engineering gate registry binding does not match trusted code"));
});

test("catalog integrity rejects invalid documents, duplicate rules, proposed blocks, missing human approval, and orphan checks", async () => {
  const catalog = await readJson(catalogUrl);
  const registry = await readJson(registryUrl);

  assert.equal((await validateGovernanceCatalog({ schema_version: "1.0.0" }, registry)).ok, false);

  const duplicate = structuredClone(catalog);
  duplicate.rules.push(structuredClone(duplicate.rules[0]));
  assert.match((await validateGovernanceCatalog(duplicate, registry)).errors.join(" "), /duplicate rule identifier/);

  const proposedBlock = structuredClone(catalog);
  const proposed = proposedBlock.rules.find((rule) => rule.status === "proposed");
  proposed.enforcement.gate_effect = "block";
  assert.equal((await validateGovernanceCatalog(proposedBlock, registry)).ok, false);

  const missingAuthority = structuredClone(catalog);
  delete missingAuthority.rules.find((rule) => rule.status === "approved").approval;
  assert.equal((await validateGovernanceCatalog(missingAuthority, registry)).ok, false);

  const orphan = structuredClone(registry);
  orphan.checks[0].rule_id = "GOV-NOT-REGISTERED-999";
  assert.match((await validateGovernanceCatalog(catalog, orphan)).errors.join(" "), /check references missing rule/);

  for (const mutate of [
    (value) => { [value.checks[0].implementation, value.checks[1].implementation] = [value.checks[1].implementation, value.checks[0].implementation]; },
    (value) => { value.checks[0].implementation = value.checks[1].implementation; },
    (value) => { value.checks.pop(); },
    (value) => { value.checks.push(structuredClone(value.checks[0])); },
    (value) => { value.checks[0].check_id = "unknown_check"; },
  ]) {
    const rebound = structuredClone(registry);
    mutate(rebound);
    assert.equal((await validateGovernanceCatalog(catalog, rebound)).ok, false);
  }

  const unknownApprover = structuredClone(catalog);
  unknownApprover.rules.find((rule) => rule.status === "approved").approval.approved_by.id = "self_asserted";
  assert.equal((await validateGovernanceCatalog(unknownApprover, registry)).ok, false);

  const unknownReference = structuredClone(catalog);
  unknownReference.rules.find((rule) => rule.status === "approved").approval.reference = "conversation:untrusted";
  assert.equal((await validateGovernanceCatalog(unknownReference, registry)).ok, false);

  const changedContent = structuredClone(catalog);
  changedContent.rules.find((rule) => rule.status === "approved").title = "Self-approved changed content";
  assert.equal((await validateGovernanceCatalog(changedContent, registry)).ok, false);

  const changedVersion = structuredClone(catalog);
  changedVersion.rules.find((rule) => rule.status === "approved").version += 1;
  assert.equal((await validateGovernanceCatalog(changedVersion, registry)).ok, false);

  const unboundApproved = structuredClone(catalog);
  const extra = structuredClone(unboundApproved.rules.find((rule) => rule.status === "approved"));
  extra.rule_id = "GOV-UNBOUND-APPROVED-001";
  unboundApproved.rules.push(extra);
  assert.equal((await validateGovernanceCatalog(unboundApproved, registry)).ok, false);

  const missingTrustedApproved = structuredClone(catalog);
  missingTrustedApproved.rules = missingTrustedApproved.rules
    .filter((rule) => rule.rule_id !== "GOV-ORCHESTRATOR-AUTHORITY-001");
  assert.match(
    (await validateGovernanceCatalog(missingTrustedApproved, registry)).errors.join(" "),
    /approved rule set does not match trusted code/,
  );

  const downgradedToProposed = structuredClone(catalog);
  const proposedDowngrade = downgradedToProposed.rules
    .find((rule) => rule.rule_id === "GOV-ORCHESTRATOR-AUTHORITY-001");
  proposedDowngrade.status = "proposed";
  proposedDowngrade.enforcement.gate_effect = "none";
  delete proposedDowngrade.approval;
  assert.match(
    (await validateGovernanceCatalog(downgradedToProposed, registry)).errors.join(" "),
    /approved rule set does not match trusted code/,
  );

  const changedToDeprecated = structuredClone(catalog);
  changedToDeprecated.rules.find((rule) => rule.rule_id === "GOV-ORCHESTRATOR-AUTHORITY-001").status = "deprecated";
  assert.match(
    (await validateGovernanceCatalog(changedToDeprecated, registry)).errors.join(" "),
    /approved rule set does not match trusted code/,
  );

  const changedProposed = structuredClone(catalog);
  changedProposed.rules.find((rule) => rule.status === "proposed").title = "Changed proposed guidance";
  assert.equal((await validateGovernanceCatalog(changedProposed, registry)).ok, true);

  const reactivatedLegacy = structuredClone(catalog);
  const legacy = reactivatedLegacy.rules.find((rule) => rule.rule_id === "ENG-TEST-SUITE-001");
  legacy.enforcement = {
    mode: "deterministic",
    gate_effect: "block",
    automation: { engine: "sdd_engineering_gates", check_id: "test_suite" },
  };
  assert.match(
    (await validateGovernanceCatalog(reactivatedLegacy, registry)).errors.join(" "),
    /deprecated rule retains an active deterministic binding/,
  );
});

test("deterministic check results require bounded evidence linked to rule and check", async () => {
  const result = await readJson(new URL("governance-check-result.json", examplesUrl));
  assert.deepEqual(await validateGovernanceCheckResult(result), { ok: true, value: result, errors: [] });

  const missingEvidence = structuredClone(result);
  missingEvidence.results[0].evidence_ids = [];
  assert.equal((await validateGovernanceCheckResult(missingEvidence)).ok, false);

  const dangling = structuredClone(result);
  dangling.results[0].evidence_ids = ["evidence:missing"];
  assert.match((await validateGovernanceCheckResult(dangling)).errors.join(" "), /check references missing evidence/);

  const passedWithFailure = structuredClone(result);
  passedWithFailure.results[0].status = "fail";
  assert.match((await validateGovernanceCheckResult(passedWithFailure)).errors.join(" "), /outcome does not match check results/);

  const failedWithoutFailure = structuredClone(result);
  failedWithoutFailure.outcome = "failed";
  assert.match((await validateGovernanceCheckResult(failedWithoutFailure)).errors.join(" "), /outcome does not match check results/);

  const mismatchedEvidence = structuredClone(result);
  mismatchedEvidence.evidence[0].check_id = "another_check";
  assert.match((await validateGovernanceCheckResult(mismatchedEvidence)).errors.join(" "), /evidence belongs to another check/);
});
