import fs from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import {
  APPROVED_GOVERNANCE_RULES,
  CANONICAL_ENGINEERING_GATE_BINDINGS,
  CANONICAL_GOVERNANCE_CHECK_BINDINGS,
  ENGINEERING_QUALITY_PROFILE_TRUST,
  GOVERNANCE_APPROVAL_AUTHORITY,
  governanceDocumentDigest,
  governanceRuleDigest,
} from "./governance-trust.js";

const schemasUrl = new URL("../governance/schemas/v1/", import.meta.url);
const agentResultSchemaName = "agent-result.schema.json";
const ruleCatalogSchemaName = "rule-catalog.schema.json";
const checkRegistrySchemaName = "check-registry.schema.json";
const governanceCheckResultSchemaName = "governance-check-result.schema.json";
const engineeringGateConfigSchemaName = "engineering-gate-config.schema.json";
const engineeringGateRegistrySchemaName = "engineering-gate-registry.schema.json";
const engineeringGateRunSchemaName = "engineering-gate-run.schema.json";
const engineeringQualityProfileSchemaName = "engineering-quality-profile.schema.json";
const engineeringGateRegistryUrl = new URL("../governance/gates/v1/registry.json", import.meta.url);
const engineeringQualityProfileUrl = new URL("../governance/profiles/v1/engineering-quality-profile.json", import.meta.url);
const governanceCheckRegistryUrl = new URL("../governance/checks/v1/registry.json", import.meta.url);
const ruleCatalogUrl = new URL("../governance/rules/v1/catalog.json", import.meta.url);

const reviewGateTypes = new Map([
  ["architecture_reviewer", "architecture"],
  ["tester_reviewer", "quality"],
  ["hacker", "security"],
]);

let validatorPromise;
let engineeringGateRegistryPromise;
let engineeringQualityProfilePromise;

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

async function loadEngineeringGateRegistry() {
  engineeringGateRegistryPromise ??= fs.readFile(engineeringGateRegistryUrl, "utf8").then(JSON.parse);
  return engineeringGateRegistryPromise;
}

async function loadEngineeringQualityProfile() {
  engineeringQualityProfilePromise ??= fs.readFile(engineeringQualityProfileUrl, "utf8").then(JSON.parse);
  return engineeringQualityProfilePromise;
}

export function engineeringExecutorIds() {
  return Object.keys(CANONICAL_ENGINEERING_GATE_BINDINGS);
}

export async function validateEngineeringGateConfiguration(value) {
  return validateGovernanceDocument(engineeringGateConfigSchemaName, value);
}

function qualityProfileBindings(profile) {
  return new Map([
    ["lint", profile.metrics.lint.rule_id],
    ["cyclomatic_complexity", profile.metrics.cyclomatic_complexity.rule_id],
    ["unit_tests", profile.metrics.tests.unit.rule_id],
    ["integration_tests", profile.metrics.tests.integration.rule_id],
    ["coverage_global", profile.metrics.coverage.global_rule_id],
    ["coverage_changed", profile.metrics.coverage.changed_rule_id],
    ...profile.metrics.architecture.rules.map((rule) => [rule.condition, rule.rule_id]),
  ]);
}

export async function validateEngineeringQualityProfile(value, catalogValue) {
  const structural = await validateGovernanceDocument(engineeringQualityProfileSchemaName, value);
  if (!structural.valid) return { ok: false, errors: structural.errors };

  const errors = [];
  const trust = ENGINEERING_QUALITY_PROFILE_TRUST;
  if (value.profile_id !== trust.profile_id
    || value.profile_version !== trust.profile_version
    || value.adapter.adapter_id !== trust.adapter_id
    || value.adapter.adapter_version !== trust.adapter_version
    || governanceDocumentDigest(value) !== trust.digest) {
    errors.push("engineering quality profile does not match trusted code");
  }
  if (value.approval.approved_by.id !== GOVERNANCE_APPROVAL_AUTHORITY.id) {
    errors.push("engineering quality profile authority does not match trusted code");
  }

  const catalog = catalogValue ?? JSON.parse(await fs.readFile(ruleCatalogUrl, "utf8"));
  const rulesById = new Map(catalog.rules.map((rule) => [rule.rule_id, rule]));
  const bindings = qualityProfileBindings(value);
  if (JSON.stringify([...bindings.values()]) !== JSON.stringify(value.rule_ids)) {
    errors.push("engineering quality profile rule inventory is not canonical");
  }
  for (const [checkId, ruleId] of bindings) {
    const rule = rulesById.get(ruleId);
    if (!rule || rule.status !== "approved" || rule.enforcement.gate_effect !== "block") {
      errors.push("engineering quality profile references a non-blocking or unapproved rule");
      continue;
    }
    const automation = rule.enforcement.automation;
    if (automation?.engine !== "sdd_quality_profile" || automation.check_id !== checkId) {
      errors.push("engineering quality profile rule binding does not match the catalog");
    }
  }

  return errors.length === 0
    ? { ok: true, value, errors: [] }
    : { ok: false, errors };
}

