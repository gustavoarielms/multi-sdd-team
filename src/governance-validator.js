import fs from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import {
  APPROVED_GOVERNANCE_RULES,
  CANONICAL_GOVERNANCE_CHECK_BINDINGS,
  GOVERNANCE_APPROVAL_AUTHORITY,
  governanceRuleDigest,
} from "./governance-trust.js";

const schemasUrl = new URL("../governance/schemas/v1/", import.meta.url);
const agentResultSchemaName = "agent-result.schema.json";
const ruleCatalogSchemaName = "rule-catalog.schema.json";
const checkRegistrySchemaName = "check-registry.schema.json";
const governanceCheckResultSchemaName = "governance-check-result.schema.json";

const reviewGateTypes = new Map([
  ["architecture_reviewer", "architecture"],
  ["tester_reviewer", "quality"],
  ["hacker", "security"],
]);

let validatorPromise;

export function normalizeAgentName(name) {
  return String(name ?? "").replaceAll("-", "_");
}

export function isStructuredReviewAgent(name) {
  return reviewGateTypes.has(normalizeAgentName(name));
}

function formatSchemaErrors(errors = []) {
  return errors.map((error) => {
    const location = error.instancePath || "/";
    return `schema ${location}: ${error.message ?? error.keyword}`;
  });
}

async function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const files = (await fs.readdir(schemasUrl))
    .filter((name) => name.endsWith(".schema.json"))
    .sort();
  const schemas = new Map();

  for (const file of files) {
    const schema = JSON.parse(await fs.readFile(new URL(file, schemasUrl), "utf8"));
    if (!ajv.validateSchema(schema)) {
      throw new Error(`Invalid governance schema ${file}: ${ajv.errorsText()}`);
    }
    ajv.addSchema(schema);
    schemas.set(file, schema);
  }

  return {
    validate(schemaName, value) {
      const schema = schemas.get(schemaName);
      if (!schema) throw new Error(`Unknown governance schema: ${schemaName}`);
      const validate = ajv.getSchema(schema.$id);
      if (!validate) throw new Error(`Governance schema was not compiled: ${schemaName}`);
      const valid = validate(value);
      return { valid, errors: valid ? [] : formatSchemaErrors(validate.errors) };
    },
  };
}

async function getValidator() {
  validatorPromise ??= createValidator();
  return validatorPromise;
}

export async function validateGovernanceDocument(schemaName, value) {
  const validator = await getValidator();
  return validator.validate(schemaName, value);
}

