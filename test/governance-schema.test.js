import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import test from "node:test";
import {
  validateAgentResult,
  validateAgentResultText,
  validateGovernanceDocument,
} from "../src/governance-validator.js";

const root = new URL("../", import.meta.url);
const schemasUrl = new URL("governance/schemas/v1/", root);
const examplesUrl = new URL("governance/examples/v1/", root);

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

test("governance examples satisfy their schemas and cross-reference integrity", async () => {
  const agentResult = await readJson(new URL("architecture-review-result.json", examplesUrl));
  const rule = await readJson(new URL("approved-architecture-rule.json", examplesUrl));
  const exception = await readJson(new URL("active-rule-exception.json", examplesUrl));

  assert.deepEqual(await validateAgentResult(agentResult, {
    expectedAgent: "architecture-reviewer",
    expectedRuntime: "codex",
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

test("review validation rejects role, runtime, gate count, and reference mismatches", async () => {
  const base = await readJson(new URL("architecture-review-result.json", examplesUrl));

  assert.deepEqual(
    (await validateAgentResult(base, { expectedAgent: "tester-reviewer" })).errors,
    [
      "producer role does not match the expected agent",
      "producer identifier does not match the expected agent",
      "gate type does not match the expected review agent",
    ],
  );
  assert.deepEqual(
    (await validateAgentResult(base, { expectedAgent: "architecture-reviewer", expectedRuntime: "pi" })).errors,
    ["producer runtime does not match the expected runtime"],
  );

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
    ["finding references missing evidence", "gate omits finding evidence", "blocking finding is absent from gate findings"],
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
    "--runtime",
    "codex",
  ], { encoding: "utf8" });
  assert.match(fileResult, /Governance result valid for architecture_reviewer/);

  const input = await fs.readFile(example, "utf8");
  const stdinResult = execFileSync(process.execPath, [
    cli.pathname,
    "validate-result",
    "-",
    "--agent",
    "architecture-reviewer",
    "--runtime",
    "codex",
  ], { encoding: "utf8", input });
  assert.match(stdinResult, /gate status: fail/);
});
