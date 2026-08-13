import fs from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";

const schemasUrl = new URL("../governance/schemas/v1/", import.meta.url);
const agentResultSchemaName = "agent-result.schema.json";

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