async function validateEngineeringGateRegistry(catalog, registry) {
  const structural = await validateGovernanceDocument(engineeringGateRegistrySchemaName, registry);
  const errors = [...structural.errors];
  if (!structural.valid) return { ok: false, errors };

  const expectedIds = engineeringExecutorIds();
  const actualIds = registry.executors.map((executor) => executor.executor_id);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    errors.push("engineering gate registry does not contain the canonical executor order");
  }

  const rulesById = new Map(catalog.rules.map((rule) => [rule.rule_id, rule]));
  for (const executor of registry.executors) {
    const trusted = CANONICAL_ENGINEERING_GATE_BINDINGS[executor.executor_id];
    if (!trusted
      || executor.implementation !== trusted.implementation
      || JSON.stringify(executor.rule_ids) !== JSON.stringify(trusted.rule_ids)
      || executor.timeout_ms !== trusted.timeout_ms
      || executor.max_output_bytes !== trusted.max_output_bytes) {
      errors.push("engineering gate registry binding does not match trusted code");
    }
    for (const ruleId of executor.rule_ids) {
      if (!rulesById.has(ruleId)) errors.push("engineering gate references missing rule");
    }
  }
  return errors.length === 0 ? { ok: true, value: registry, errors: [] } : { ok: false, errors };
}

