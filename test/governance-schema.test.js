import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const root = new URL("../", import.meta.url);
const schemasUrl = new URL("governance/schemas/v1/", root);
const examplesUrl = new URL("governance/examples/v1/", root);

async function readJson(url) {
  return JSON.parse(await fs.readFile(url, "utf8"));
}

async function loadValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const files = (await fs.readdir(schemasUrl))
    .filter((name) => name.endsWith(".schema.json"))
    .sort();
  const schemas = new Map();

  for (const file of files) {
    const schema = await readJson(new URL(file, schemasUrl));
    assert.equal(ajv.validateSchema(schema), true, `${file}: ${ajv.errorsText()}`);
    ajv.addSchema(schema);
    schemas.set(file, schema);
  }

  return {
    ajv,
    validate(file, value) {
      const schema = schemas.get(file);
      assert.ok(schema, `unknown schema ${file}`);
      const validator = ajv.getSchema(schema.$id);
      assert.ok(validator, `schema not compiled: ${file}`);
      return {
        valid: validator(value),
        errors: validator.errors,
      };
    },
  };
}

function validateAgentResultIntegrity(result) {
  const errors = [];
  const evidenceIds = new Set();
  const findingIds = new Set();

  for (const evidence of result.evidence) {
    if (evidenceIds.has(evidence.evidence_id)) errors.push(`duplicate evidence ${evidence.evidence_id}`);
    evidenceIds.add(evidence.evidence_id);
  }

  for (const finding of result.findings) {
    if (findingIds.has(finding.finding_id)) errors.push(`duplicate finding ${finding.finding_id}`);
    findingIds.add(finding.finding_id);
    for (const evidenceId of finding.evidence_ids) {
      if (!evidenceIds.has(evidenceId)) errors.push(`${finding.finding_id} references missing ${evidenceId}`);
    }
  }

  for (const gate of result.gate_decisions) {
    if (gate.run_id !== result.run_id) errors.push(`${gate.gate_id} references another run`);
    for (const findingId of gate.finding_ids) {
      if (!findingIds.has(findingId)) errors.push(`${gate.gate_id} references missing ${findingId}`);
    }
    for (const evidenceId of gate.evidence_ids) {
      if (!evidenceIds.has(evidenceId)) errors.push(`${gate.gate_id} references missing ${evidenceId}`);
    }
    for (const findingId of gate.blocking_finding_ids) {
      if (!gate.finding_ids.includes(findingId)) errors.push(`${findingId} is blocking but absent from gate findings`);
      const finding = result.findings.find((candidate) => candidate.finding_id === findingId);
      if (!finding) continue;
      if (finding.rule_status !== "approved") errors.push(`${findingId} uses an unapproved rule`);
      if (finding.validation_status !== "verified") errors.push(`${findingId} is not verified`);
      if (finding.status !== "open") errors.push(`${findingId} is not open`);
      if (finding.recommended_gate_effect !== "block") errors.push(`${findingId} was not recommended to block`);
    }
  }

  for (const findingId of result.handoff.unresolved_finding_ids) {
    const finding = result.findings.find((candidate) => candidate.finding_id === findingId);
    if (!finding) errors.push(`handoff references missing ${findingId}`);
    else if (finding.status !== "open") errors.push(`handoff references non-open ${findingId}`);
  }

  return errors;
}

test("all governance schemas are valid Draft 2020-12 schemas", async () => {
  const { ajv } = await loadValidator();
  assert.ok(ajv);
});

test("governance examples satisfy their schemas and cross-reference integrity", async () => {
  const validator = await loadValidator();
  const agentResult = await readJson(new URL("architecture-review-result.json", examplesUrl));
  const rule = await readJson(new URL("approved-architecture-rule.json", examplesUrl));
  const exception = await readJson(new URL("active-rule-exception.json", examplesUrl));

  const resultValidation = validator.validate("agent-result.schema.json", agentResult);
  const ruleValidation = validator.validate("rule.schema.json", rule);
  const exceptionValidation = validator.validate("exception.schema.json", exception);

  assert.equal(resultValidation.valid, true, JSON.stringify(resultValidation.errors));
  assert.equal(ruleValidation.valid, true, JSON.stringify(ruleValidation.errors));
  assert.equal(exceptionValidation.valid, true, JSON.stringify(exceptionValidation.errors));
  assert.deepEqual(validateAgentResultIntegrity(agentResult), []);
});

test("candidate, unverified, or unreproduced findings cannot recommend a blocking gate effect", async () => {
  const validator = await loadValidator();
  const result = await readJson(new URL("architecture-review-result.json", examplesUrl));
  const finding = result.findings[0];

  const candidate = structuredClone(finding);
  candidate.rule_status = "candidate";
  assert.equal(validator.validate("finding.schema.json", candidate).valid, false);

  const unverified = structuredClone(finding);
  unverified.validation_status = "unverified";
  assert.equal(validator.validate("finding.schema.json", unverified).valid, false);

  const notReproduced = structuredClone(finding);
  notReproduced.validation_status = "not_reproduced";
  assert.equal(validator.validate("finding.schema.json", notReproduced).valid, false);
});

test("a passing gate cannot retain blocking findings", async () => {
  const validator = await loadValidator();
  const result = await readJson(new URL("architecture-review-result.json", examplesUrl));
  const gate = structuredClone(result.gate_decisions[0]);
  gate.status = "pass";

  assert.equal(validator.validate("gate-decision.schema.json", gate).valid, false);
});

test("approved rules and exceptions require human authority", async () => {
  const validator = await loadValidator();
  const rule = await readJson(new URL("approved-architecture-rule.json", examplesUrl));
  const exception = await readJson(new URL("active-rule-exception.json", examplesUrl));

  delete rule.approval;
  assert.equal(validator.validate("rule.schema.json", rule).valid, false);

  exception.approved_by = {
    kind: "agent",
    id: "architecture_reviewer",
    role: "architecture_reviewer",
    runtime: "codex",
  };
  assert.equal(validator.validate("exception.schema.json", exception).valid, false);
});

test("evidence rejects raw output fields and inconsistent redaction metadata", async () => {
  const validator = await loadValidator();
  const result = await readJson(new URL("architecture-review-result.json", examplesUrl));
  const evidence = result.evidence[0];

  const rawOutput = structuredClone(evidence);
  rawOutput.raw_output = "unbounded command output";
  assert.equal(validator.validate("evidence.schema.json", rawOutput).valid, false);

  const inconsistentRedaction = structuredClone(evidence);
  inconsistentRedaction.redaction.categories = ["secret"];
  assert.equal(validator.validate("evidence.schema.json", inconsistentRedaction).valid, false);
});

test("agent result integrity rejects dangling evidence and invalid blocking references", async () => {
  const result = await readJson(new URL("architecture-review-result.json", examplesUrl));
  result.findings[0].evidence_ids = ["evidence:missing"];
  result.gate_decisions[0].blocking_finding_ids = ["finding:missing"];

  assert.deepEqual(validateAgentResultIntegrity(result), [
    "finding:arch-boundary-001 references missing evidence:missing",
    "finding:missing is blocking but absent from gate findings",
  ]);
});