function validateAgentResultIntegrity(result, expectedAgent, expectedRuntime) {
  const errors = [];
  const evidenceIds = new Set();
  const findingIds = new Set();
  const gateIds = new Set();
  const normalizedAgent = expectedAgent ? normalizeAgentName(expectedAgent) : null;

  if (normalizedAgent && result.producer.role !== normalizedAgent) {
    errors.push("producer role does not match the expected agent");
  }
  if (normalizedAgent && normalizeAgentName(result.producer.id) !== normalizedAgent) {
    errors.push("producer identifier does not match the expected agent");
  }

  if (expectedRuntime && result.producer.runtime !== expectedRuntime) {
    errors.push("producer runtime does not match the expected runtime");
  }

  if (normalizedAgent && reviewGateTypes.has(normalizedAgent) && result.gate_decisions.length !== 1) {
    errors.push("review agents must emit exactly one gate decision");
  }

  for (const evidence of result.evidence) {
    if (evidenceIds.has(evidence.evidence_id)) errors.push("duplicate evidence identifier");
    evidenceIds.add(evidence.evidence_id);
  }

  for (const finding of result.findings) {
    if (findingIds.has(finding.finding_id)) errors.push("duplicate finding identifier");
    findingIds.add(finding.finding_id);
    for (const evidenceId of finding.evidence_ids) {
      if (!evidenceIds.has(evidenceId)) errors.push("finding references missing evidence");
    }
    if (finding.reported_by.role !== result.producer.role) {
      errors.push("finding reporter role does not match the producer");
    }
    if (finding.reported_by.id !== result.producer.id) {
      errors.push("finding reporter identifier does not match the producer");
    }
    if (finding.reported_by.runtime !== result.producer.runtime) {
      errors.push("finding reporter runtime does not match the producer");
    }
  }

  for (const gate of result.gate_decisions) {
    if (gateIds.has(gate.gate_id)) errors.push("duplicate gate identifier");
    gateIds.add(gate.gate_id);
    if (gate.run_id !== result.run_id) errors.push("gate references another run");
    if (gate.decided_by.role !== result.producer.role) {
      errors.push("gate decision role does not match the producer");
    }
    if (gate.decided_by.id !== result.producer.id) {
      errors.push("gate decision identifier does not match the producer");
    }
    if (gate.decided_by.runtime !== result.producer.runtime) {
      errors.push("gate decision runtime does not match the producer");
    }
    if (normalizedAgent && reviewGateTypes.has(normalizedAgent) && gate.gate_type !== reviewGateTypes.get(normalizedAgent)) {
      errors.push("gate type does not match the expected review agent");
    }
    for (const findingId of gate.finding_ids) {
      if (!findingIds.has(findingId)) errors.push("gate references missing finding");
    }
    for (const finding of result.findings) {
      if (!gate.finding_ids.includes(finding.finding_id)) errors.push("gate omits a reported finding");
      if (!gate.evaluated_rule_ids.includes(finding.rule_id)) errors.push("gate omits a finding rule");
      for (const evidenceId of finding.evidence_ids) {
        if (!gate.evidence_ids.includes(evidenceId)) errors.push("gate omits finding evidence");
      }
    }
    for (const evidenceId of gate.evidence_ids) {
      if (!evidenceIds.has(evidenceId)) errors.push("gate references missing evidence");
    }
    for (const findingId of gate.blocking_finding_ids) {
      if (!gate.finding_ids.includes(findingId)) errors.push("blocking finding is absent from gate findings");
      const finding = result.findings.find((candidate) => candidate.finding_id === findingId);
      if (!finding) continue;
      if (finding.rule_status !== "approved") errors.push("blocking finding uses an unapproved rule");
      if (finding.validation_status !== "verified") errors.push("blocking finding is not verified");
      if (finding.status !== "open") errors.push("blocking finding is not open");
      if (finding.recommended_gate_effect !== "block") errors.push("blocking finding does not recommend blocking");
    }
  }

  for (const findingId of result.handoff.unresolved_finding_ids) {
    const finding = result.findings.find((candidate) => candidate.finding_id === findingId);
    if (!finding) errors.push("handoff references missing finding");
    else if (finding.status !== "open") errors.push("handoff references a non-open finding");
  }

  return errors;
}

export async function validateAgentResult(value, { expectedAgent, expectedRuntime } = {}) {
  const structural = await validateGovernanceDocument(agentResultSchemaName, value);
  if (!structural.valid) return { ok: false, errors: structural.errors };

  const errors = validateAgentResultIntegrity(value, expectedAgent, expectedRuntime);
  return errors.length === 0
    ? { ok: true, value, errors: [] }
    : { ok: false, errors };
}

export async function validateAgentResultText(text, options = {}) {
  let value;
  try {
    value = JSON.parse(String(text).trim());
  } catch {
    return { ok: false, errors: ["output must be exactly one valid JSON object"] };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["output must be exactly one JSON object"] };
  }

  return validateAgentResult(value, options);
}

