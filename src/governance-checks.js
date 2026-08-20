import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateGovernanceCatalog, validateGovernanceCheckResult } from "./governance-validator.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

const checks = Object.freeze({
  governance_catalog_integrity: checkCatalogIntegrity,
  codex_role_catalog: checkCodexRoleCatalog,
  reviewer_report_only: checkReviewerReportOnly,
  review_handoff_contract: checkReviewHandoffContract,
  pipeline_dependency_order: checkPipelineDependencyOrder,
});

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function isContained(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function containedRealPath(root, target) {
  await fs.lstat(target);
  const realTarget = await fs.realpath(target);
  if (!isContained(root, realTarget)) throw new Error("governance layout escapes target root");
  return realTarget;
}

async function buildLayout(rootReal, values, canonicalTargetProvided) {
  const artifacts = [
    values.governanceRoot,
    values.codexAgentsRoot,
    values.pipelinePath,
    values.agentsPolicyPath,
    path.join(values.governanceRoot, "rules", "v1", "catalog.json"),
    path.join(values.governanceRoot, "checks", "v1", "registry.json"),
    path.join(values.governanceRoot, "gates", "v1", "registry.json"),
    path.join(values.governanceRoot, "profiles", "v1", "engineering-quality-profile.json"),
  ];
  try {
    await Promise.all(artifacts.map((artifact) => containedRealPath(rootReal, artifact)));
    if (canonicalTargetProvided) {
      await Promise.all(["src"].map((directory) => (
        containedRealPath(rootReal, path.join(values.canonicalRoot, directory))
      )));
    }
  } catch {
    return null;
  }
  return {
    ...values,
    targetBoundary: rootReal,
    canonicalBoundary: canonicalTargetProvided ? rootReal : null,
  };
}

async function resolveGovernanceLayout(root) {
  let rootReal;
  try {
    await fs.lstat(root);
    rootReal = await fs.realpath(root);
  } catch {
    return null;
  }
  const sourceGovernance = path.join(root, "governance");
  const sourceCodex = path.join(root, "codex");
  if (await exists(path.join(sourceGovernance, "rules", "v1", "catalog.json"))
    && await exists(path.join(sourceCodex, "agents"))) {
    return buildLayout(rootReal, {
      canonicalRoot: root,
      governanceRoot: sourceGovernance,
      codexAgentsRoot: path.join(sourceCodex, "agents"),
      pipelinePath: path.join(sourceCodex, "pipeline.json"),
      agentsPolicyPath: path.join(sourceCodex, "AGENTS.md"),
      managedAgentsPolicy: false,
    }, true);
  }

  const projectCodex = path.join(root, ".codex");
  if (await exists(path.join(projectCodex, "governance", "rules", "v1", "catalog.json"))
    && await exists(path.join(projectCodex, "agents"))) {
    return buildLayout(rootReal, {
      canonicalRoot: packageRoot,
      governanceRoot: path.join(projectCodex, "governance"),
      codexAgentsRoot: path.join(projectCodex, "agents"),
      pipelinePath: path.join(root, "pipeline.json"),
      agentsPolicyPath: path.join(root, "AGENTS.md"),
      managedAgentsPolicy: true,
    }, false);
  }

  if (await exists(path.join(root, "governance", "rules", "v1", "catalog.json"))
    && await exists(path.join(root, "agents"))) {
    return buildLayout(rootReal, {
      canonicalRoot: packageRoot,
      governanceRoot: path.join(root, "governance"),
      codexAgentsRoot: path.join(root, "agents"),
      pipelinePath: path.join(root, "pipeline.json"),
      agentsPolicyPath: path.join(root, "AGENTS.md"),
      managedAgentsPolicy: true,
    }, false);
  }
  return null;
}

async function readText(filePath, boundary) {
  const resolved = boundary ? await containedRealPath(boundary, filePath) : filePath;
  return fs.readFile(resolved, "utf8");
}

async function readJson(filePath, boundary) {
  return JSON.parse(await readText(filePath, boundary));
}

async function checkCatalogIntegrity({ catalog, registry, gateRegistry, qualityProfile }) {
  const validation = await validateGovernanceCatalog(catalog, registry, gateRegistry, qualityProfile);
  return validation.ok
    ? { pass: true, summary: "Catalog schemas, approvals, identifiers, and check links are valid." }
    : { pass: false, summary: `Catalog integrity failed with ${validation.errors.length} constraint violation(s).` };
}

async function declaredRoles(directory, extension, pattern, boundary) {
  const resolvedDirectory = boundary ? await containedRealPath(boundary, directory) : directory;
  const files = (await fs.readdir(resolvedDirectory))
    .filter((name) => name.endsWith(extension))
    .sort();
  const roles = [];
  for (const file of files) {
    const match = (await readText(path.join(directory, file), boundary)).match(pattern);
    if (!match) return null;
    roles.push(match[1].replaceAll("-", "_"));
  }
  return roles.sort();
}

async function checkCodexRoleCatalog({ layout }) {
  const codex = await declaredRoles(layout.codexAgentsRoot, ".toml", /^name\s*=\s*"([^"]+)"$/m, layout.targetBoundary);
  const expected = [
    "architecture_reviewer",
    "documentator",
    "explorer",
    "hacker",
    "implementer",
    "orchestrator",
    "planner",
    "tester_reviewer",
  ];
  const pass = Boolean(codex && JSON.stringify(codex) === JSON.stringify(expected));
  return pass
    ? { pass: true, summary: `Codex exposes the complete ${codex.length}-role governed catalog.` }
    : { pass: false, summary: "The Codex governed role catalog is incomplete or invalid." };
}