function validateAgentResultIntegrity(result, expectedAgent) {
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
      const mustBlock = finding.rule_status === "approved"
        && finding.validation_status === "verified"
        && finding.status === "open"
        && finding.recommended_gate_effect === "block";
      if (mustBlock && !gate.blocking_finding_ids.includes(finding.finding_id)) {
        errors.push("gate omits an eligible blocking finding");
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

export async function validateAgentResult(value, { expectedAgent } = {}) {
  const structural = await validateGovernanceDocument(agentResultSchemaName, value);
  if (!structural.valid) return { ok: false, errors: structural.errors };

  const errors = validateAgentResultIntegrity(value, expectedAgent);
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

export async function validateGovernanceCatalog(catalog, registry, engineeringGateRegistry, engineeringQualityProfile) {
  const gateRegistry = engineeringGateRegistry ?? await loadEngineeringGateRegistry();
  const qualityProfile = engineeringQualityProfile ?? await loadEngineeringQualityProfile();
  const [catalogStructure, registryStructure, gateRegistryStructure, qualityProfileStructure] = await Promise.all([
    validateGovernanceDocument(ruleCatalogSchemaName, catalog),
    validateGovernanceDocument(checkRegistrySchemaName, registry),
    validateGovernanceDocument(engineeringGateRegistrySchemaName, gateRegistry),
    validateGovernanceDocument(engineeringQualityProfileSchemaName, qualityProfile),
  ]);
  const errors = [
    ...catalogStructure.errors,
    ...registryStructure.errors,
    ...gateRegistryStructure.errors,
    ...qualityProfileStructure.errors,
  ];
  if (!catalogStructure.valid || !registryStructure.valid || !gateRegistryStructure.valid || !qualityProfileStructure.valid) {
    return { ok: false, errors };
  }

  const ruleIds = new Set();
  const checksById = new Map();
  const gatesById = new Map(gateRegistry.executors.map((executor) => [executor.executor_id, executor]));
  const qualityBindings = qualityProfileBindings(qualityProfile);
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
    const { engine, check_id: checkId } = rule.enforcement.automation;
    if (engine === "sdd_governance") {
      const check = checksById.get(checkId);
      if (!check) errors.push("deterministic rule references missing check");
      else if (check.rule_id !== rule.rule_id) errors.push("deterministic check references another rule");
      continue;
    }
    if (engine === "sdd_engineering_gates") {
      const executor = gatesById.get(checkId);
      if (!executor) errors.push("deterministic rule references missing engineering gate");
      else if (!executor.rule_ids.includes(rule.rule_id)) errors.push("engineering gate references another rule");
      continue;
    }
    if (engine === "sdd_quality_profile") {
      if (qualityBindings.get(checkId) !== rule.rule_id) {
        errors.push("deterministic quality rule does not match the approved profile");
      }
      continue;
    }
    errors.push("deterministic rule references an unknown automation engine");
  }

  const gateValidation = await validateEngineeringGateRegistry(catalog, gateRegistry);
  errors.push(...gateValidation.errors);
  const qualityValidation = await validateEngineeringQualityProfile(qualityProfile, catalog);
  errors.push(...qualityValidation.errors);


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
    if (rule.approval.approved_by.id !== GOVERNANCE_APPROVAL_AUTHORITY.id) {
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

function strongestGateEffect(ruleIds, rulesById) {
  const rank = { none: 0, warn: 1, block: 2 };
  return ruleIds.reduce((strongest, ruleId) => {
    const effect = rulesById.get(ruleId)?.enforcement?.gate_effect;
    return rank[effect] > rank[strongest] ? effect : strongest;
  }, "none");
}

function matchesDeterministicProducer(producer, id) {
  return producer?.kind === "deterministic"
    && producer.id === id
    && producer.runtime === "ci";
}

export async function validateEngineeringGateRun(value) {
  const structural = await validateGovernanceDocument(engineeringGateRunSchemaName, value);
  if (!structural.valid) return { ok: false, errors: structural.errors };

  const [catalog, registry, checkRegistry] = await Promise.all([
    fs.readFile(ruleCatalogUrl, "utf8").then(JSON.parse),
    loadEngineeringGateRegistry(),
    fs.readFile(governanceCheckRegistryUrl, "utf8").then(JSON.parse),
  ]);
  const errors = [];
  const expectedProfileContext = {
    profile_id: ENGINEERING_QUALITY_PROFILE_TRUST.profile_id,
    profile_version: ENGINEERING_QUALITY_PROFILE_TRUST.profile_version,
    profile_digest: ENGINEERING_QUALITY_PROFILE_TRUST.digest,
    adapter_id: ENGINEERING_QUALITY_PROFILE_TRUST.adapter_id,
    adapter_version: ENGINEERING_QUALITY_PROFILE_TRUST.adapter_version,
  };
  if (JSON.stringify(value.quality_profile) !== JSON.stringify(expectedProfileContext)) {
    errors.push("engineering run quality profile does not match trusted code");
  }
  if (!matchesDeterministicProducer(value.producer, "sdd_engineering_gates")) {
    errors.push("engineering run producer does not match the canonical runner");
  }
  const rulesById = new Map(catalog.rules.map((rule) => [rule.rule_id, rule]));
  const evidenceIds = new Set();
  for (const evidence of value.evidence) {
    if (evidenceIds.has(evidence.evidence_id)) errors.push("duplicate engineering evidence identifier");
    evidenceIds.add(evidence.evidence_id);
  }

  const expectedIds = registry.executors.map((executor) => executor.executor_id);
  if (JSON.stringify(value.results.map((result) => result.executor_id)) !== JSON.stringify(expectedIds)) {
    errors.push("engineering gate results do not match the canonical executor order");
  }

  let errorSeen = false;
  const referencedEvidenceCounts = new Map();
  for (let index = 0; index < value.results.length; index += 1) {
    const result = value.results[index];
    const expected = registry.executors[index];
    if (JSON.stringify(result.rule_ids) !== JSON.stringify(expected.rule_ids)) {
      errors.push("engineering result rule binding does not match the registry");
    }
    if (result.gate_effect !== strongestGateEffect(result.rule_ids, rulesById)) {
      errors.push("engineering result gate effect does not match approved policy");
    }
    if (value.run_error) {
      if (result.status !== "not_run") errors.push("preflight run error must leave every executor not run");
    } else {
      if (errorSeen && result.status !== "not_run") errors.push("executor ran after an untrustworthy result");
      if (!errorSeen && result.status === "not_run") errors.push("executor was not run without a prior error");
      if (result.status === "error") errorSeen = true;
    }

    const allowedCheckIds = new Set([result.executor_id, ...(result.checks ?? []).map((check) => check.check_id)]);
    for (const evidenceId of result.evidence_ids) {
      referencedEvidenceCounts.set(evidenceId, (referencedEvidenceCounts.get(evidenceId) ?? 0) + 1);
      const evidence = value.evidence.find((candidate) => candidate.evidence_id === evidenceId);
      if (!evidence) errors.push("engineering result references missing evidence");
      else {
        if (!allowedCheckIds.has(evidence.check_id)) errors.push("engineering evidence belongs to another executor");
        const governanceCheckEvidence = result.executor_id === "governance"
          && (result.checks ?? []).some((check) => check.check_id === evidence.check_id);
        const expectedProducerId = governanceCheckEvidence
          ? "sdd_governance_checker"
          : "sdd_engineering_gates";
        if (!matchesDeterministicProducer(evidence.collected_by, expectedProducerId)) {
          errors.push("engineering evidence producer does not match its canonical collector");
        }
      }
    }

    if (result.executor_id !== "governance" && result.checks) {
      errors.push("only the governance executor may contain governance subresults");
    }
    if (result.executor_id === "governance" && ["pass", "fail"].includes(result.status)) {
      const checks = result.checks ?? [];
      if (JSON.stringify(checks.map((check) => check.check_id))
        !== JSON.stringify(checkRegistry.checks.map((check) => check.check_id))) {
        errors.push("governance subresults do not match the canonical check order");
      }
      for (let checkIndex = 0; checkIndex < checks.length; checkIndex += 1) {
        const check = checks[checkIndex];
        const expectedCheck = checkRegistry.checks[checkIndex];
        if (!expectedCheck || check.rule_id !== expectedCheck.rule_id) {
          errors.push("governance subresult rule binding does not match the registry");
        }
        if (check.gate_effect !== strongestGateEffect([check.rule_id], rulesById)) {
          errors.push("governance subresult gate effect does not match approved policy");
        }
        for (const evidenceId of check.evidence_ids) {
          if (!result.evidence_ids.includes(evidenceId)) {
            errors.push("governance subresult evidence is absent from its executor");
            continue;
          }
          const evidence = value.evidence.find((candidate) => candidate.evidence_id === evidenceId);
          if (evidence?.check_id !== check.check_id) errors.push("governance evidence belongs to another subresult");
          const expectedEvidenceOutcome = check.status === "pass" ? "pass" : "fail";
          if (evidence?.outcome !== expectedEvidenceOutcome) errors.push("governance evidence outcome does not match its subresult");
        }
      }
      const expectedGovernanceStatus = checks.every((check) => check.status === "pass") ? "pass" : "fail";
      if (result.status !== expectedGovernanceStatus) errors.push("governance executor status does not match its subresults");
    }
    if (result.executor_id !== "governance" || !result.checks) {
      const expectedEvidenceOutcome = result.status === "pass"
        ? "pass"
        : result.status === "fail"
          ? "fail"
          : "inconclusive";
      for (const evidenceId of result.evidence_ids) {
        const evidence = value.evidence.find((candidate) => candidate.evidence_id === evidenceId);
        if (evidence?.outcome !== expectedEvidenceOutcome) {
          errors.push("engineering evidence outcome does not match its executor");
        }
      }
    }
  }

  for (const evidence of value.evidence) {
    if ((referencedEvidenceCounts.get(evidence.evidence_id) ?? 0) !== 1) {
      errors.push("engineering evidence must belong to exactly one executor");
    }
  }

  const blocked = Boolean(value.run_error)
    || value.results.some((result) => result.status === "error" || result.status === "not_run");
  const failed = !blocked && value.results.some((result) => result.status === "fail" && result.gate_effect === "block");
  const expectedOutcome = blocked ? "blocked" : failed ? "failed" : "passed";
  if (value.outcome !== expectedOutcome) errors.push("engineering run outcome does not match executor results");

  return errors.length === 0
    ? { ok: true, value, errors: [] }
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