export async function validateGovernanceCatalog(catalog, registry) {
  const [catalogStructure, registryStructure] = await Promise.all([
    validateGovernanceDocument(ruleCatalogSchemaName, catalog),
    validateGovernanceDocument(checkRegistrySchemaName, registry),
  ]);
  const errors = [...catalogStructure.errors, ...registryStructure.errors];
  if (!catalogStructure.valid || !registryStructure.valid) return { ok: false, errors };

  const ruleIds = new Set();
  const checksById = new Map();
  for (const rule of catalog.rules) {
    if (ruleIds.has(rule.rule_id)) errors.push("duplicate rule identifier");
    ruleIds.add(rule.rule_id);
  }

  for (const check of registry.checks) {
    if (checksById.has(check.check_id)) errors.push("duplicate check identifier");
    checksById.set(check.check_id, check);
    if (!ruleIds.has(check.rule_id)) errors.push("check references missing rule");
  }

  const canonicalCheckIds = Object.keys(CANONICAL_GOVERNANCE_CHECK_BINDINGS);
  if (registry.checks.length !== canonicalCheckIds.length) errors.push("check registry does not contain the canonical bindings");
  for (const checkId of canonicalCheckIds) {
    const expected = CANONICAL_GOVERNANCE_CHECK_BINDINGS[checkId];
    const actual = registry.checks.find((check) => check.check_id === checkId);
    if (!actual || actual.rule_id !== expected.rule_id || actual.implementation !== expected.implementation) {
      errors.push("check registry binding does not match trusted code");
    }
  }

  for (const rule of catalog.rules) {
    if (rule.enforcement.mode !== "deterministic") continue;
    const check = checksById.get(rule.enforcement.automation.check_id);
    if (!check) errors.push("deterministic rule references missing check");
    else if (check.rule_id !== rule.rule_id) errors.push("deterministic check references another rule");
  }


  const trustedApprovedRuleIds = new Set(Object.keys(APPROVED_GOVERNANCE_RULES));
  const catalogApprovedRuleIds = new Set(
    catalog.rules.filter((candidate) => candidate.status === "approved").map((rule) => rule.rule_id),
  );
  if (trustedApprovedRuleIds.size !== catalogApprovedRuleIds.size
    || [...trustedApprovedRuleIds].some((ruleId) => !catalogApprovedRuleIds.has(ruleId))
    || [...catalogApprovedRuleIds].some((ruleId) => !trustedApprovedRuleIds.has(ruleId))) {
    errors.push("approved rule set does not match trusted code");
  }

  for (const rule of catalog.rules.filter((candidate) => candidate.status === "approved")) {
    const trusted = APPROVED_GOVERNANCE_RULES[rule.rule_id];
    if (rule.approval.approved_by.id !== GOVERNANCE_APPROVAL_AUTHORITY.id
      || rule.approval.reference !== GOVERNANCE_APPROVAL_AUTHORITY.reference) {
      errors.push("approved rule authority does not match trusted code");
    }
    if (!trusted) {
      errors.push("approved rule has no trusted binding");
      continue;
    }
    if (rule.version !== trusted.version || governanceRuleDigest(rule) !== trusted.digest) {
      errors.push("approved rule content does not match trusted binding");
    }
  }

  return errors.length === 0
    ? { ok: true, value: catalog, errors: [] }
    : { ok: false, errors };
}

export async function validateGovernanceCheckResult(value) {
  const structural = await validateGovernanceDocument(governanceCheckResultSchemaName, value);
  if (!structural.valid) return { ok: false, errors: structural.errors };

  const errors = [];
  const evidenceIds = new Set();
  const resultIds = new Set();
  for (const evidence of value.evidence) {
    if (evidenceIds.has(evidence.evidence_id)) errors.push("duplicate evidence identifier");
    evidenceIds.add(evidence.evidence_id);
  }
  for (const result of value.results) {
    if (resultIds.has(result.check_id)) errors.push("duplicate check result identifier");
    resultIds.add(result.check_id);
    for (const evidenceId of result.evidence_ids) {
      if (!evidenceIds.has(evidenceId)) {
        errors.push("check references missing evidence");
        continue;
      }
      const evidence = value.evidence.find((candidate) => candidate.evidence_id === evidenceId);
      if (evidence.check_id !== result.check_id) errors.push("check evidence belongs to another check");
    }
  }

  const allPassed = value.results.every((result) => result.status === "pass");
  if ((value.outcome === "passed") !== allPassed) errors.push("outcome does not match check results");

  return errors.length === 0
    ? { ok: true, value, errors: [] }
    : { ok: false, errors };
}