async function checkReviewerReportOnly({ layout }) {
  const reviewers = ["architecture-reviewer", "tester-reviewer", "hacker"];
  const conditionalWrite = /(?:modific|escrib|write|edit)[^\n]{0,120}(?:salvo|except|reasign)|(?:salvo|except|reasign)[^\n]{0,120}(?:modific|escrib|write|edit)/i;
  for (const reviewer of reviewers) {
    const codex = await readText(path.join(layout.codexAgentsRoot, `${reviewer}.toml`), layout.targetBoundary);
    if (!/solo reporte|No modifi/i.test(codex)
      || !/^sandbox_mode\s*=\s*"read-only"$/m.test(codex)
      || conditionalWrite.test(codex)) {
      return { pass: false, summary: "At least one independent reviewer has an invalid report-only declaration." };
    }
  }
  return { pass: true, summary: "Codex architecture, quality, and security reviewers are report-only." };
}

async function checkReviewHandoffContract({ layout }) {
  const reviewers = [
    ["architecture-reviewer", "architecture_reviewer", "architecture"],
    ["tester-reviewer", "tester_reviewer", "quality"],
    ["hacker", "hacker", "security"],
  ];
  for (const [file, role, gate] of reviewers) {
    const codex = await readText(path.join(layout.codexAgentsRoot, `${file}.toml`), layout.targetBoundary);
    if (!/exactamente un objeto JSON|exactamente un objeto JSON válido/i.test(codex)
      || !new RegExp(`producer\\.role.{0,15}${role}`).test(codex)
      || !/producer\.runtime.{0,15}codex/.test(codex)
      || !new RegExp(`gate_type.{0,15}${gate}`).test(codex)) {
      return { pass: false, summary: "At least one review prompt lacks its strict governance handoff contract." };
    }
  }
  const commonSchema = await readJson(
    path.join(layout.governanceRoot, "schemas", "v1", "common.schema.json"),
    layout.targetBoundary,
  );
  const validator = await readText(path.join(layout.canonicalRoot, "src", "governance-validator.js"), layout.canonicalBoundary);
  const pipeline = await readText(layout.pipelinePath, layout.targetBoundary);
  const policyFile = await readText(layout.agentsPolicyPath, layout.targetBoundary);
  const managedPolicy = policyFile.match(
    /<!-- multi-sdd-team: begin -->([\s\S]*?)<!-- multi-sdd-team: end -->/,
  )?.[1];
  const policy = layout.managedAgentsPolicy ? managedPolicy : policyFile;
  const runtimeContract = commonSchema?.$defs?.producer?.allOf?.[0]?.then?.properties?.runtime;
  const pass = runtimeContract?.const === "codex"
    && /review agents must emit exactly one gate decision/.test(validator)
    && typeof policy === "string"
    && /sdd-codegraph validate-result - --agent <agent_name>/.test(policy)
    && !/validate-result[^\n]*--runtime/.test(policy)
    && /invalid structured review output.*passing gate/i.test(pipeline);
  return pass
    ? { pass: true, summary: "Review prompts and runtime validation enforce the strict handoff contract." }
    : { pass: false, summary: "Structured review runtime validation is incomplete." };
}

