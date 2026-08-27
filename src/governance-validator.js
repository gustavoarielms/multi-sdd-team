import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import {
  APPROVED_GOVERNANCE_RULES,
  CANONICAL_ENGINEERING_GATE_BINDINGS,
  CANONICAL_GOVERNANCE_CHECK_BINDINGS,
  ENGINEERING_QUALITY_PROFILE_TRUST,
  GOVERNANCE_APPROVAL_AUTHORITY,
  NODE_ARCHITECTURE_ADAPTER_TRUST,
  governanceDocumentDigest,
  governanceRuleDigest,
} from "./governance-trust.js";

const packageRootPath = fileURLToPath(new URL("../", import.meta.url));
const architectureTrustKeys = Object.freeze([
  "analyzer_id",
  "analyzer_version",
  "notice_header_path",
  "policy_digest",
  "policy_path",
  "runtime_entry",
  "runtime_manifest_digest",
  "runtime_manifest_path",
  "runtime_root_path",
]);

function safeTrustPath(value) {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.includes("\\")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function rawDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validTrustShape(trust) {
  if (!trust || typeof trust !== "object" || Array.isArray(trust)) return false;
  const actual = Object.keys(trust).sort(compareCodeUnits);
  const expected = [...architectureTrustKeys].sort(compareCodeUnits);
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function resolveTrustedAsset(root, relative, expectedType) {
  const real = await fs.realpath(path.join(root, relative));
  const nested = path.relative(root, real);
  if (nested.startsWith("..") || path.isAbsolute(nested)) throw new Error("escaped trusted asset");
  if (!(await fs.stat(real))[expectedType]()) throw new Error("invalid trusted asset type");
  return real;
}

async function trustedArchitectureContent(trust, packageRoot) {
  const root = await fs.realpath(packageRoot);
  const policy = await resolveTrustedAsset(root, trust.policy_path, "isFile");
  const manifest = await resolveTrustedAsset(root, trust.runtime_manifest_path, "isFile");
  const runtimeRoot = await resolveTrustedAsset(root, trust.runtime_root_path, "isDirectory");
  await resolveTrustedAsset(root, trust.notice_header_path, "isFile");
  await resolveTrustedAsset(runtimeRoot, trust.runtime_entry, "isFile");
  return Promise.all([
    fs.readFile(policy),
    fs.readFile(manifest),
    fs.readFile(path.join(runtimeRoot, "node_modules/dependency-cruiser/package.json")),
  ]);
}

export async function validateArchitectureAdapterTrust(
  trust = NODE_ARCHITECTURE_ADAPTER_TRUST,
  packageRoot = packageRootPath,
) {
  const errors = [];
  if (!validTrustShape(trust)) {
    return { ok: false, errors: ["node architecture trust shape is not canonical"] };
  }
  const pathFields = ["notice_header_path", "policy_path", "runtime_entry", "runtime_manifest_path", "runtime_root_path"];
  if (pathFields.some((field) => !safeTrustPath(trust[field]))) {
    return { ok: false, errors: ["node architecture trust path is invalid"] };
  }
  try {
    const [policyBytes, manifestBytes, analyzerManifestBytes] = await trustedArchitectureContent(trust, packageRoot);
    if (rawDigest(policyBytes) !== trust.policy_digest) errors.push("node architecture policy digest does not match trust");
    if (rawDigest(manifestBytes) !== trust.runtime_manifest_digest) {
      errors.push("node architecture runtime manifest digest does not match trust");
    }
    const analyzer = JSON.parse(analyzerManifestBytes.toString("utf8"));
    if (analyzer.name !== trust.analyzer_id || analyzer.version !== trust.analyzer_version) {
      errors.push("node architecture analyzer identity does not match trust");
    }
  } catch {
    errors.push("node architecture trusted asset is unavailable");
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

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

function qualityProfileMatchesTrust(value) {
  const trust = ENGINEERING_QUALITY_PROFILE_TRUST;
  return value.profile_id === trust.profile_id
    && value.profile_version === trust.profile_version
    && value.adapter.adapter_id === trust.adapter_id
    && value.adapter.adapter_version === trust.adapter_version
    && governanceDocumentDigest(value) === trust.digest;
}

function validateQualityProfileBindings(value, catalog, errors) {
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
}

export async function validateEngineeringQualityProfile(value, catalogValue) {
  const structural = await validateGovernanceDocument(engineeringQualityProfileSchemaName, value);
  if (!structural.valid) return { ok: false, errors: structural.errors };

  const errors = [];
  if (!qualityProfileMatchesTrust(value)) {
    errors.push("engineering quality profile does not match trusted code");
  }
  if (value.approval.approved_by.id !== GOVERNANCE_APPROVAL_AUTHORITY.id) {
    errors.push("engineering quality profile authority does not match trusted code");
  }

  const catalog = catalogValue ?? JSON.parse(await fs.readFile(ruleCatalogUrl, "utf8"));
  validateQualityProfileBindings(value, catalog, errors);

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

function collectUniqueIds(items, key, duplicateMessage, errors) {
  const identifiers = new Set();
  for (const item of items) {
    if (identifiers.has(item[key])) errors.push(duplicateMessage);
    identifiers.add(item[key]);
  }
  return identifiers;
}

function validateFindingIntegrity(finding, result, evidenceIds, errors) {
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

function validateGateIdentity(gate, result, normalizedAgent, errors) {
  if (gate.run_id !== result.run_id) errors.push("gate references another run");
  if (gate.decided_by.role !== result.producer.role) errors.push("gate decision role does not match the producer");
  if (gate.decided_by.id !== result.producer.id) errors.push("gate decision identifier does not match the producer");
  if (gate.decided_by.runtime !== result.producer.runtime) errors.push("gate decision runtime does not match the producer");
  if (normalizedAgent && reviewGateTypes.has(normalizedAgent)
    && gate.gate_type !== reviewGateTypes.get(normalizedAgent)) {
    errors.push("gate type does not match the expected review agent");
  }
}

function validateGateCoverage(gate, findings, findingIds, evidenceIds, errors) {
  for (const findingId of gate.finding_ids) {
    if (!findingIds.has(findingId)) errors.push("gate references missing finding");
  }
  for (const finding of findings) {
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
}

function validateBlockingFindings(gate, findings, errors) {
  for (const findingId of gate.blocking_finding_ids) {
    if (!gate.finding_ids.includes(findingId)) errors.push("blocking finding is absent from gate findings");
    const finding = findings.find((candidate) => candidate.finding_id === findingId);
    if (!finding) continue;
    if (finding.rule_status !== "approved") errors.push("blocking finding uses an unapproved rule");
    if (finding.validation_status !== "verified") errors.push("blocking finding is not verified");
    if (finding.status !== "open") errors.push("blocking finding is not open");
    if (finding.recommended_gate_effect !== "block") errors.push("blocking finding does not recommend blocking");
  }
}

function validateHandoff(result, errors) {
  for (const findingId of result.handoff.unresolved_finding_ids) {
    const finding = result.findings.find((candidate) => candidate.finding_id === findingId);
    if (!finding) errors.push("handoff references missing finding");
    else if (finding.status !== "open") errors.push("handoff references a non-open finding");
  }
}

function validateAgentResultIntegrity(result, expectedAgent) {
  const errors = [];
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

  const evidenceIds = collectUniqueIds(result.evidence, "evidence_id", "duplicate evidence identifier", errors);
  const findingIds = collectUniqueIds(result.findings, "finding_id", "duplicate finding identifier", errors);
  collectUniqueIds(result.gate_decisions, "gate_id", "duplicate gate identifier", errors);
  for (const finding of result.findings) validateFindingIntegrity(finding, result, evidenceIds, errors);
  for (const gate of result.gate_decisions) {
    validateGateIdentity(gate, result, normalizedAgent, errors);
    validateGateCoverage(gate, result.findings, findingIds, evidenceIds, errors);
    validateBlockingFindings(gate, result.findings, errors);
  }
  validateHandoff(result, errors);
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

function collectCatalogRuleIds(catalog, errors) {
  const ruleIds = new Set();
  for (const rule of catalog.rules) {
    if (ruleIds.has(rule.rule_id)) errors.push("duplicate rule identifier");
    ruleIds.add(rule.rule_id);
  }
  return ruleIds;
}

function collectCatalogChecks(registry, ruleIds, errors) {
  const checksById = new Map();
  for (const check of registry.checks) {
    if (checksById.has(check.check_id)) errors.push("duplicate check identifier");
    checksById.set(check.check_id, check);
    if (!ruleIds.has(check.rule_id)) errors.push("check references missing rule");
  }
  return checksById;
}

function validateCanonicalCheckBindings(registry, errors) {
  const canonicalCheckIds = Object.keys(CANONICAL_GOVERNANCE_CHECK_BINDINGS);
  if (registry.checks.length !== canonicalCheckIds.length) {
    errors.push("check registry does not contain the canonical bindings");
  }
  for (const checkId of canonicalCheckIds) {
    const expected = CANONICAL_GOVERNANCE_CHECK_BINDINGS[checkId];
    const actual = registry.checks.find((check) => check.check_id === checkId);
    if (!actual || actual.rule_id !== expected.rule_id || actual.implementation !== expected.implementation) {
      errors.push("check registry binding does not match trusted code");
    }
  }
}

function validateDeterministicAutomation(catalog, checksById, gatesById, qualityBindings, errors) {
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
}

function validateApprovedRuleSet(catalog, errors) {
  const trustedRuleIds = new Set(Object.keys(APPROVED_GOVERNANCE_RULES));
  const catalogRuleIds = new Set(
    catalog.rules.filter((candidate) => candidate.status === "approved").map((rule) => rule.rule_id),
  );
  if (trustedRuleIds.size !== catalogRuleIds.size
    || [...trustedRuleIds].some((ruleId) => !catalogRuleIds.has(ruleId))
    || [...catalogRuleIds].some((ruleId) => !trustedRuleIds.has(ruleId))) {
    errors.push("approved rule set does not match trusted code");
  }
}

function validateApprovedRuleBindings(catalog, errors) {
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
}

function validateDeprecatedRuleLifecycle(catalog, gateRegistry, errors) {
  const activeRuleIds = new Set(gateRegistry.executors.flatMap((executor) => executor.rule_ids));
  for (const rule of catalog.rules.filter((candidate) => candidate.status === "deprecated")) {
    if (rule.enforcement.mode === "deterministic"
      || rule.enforcement.gate_effect !== "none"
      || rule.enforcement.automation
      || activeRuleIds.has(rule.rule_id)
      || APPROVED_GOVERNANCE_RULES[rule.rule_id]) {
      errors.push("deprecated rule retains an active deterministic binding");
    }
  }
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

  const ruleIds = collectCatalogRuleIds(catalog, errors);
  const checksById = collectCatalogChecks(registry, ruleIds, errors);
  const gatesById = new Map(gateRegistry.executors.map((executor) => [executor.executor_id, executor]));
  const qualityBindings = qualityProfileBindings(qualityProfile);
  validateCanonicalCheckBindings(registry, errors);
  validateDeterministicAutomation(catalog, checksById, gatesById, qualityBindings, errors);

  const gateValidation = await validateEngineeringGateRegistry(catalog, gateRegistry);
  errors.push(...gateValidation.errors);
  const qualityValidation = await validateEngineeringQualityProfile(qualityProfile, catalog);
  errors.push(...qualityValidation.errors);

  validateApprovedRuleSet(catalog, errors);
  validateApprovedRuleBindings(catalog, errors);
  validateDeprecatedRuleLifecycle(catalog, gateRegistry, errors);

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

function validateEngineeringRunHeader(value, registry, errors) {
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
  collectUniqueIds(value.evidence, "evidence_id", "duplicate engineering evidence identifier", errors);
  const expectedIds = registry.executors.map((executor) => executor.executor_id);
  if (JSON.stringify(value.results.map((result) => result.executor_id)) !== JSON.stringify(expectedIds)) {
    errors.push("engineering gate results do not match the canonical executor order");
  }
}

function validateEngineeringExecutionOrder(result, runError, errorSeen, errors) {
  if (runError) {
    if (result.status !== "not_run") errors.push("preflight run error must leave every executor not run");
    return errorSeen;
  }
  if (errorSeen && result.status !== "not_run") errors.push("executor ran after an untrustworthy result");
  if (!errorSeen && result.status === "not_run") errors.push("executor was not run without a prior error");
  return errorSeen || result.status === "error";
}

function validateEngineeringEvidenceOwnership(result, value, referencedCounts, errors) {
  const allowedCheckIds = new Set([result.executor_id, ...(result.checks ?? []).map((check) => check.check_id)]);
  for (const evidenceId of result.evidence_ids) {
    referencedCounts.set(evidenceId, (referencedCounts.get(evidenceId) ?? 0) + 1);
    const evidence = value.evidence.find((candidate) => candidate.evidence_id === evidenceId);
    if (!evidence) {
      errors.push("engineering result references missing evidence");
      continue;
    }
    if (!allowedCheckIds.has(evidence.check_id)) errors.push("engineering evidence belongs to another executor");
    const governanceCheckEvidence = result.executor_id === "governance"
      && (result.checks ?? []).some((check) => check.check_id === evidence.check_id);
    const expectedProducerId = governanceCheckEvidence ? "sdd_governance_checker" : "sdd_engineering_gates";
    if (!matchesDeterministicProducer(evidence.collected_by, expectedProducerId)) {
      errors.push("engineering evidence producer does not match its canonical collector");
    }
  }
}

function validateGovernanceSubresult(check, expected, result, value, rulesById, errors) {
  if (!expected || check.rule_id !== expected.rule_id) {
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
    const expectedOutcome = check.status === "pass" ? "pass" : "fail";
    if (evidence?.outcome !== expectedOutcome) errors.push("governance evidence outcome does not match its subresult");
  }
}

function validateGovernanceSubresults(result, value, checkRegistry, rulesById, errors) {
  const checks = result.checks ?? [];
  if (JSON.stringify(checks.map((check) => check.check_id))
    !== JSON.stringify(checkRegistry.checks.map((check) => check.check_id))) {
    errors.push("governance subresults do not match the canonical check order");
  }
  for (let index = 0; index < checks.length; index += 1) {
    validateGovernanceSubresult(checks[index], checkRegistry.checks[index], result, value, rulesById, errors);
  }
  const expectedStatus = checks.every((check) => check.status === "pass") ? "pass" : "fail";
  if (result.status !== expectedStatus) errors.push("governance executor status does not match its subresults");
}

function validateCoverageEvidence(check, result, value, errors) {
  if (check.evidence_ids.length !== 1) errors.push("coverage subresult must own exactly one evidence item");
  const evidenceId = check.evidence_ids[0];
  if (!result.evidence_ids.includes(evidenceId)) errors.push("coverage subresult evidence is absent from its executor");
  const evidence = value.evidence.find((candidate) => candidate.evidence_id === evidenceId);
  if (evidence?.check_id !== check.check_id) errors.push("coverage evidence belongs to another subresult");
  const notApplicable = check.check_id === "coverage_changed"
    && check.status === "pass"
    && check.gate_effect === "none"
    && check.evidence_ids.length === 1
    && evidence?.check_id === "coverage_changed"
    && evidence.outcome === "not_applicable";
  const expectedOutcome = check.status === "pass" ? "pass" : "fail";
  if (!notApplicable && evidence?.outcome !== expectedOutcome) {
    errors.push("coverage evidence outcome does not match its subresult");
  }
  return notApplicable;
}

function validateCoverageCheck(check, binding, result, value, errors) {
  if (!binding || check.check_id !== binding[0] || check.rule_id !== binding[1]) {
    errors.push("coverage subresult rule binding does not match canonical policy");
  }
  const notApplicable = validateCoverageEvidence(check, result, value, errors);
  if (check.check_id === "coverage_global" && check.gate_effect !== "block") {
    errors.push("global coverage must remain blocking");
  }
  if (check.check_id === "coverage_changed" && !notApplicable && check.gate_effect !== "block") {
    errors.push("changed coverage must remain blocking unless it is exactly not applicable");
  }
}

function validateCoverageSubresults(result, value, errors) {
  const expected = [["coverage_global", "TEST-COVERAGE-GLOBAL-001"], ["coverage_changed", "TEST-COVERAGE-CHANGED-001"]];
  const checks = result.checks ?? [];
  if (checks.length !== expected.length) errors.push("coverage subresults do not match the canonical check order");
  checks.forEach((check, index) => validateCoverageCheck(check, expected[index], result, value, errors));
  const expectedEvidenceIds = [];
  for (const check of checks) {
    for (const evidenceId of check.evidence_ids) {
      if (!expectedEvidenceIds.includes(evidenceId)) expectedEvidenceIds.push(evidenceId);
    }
  }
  if (JSON.stringify(result.evidence_ids) !== JSON.stringify(expectedEvidenceIds)) {
    errors.push("coverage executor evidence must equal the ordered deduplicated subresult union");
  }
  const expectedStatus = checks.every((check) => check.status === "pass") ? "pass" : "fail";
  if (result.status !== expectedStatus) errors.push("coverage executor status does not match its subresults");
}

const ARCHITECTURE_CHECK_BINDINGS = Object.freeze([
  Object.freeze(["no_production_cycles", "ARCH-NO-CYCLES-001"]),
  Object.freeze(["production_must_not_import_tests", "ARCH-PROD-NO-TEST-001"]),
  Object.freeze(["src_must_not_import_bin", "ARCH-SRC-NO-BIN-001"]),
  Object.freeze(["production_imports_resolve", "ARCH-IMPORT-RESOLUTION-001"]),
  Object.freeze(["production_must_not_import_dev_dependencies", "ARCH-PROD-NO-DEV-DEPS-001"]),
]);

function validateArchitectureEvidence(check, evidenceId, evidenceIndex, result, value, errors) {
  const evidence = value.evidence.find((candidate) => candidate.evidence_id === evidenceId);
  if (!result.evidence_ids.includes(evidenceId)) errors.push("architecture subresult evidence is absent from its executor");
  if (evidence?.check_id !== check.check_id) errors.push("architecture evidence belongs to another subresult");
  const expectedOutcome = check.status === "pass" ? "pass" : "fail";
  if (evidence?.outcome !== expectedOutcome) errors.push("architecture evidence outcome does not match its subresult");
  if (check.status === "pass" && evidenceIndex > 0) errors.push("passing architecture subresult has unexpected detail evidence");
}

function validateArchitectureCheck(check, binding, result, value, orderedEvidenceIds, errors) {
  if (!binding || check.check_id !== binding[0] || check.rule_id !== binding[1]) {
    errors.push("architecture subresult rule binding does not match canonical policy");
  }
  if (check.gate_effect !== "block") errors.push("architecture subresult must remain blocking");
  if (check.evidence_ids.length < 1 || check.evidence_ids.length > 21) {
    errors.push("architecture subresult evidence is not bounded");
  }
  for (const [evidenceIndex, evidenceId] of check.evidence_ids.entries()) {
    orderedEvidenceIds.push(evidenceId);
    validateArchitectureEvidence(check, evidenceId, evidenceIndex, result, value, errors);
  }
}

function validateArchitectureSubresults(result, value, errors) {
  const checks = result.checks ?? [];
  if (checks.length !== ARCHITECTURE_CHECK_BINDINGS.length) errors.push("architecture subresults do not match the canonical check order");
  const orderedEvidenceIds = [];
  checks.forEach((check, index) => validateArchitectureCheck(
    check,
    ARCHITECTURE_CHECK_BINDINGS[index],
    result,
    value,
    orderedEvidenceIds,
    errors,
  ));
  if (JSON.stringify(result.evidence_ids) !== JSON.stringify(orderedEvidenceIds)) {
    errors.push("architecture executor evidence must equal the ordered subresult union");
  }
  const expectedStatus = checks.every((check) => check.status === "pass") ? "pass" : "fail";
  if (result.status !== expectedStatus) errors.push("architecture executor status does not match its subresults");
}

function validateExecutorEvidenceOutcomes(result, value, errors) {
  const expectedOutcome = result.status === "pass"
    ? "pass"
    : result.status === "fail"
      ? "fail"
      : "inconclusive";
  let primaryEvidenceSeen = false;
  for (const evidenceId of result.evidence_ids) {
    const evidence = value.evidence.find((candidate) => candidate.evidence_id === evidenceId);
    if (evidence?.outcome === expectedOutcome) {
      primaryEvidenceSeen = true;
    } else if (!(result.executor_id === "node_lint_complexity"
      && ["pass", "fail"].includes(result.status)
      && evidence?.outcome === "observed")) {
      errors.push("engineering evidence outcome does not match its executor");
    }
  }
  if (!primaryEvidenceSeen) errors.push("engineering executor lacks primary status evidence");
}

function validateEngineeringSubresults(result, context) {
  const { value, rulesById, checkRegistry, errors } = context;
  const structuredExecutors = ["governance", "coverage", "node_architecture"];
  if (!structuredExecutors.includes(result.executor_id) && result.checks) {
    errors.push("executor contains unsupported subresults");
  }
  const completed = ["pass", "fail"].includes(result.status);
  if (result.executor_id === "governance" && completed) {
    validateGovernanceSubresults(result, value, checkRegistry, rulesById, errors);
  }
  if (result.executor_id === "coverage" && completed) validateCoverageSubresults(result, value, errors);
  if (result.executor_id === "node_architecture" && completed) {
    if (!result.checks) errors.push("architecture executor requires canonical subresults");
    validateArchitectureSubresults(result, value, errors);
  }
  if (["coverage", "node_architecture"].includes(result.executor_id)
    && result.status === "error" && result.checks) {
    errors.push("structured executor error result cannot contain subresults");
  }
  if (!structuredExecutors.includes(result.executor_id) || !result.checks) {
    validateExecutorEvidenceOutcomes(result, value, errors);
  }
}

function validateEngineeringResult(result, expected, context, errorSeen) {
  const { value, rulesById, referencedCounts, errors } = context;
  if (JSON.stringify(result.rule_ids) !== JSON.stringify(expected.rule_ids)) {
    errors.push("engineering result rule binding does not match the registry");
  }
  if (result.gate_effect !== strongestGateEffect(result.rule_ids, rulesById)) {
    errors.push("engineering result gate effect does not match approved policy");
  }
  const nextErrorSeen = validateEngineeringExecutionOrder(result, value.run_error, errorSeen, errors);
  validateEngineeringEvidenceOwnership(result, value, referencedCounts, errors);
  validateEngineeringSubresults(result, context);
  return nextErrorSeen;
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
  const rulesById = new Map(catalog.rules.map((rule) => [rule.rule_id, rule]));
  validateEngineeringRunHeader(value, registry, errors);

  let errorSeen = false;
  const referencedEvidenceCounts = new Map();
  for (let index = 0; index < value.results.length; index += 1) {
    errorSeen = validateEngineeringResult(value.results[index], registry.executors[index], {
      value,
      rulesById,
      checkRegistry,
      referencedCounts: referencedEvidenceCounts,
      errors,
    }, errorSeen);
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