function validateSequence(sequence) {
  if (!Array.isArray(sequence)) return false;
  const positions = new Map(sequence.map((step, index) => [step.id, index]));
  if (positions.size !== sequence.length) return false;
  return sequence.every((step, index) => Array.isArray(step.depends_on)
    && step.depends_on.every((dependency) => positions.has(dependency) && positions.get(dependency) < index));
}

function hasDependencies(byId, stepId, dependencies) {
  const step = byId.get(stepId);
  return Boolean(step && dependencies.every((dependency) => step.depends_on.includes(dependency)));
}

function validatesGovernedStrategy(strategy, { stages, edges }) {
  if (!validateSequence(strategy?.sequence)) return false;
  const byId = new Map(strategy.sequence.map((step) => [step.id, step]));
  return stages.every((stage) => byId.has(stage))
    && edges.every(([step, dependency]) => hasDependencies(byId, step, [dependency]));
}

const governedPipelineRequirements = {
  SUBAGENT_CHAIN: {
    stages: ["explore_if_needed", "implement", "deterministic_checks", "architecture_compliance_review", "review", "main_integrate"],
    edges: [
      ["implement", "explore_if_needed"],
      ["deterministic_checks", "implement"],
      ["architecture_compliance_review", "deterministic_checks"],
      ["review", "deterministic_checks"],
      ["review", "architecture_compliance_review"],
      ["main_integrate", "review"],
    ],
  },
  SDD_SUBAGENTS: {
    stages: ["explore", "document", "plan", "architecture_design_review", "security_review", "implement", "deterministic_checks", "architecture_compliance_review", "review", "main_integrate"],
    edges: [
      ["document", "explore"],
      ["plan", "document"],
      ["architecture_design_review", "plan"],
      ["security_review", "plan"],
      ["security_review", "architecture_design_review"],
      ["implement", "plan"],
      ["implement", "architecture_design_review"],
      ["implement", "security_review"],
      ["deterministic_checks", "implement"],
      ["architecture_compliance_review", "deterministic_checks"],
      ["review", "deterministic_checks"],
      ["review", "architecture_compliance_review"],
      ["main_integrate", "review"],
    ],
  },
};

async function checkPipelineDependencyOrder({ layout }) {
  let pipeline;
  try {
    pipeline = await readJson(layout.pipelinePath, layout.targetBoundary);
  } catch {
    return { pass: false, summary: "Pipeline configuration is missing or invalid JSON." };
  }
  const strategies = Object.values(pipeline.strategies ?? {});
  const policy = JSON.stringify(pipeline);
  const pass = strategies.length > 0
    && strategies.every((strategy) => validateSequence(strategy.sequence))
    && Object.entries(governedPipelineRequirements).every(([name, requirements]) => (
      validatesGovernedStrategy(pipeline.strategies?.[name], requirements)
    ))
    && /must not inspect.*failed or unresolved|invalid structured review output.*passing gate|Never treat invalid structured review output as a passing gate/i.test(policy);
  return pass
    ? { pass: true, summary: "Pipeline dependencies are ordered and its review policy fails closed." }
    : { pass: false, summary: "Pipeline dependencies or fail-closed review policy are invalid." };
}

function timestamp() {
  return new Date().toISOString();
}

function catalogFailure(startedAt, summary) {
  const completedAt = timestamp();
  return {
    document: {
      schema_version: "1.0.0",
      run_id: `run:governance-${Date.now()}`,
      producer: { kind: "deterministic", id: "sdd_governance_checker", runtime: "ci" },
      started_at: startedAt,
      completed_at: completedAt,
      outcome: "failed",
      evidence: [{
        schema_version: "1.0.0",
        evidence_id: "evidence:governance_catalog_integrity",
        kind: "static_analysis",
        level: "deterministic",
        outcome: "fail",
        summary,
        check_id: "governance_catalog_integrity",
        collected_at: completedAt,
        collected_by: { kind: "deterministic", id: "sdd_governance_checker", runtime: "ci" },
        redaction: { applied: false, categories: [] },
      }],
      results: [{
        check_id: "governance_catalog_integrity",
        rule_id: "GOV-CATALOG-INTEGRITY-001",
        status: "fail",
        gate_effect: "block",
        summary: "Catalog integrity failed.",
        evidence_ids: ["evidence:governance_catalog_integrity"],
      }],
    },
    blocking: true,
    trusted: false,
  };
}

export function hasBlockingGovernanceFailures(results) {
  return results.some((result) => result.status === "fail" && result.gate_effect === "block");
}

export async function runGovernanceChecks(targetPath) {
  const root = path.resolve(targetPath);
  const startedAt = timestamp();
  const layout = await resolveGovernanceLayout(root);
  if (!layout) return catalogFailure(startedAt, "The target does not contain a recognized governance layout.");
  let catalog;
  let registry;
  let gateRegistry;
  let qualityProfile;
  try {
    [catalog, registry, gateRegistry, qualityProfile] = await Promise.all([
      readJson(path.join(layout.governanceRoot, "rules", "v1", "catalog.json"), layout.targetBoundary),
      readJson(path.join(layout.governanceRoot, "checks", "v1", "registry.json"), layout.targetBoundary),
      readJson(path.join(layout.governanceRoot, "gates", "v1", "registry.json"), layout.targetBoundary),
      readJson(path.join(layout.governanceRoot, "profiles", "v1", "engineering-quality-profile.json"), layout.targetBoundary),
    ]);
  } catch {
    return catalogFailure(startedAt, "The canonical governance policy could not be loaded.");
  }

  const catalogValidation = await validateGovernanceCatalog(catalog, registry, gateRegistry, qualityProfile);
  if (!catalogValidation.ok) {
    return catalogFailure(startedAt, `Catalog integrity failed with ${catalogValidation.errors.length} constraint violation(s).`);
  }

  const rulesById = new Map(catalog.rules?.map((rule) => [rule.rule_id, rule]) ?? []);
  const registered = Array.isArray(registry.checks) ? registry.checks : [];
  const results = [];
  const evidence = [];
  for (const registration of registered) {
    const implementation = checks[registration.check_id];
    let execution;
    try {
      execution = implementation
        ? await implementation({ layout, catalog, registry, gateRegistry, qualityProfile })
        : { pass: false, summary: "Registered check has no implementation." };
    } catch {
      execution = { pass: false, summary: "Governance check could not complete." };
    }
    const rule = rulesById.get(registration.rule_id);
    const evidenceId = `evidence:${registration.check_id}`;
    const collectedAt = timestamp();
    evidence.push({
      schema_version: "1.0.0",
      evidence_id: evidenceId,
      kind: "static_analysis",
      level: "deterministic",
      outcome: execution.pass ? "pass" : "fail",
      summary: execution.summary,
      check_id: registration.check_id,
      collected_at: collectedAt,
      collected_by: { kind: "deterministic", id: "sdd_governance_checker", runtime: "ci" },
      redaction: { applied: false, categories: [] },
    });
    results.push({
      check_id: registration.check_id,
      rule_id: registration.rule_id,
      status: execution.pass ? "pass" : "fail",
      gate_effect: rule?.enforcement?.gate_effect ?? "block",
      summary: execution.summary,
      evidence_ids: [evidenceId],
    });
  }

  const completedAt = timestamp();
  const document = {
    schema_version: "1.0.0",
    run_id: `run:governance-${Date.now()}`,
    producer: { kind: "deterministic", id: "sdd_governance_checker", runtime: "ci" },
    started_at: startedAt,
    completed_at: completedAt,
    outcome: results.every((result) => result.status === "pass") ? "passed" : "failed",
    evidence,
    results,
  };
  const structural = await validateGovernanceCheckResult(document);
  if (!structural.ok) throw new Error("Generated governance result failed its own contract.");
  return {
    document,
    blocking: hasBlockingGovernanceFailures(results),
    trusted: true,
  };
}
