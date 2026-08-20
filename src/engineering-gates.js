import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runGovernanceChecks } from "./governance-checks.js";
import {
  CANONICAL_ENGINEERING_GATE_BINDINGS,
  ENGINEERING_QUALITY_PROFILE_TRUST,
} from "./governance-trust.js";
import {
  validateEngineeringGateConfiguration,
  validateEngineeringGateRun,
  validateEngineeringQualityProfile,
  validateGovernanceCatalog,
  validateGovernanceDocument,
} from "./governance-validator.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONFIGURATION_PATH = path.join(".sdd-codegraph", "gates.json");
const GATE_REGISTRY_PATH = path.join(PACKAGE_ROOT, "governance", "gates", "v1", "registry.json");
const RULE_CATALOG_PATH = path.join(PACKAGE_ROOT, "governance", "rules", "v1", "catalog.json");
const CHECK_REGISTRY_PATH = path.join(PACKAGE_ROOT, "governance", "checks", "v1", "registry.json");
const QUALITY_PROFILE_PATH = path.join(PACKAGE_ROOT, "governance", "profiles", "v1", "engineering-quality-profile.json");
const PRODUCER = Object.freeze({ kind: "deterministic", id: "sdd_engineering_gates", runtime: "ci" });

const REQUIRED_PACKAGE_ASSETS = Object.freeze([
  "bin/sdd-codegraph.js",
  "governance/checks/v1/registry.json",
  "governance/gates/v1/registry.json",
  "governance/profiles/v1/engineering-quality-profile.json",
  "governance/rules/v1/catalog.json",
  "governance/schemas/v1/engineering-gate-config.schema.json",
  "governance/schemas/v1/engineering-gate-registry.schema.json",
  "governance/schemas/v1/engineering-gate-run.schema.json",
  "governance/schemas/v1/engineering-quality-profile.schema.json",
  "src/engineering-gates.js",
  "src/governance-checks.js",
  "src/governance-trust.js",
  "src/governance-validator.js",
]);

let policyPromise;

function timestamp() {
  return new Date().toISOString();
}

function boundedSummary(value, fallback) {
  const normalized = String(value ?? fallback).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return (normalized || fallback).slice(0, 500);
}

function isContained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function evidenceOutcome(status) {
  if (status === "pass") return "pass";
  if (status === "fail") return "fail";
  return "inconclusive";
}

function strongestEffect(ruleIds, rulesById) {
  const rank = { none: 0, warn: 1, block: 2 };
  return ruleIds.reduce((strongest, ruleId) => {
    const effect = rulesById.get(ruleId)?.enforcement?.gate_effect ?? "block";
    return rank[effect] > rank[strongest] ? effect : strongest;
  }, "none");
}

function qualityProfileContext(profile) {
  return Object.freeze({
    profile_id: profile.profile_id,
    profile_version: profile.profile_version,
    profile_digest: ENGINEERING_QUALITY_PROFILE_TRUST.digest,
    adapter_id: profile.adapter.adapter_id,
    adapter_version: profile.adapter.adapter_version,
  });
}

async function loadPolicy() {
  policyPromise ??= Promise.all([
    fs.readFile(GATE_REGISTRY_PATH, "utf8").then(JSON.parse),
    fs.readFile(RULE_CATALOG_PATH, "utf8").then(JSON.parse),
    fs.readFile(CHECK_REGISTRY_PATH, "utf8").then(JSON.parse),
    fs.readFile(QUALITY_PROFILE_PATH, "utf8").then(JSON.parse),
  ]).then(async ([registry, catalog, checkRegistry, profile]) => {
    const registryStructure = await validateGovernanceDocument("engineering-gate-registry.schema.json", registry);
    const profileValidation = await validateEngineeringQualityProfile(profile, catalog);
    const governance = await validateGovernanceCatalog(catalog, checkRegistry, registry, profile);
    if (!registryStructure.valid || !profileValidation.ok || !governance.ok) {
      throw new Error("Engineering gate policy is invalid.");
    }
    return {
      registry,
      catalog,
      profile,
      profileContext: qualityProfileContext(profile),
      rulesById: new Map(catalog.rules.map((rule) => [rule.rule_id, rule])),
    };
  });
  return policyPromise;
}

function fallbackPolicy() {
  const rulesById = new Map();
  const executors = Object.entries(CANONICAL_ENGINEERING_GATE_BINDINGS).map(([executorId, binding]) => {
    for (const ruleId of binding.rule_ids) {
      rulesById.set(ruleId, { enforcement: { gate_effect: "block" } });
    }
    return {
      executor_id: executorId,
      implementation: binding.implementation,
      rule_ids: binding.rule_ids,
      timeout_ms: binding.timeout_ms,
      max_output_bytes: binding.max_output_bytes,
    };
  });
  return {
    registry: { executors },
    rulesById,
    profileContext: Object.freeze({
      profile_id: ENGINEERING_QUALITY_PROFILE_TRUST.profile_id,
      profile_version: ENGINEERING_QUALITY_PROFILE_TRUST.profile_version,
      profile_digest: ENGINEERING_QUALITY_PROFILE_TRUST.digest,
      adapter_id: ENGINEERING_QUALITY_PROFILE_TRUST.adapter_id,
      adapter_version: ENGINEERING_QUALITY_PROFILE_TRUST.adapter_version,
    }),
  };
}

export const ENGINEERING_EXECUTOR_IDS = Object.freeze([
  "javascript_syntax",
  "test_suite",
  "governance",
  "production_dependency_audit",
  "npm_package_surface",
  "forbidden_references",
]);

export function runBoundedCommand(executable, args, options) {
  const { cwd, timeoutMs, maxOutputBytes, env = process.env } = options;
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputBytes = 0;
    let reason;
    let child;
    let timer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, duration_ms: Math.max(0, Date.now() - started) });
    };

    const capture = (stream, chunk) => {
      if (settled || reason) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        reason = "COMMAND_OUTPUT_LIMIT";
        child.kill("SIGKILL");
        return;
      }
      if (stream === "stdout") stdout = Buffer.concat([stdout, chunk]);
      else stderr = Buffer.concat([stderr, chunk]);
    };

    try {
      child = spawn(executable, args, {
        cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish({ status: "error", reason_code: "COMMAND_SPAWN_FAILED" });
      return;
    }

    timer = setTimeout(() => {
      if (settled || reason) return;
      reason = "COMMAND_TIMEOUT";
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.on("error", () => finish({ status: "error", reason_code: "COMMAND_SPAWN_FAILED" }));
    child.on("close", (code, signal) => {
      if (reason) {
        finish({ status: "error", reason_code: reason });
        return;
      }
      if (signal) {
        finish({ status: "error", reason_code: "COMMAND_SIGNALLED" });
        return;
      }
      finish({
        status: "completed",
        exit_code: code ?? 1,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
  });
}

async function listTrackedFiles(target, patterns, limits) {
  const command = await runBoundedCommand("git", ["-C", target, "ls-files", "-z", "--", ...patterns], {
    cwd: target,
    ...limits,
  });
  if (command.status === "error") return command;
  if (command.exit_code !== 0) return { status: "error", reason_code: "TRACKED_FILES_UNAVAILABLE" };
  const files = command.stdout.split("\0").filter(Boolean).sort();
  for (const relative of files) {
    const absolute = path.resolve(target, relative);
    if (!isContained(target, absolute)) return { status: "error", reason_code: "SOURCE_UNSAFE_PATH" };
    try {
      const real = await fs.realpath(absolute);
      if (!isContained(target, real)) return { status: "error", reason_code: "SOURCE_UNSAFE_PATH" };
    } catch {
      return { status: "error", reason_code: "SOURCE_UNAVAILABLE" };
    }
  }
  return { status: "completed", files };
}

async function javascriptSyntax(context) {
  const listed = await listTrackedFiles(context.target, ["*.js", "*.sh"], context.limits);
  if (listed.status === "error") return listed;
  for (const relative of listed.files) {
    const executable = relative.endsWith(".sh") ? "bash" : process.execPath;
    const args = relative.endsWith(".sh") ? ["-n", relative] : ["--check", relative];
    const command = await runBoundedCommand(executable, args, { cwd: context.target, ...context.limits });
    if (command.status === "error") return command;
    if (command.exit_code !== 0) {
      return {
        status: "fail",
        reason_code: "SOURCE_SYNTAX_FAILED",
        summary: `Syntax validation failed for 1 of ${listed.files.length} tracked source file(s).`,
      };
    }
  }
  return {
    status: "pass",
    reason_code: "SOURCE_SYNTAX_PASSED",
    summary: `Syntax validation passed for ${listed.files.length} tracked JavaScript and shell file(s).`,
  };
}

async function testSuite(context) {
  const command = await runBoundedCommand(process.execPath, ["--test"], { cwd: context.target, ...context.limits });
  if (command.status === "error") return command;
  return command.exit_code === 0
    ? { status: "pass", reason_code: "TEST_SUITE_PASSED", summary: "The repository test suite completed successfully." }
    : { status: "fail", reason_code: "TEST_SUITE_FAILED", summary: "The repository test suite completed with a functional failure." };
}

async function governance(context) {
  try {
    const result = await runGovernanceChecks(context.target);
    if (!result.trusted) return { status: "error", reason_code: "GOVERNANCE_UNTRUSTWORTHY" };
    return {
      status: result.blocking ? "fail" : "pass",
      reason_code: result.blocking ? "GOVERNANCE_FAILED" : "GOVERNANCE_PASSED",
      summary: result.blocking
        ? "At least one approved blocking governance check failed."
        : "All approved blocking governance checks passed.",
      evidence: result.document.evidence,
      checks: result.document.results,
    };
  } catch {
    return { status: "error", reason_code: "GOVERNANCE_ERROR" };
  }
}

function npmExecutable() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function withTemporaryNpmCache(callback) {
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-engineering-gates-npm-"));
  try {
    return await callback({ ...process.env, NPM_CONFIG_CACHE: cache });
  } finally {
    await fs.rm(cache, { recursive: true, force: true });
  }
}

async function productionDependencyAudit(context) {
  const command = await withTemporaryNpmCache((env) => runBoundedCommand(
    npmExecutable(),
    ["audit", "--omit=dev", "--json", "--ignore-scripts"],
    { cwd: context.target, env, ...context.limits },
  ));
  if (command.status === "error") return command;
  let report;
  try {
    report = JSON.parse(command.stdout);
  } catch {
    return { status: "error", reason_code: "DEPENDENCY_AUDIT_MALFORMED" };
  }
  if (report?.error) return { status: "error", reason_code: "DEPENDENCY_AUDIT_UNAVAILABLE" };
  const vulnerabilities = report?.metadata?.vulnerabilities;
  if (!vulnerabilities || !Number.isInteger(vulnerabilities.total)) {
    return { status: "error", reason_code: "DEPENDENCY_AUDIT_MALFORMED" };
  }
  return vulnerabilities.total === 0 && command.exit_code === 0
    ? { status: "pass", reason_code: "DEPENDENCY_AUDIT_PASSED", summary: "The production dependency audit reported zero vulnerabilities." }
    : { status: "fail", reason_code: "DEPENDENCY_AUDIT_FAILED", summary: `The production dependency audit reported ${vulnerabilities.total} vulnerability finding(s).` };
}

async function npmPackageSurface(context) {
  const command = await withTemporaryNpmCache((env) => runBoundedCommand(
    npmExecutable(),
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: context.target, env, ...context.limits },
  ));
  if (command.status === "error") return command;
  if (command.exit_code !== 0) return { status: "error", reason_code: "PACKAGE_DRY_RUN_ERROR" };
  let files;
  try {
    const report = JSON.parse(command.stdout);
    files = report[0].files.map((file) => file.path);
  } catch {
    return { status: "error", reason_code: "PACKAGE_DRY_RUN_MALFORMED" };
  }
  const missing = REQUIRED_PACKAGE_ASSETS.filter((asset) => !files.includes(asset));
  return missing.length === 0
    ? { status: "pass", reason_code: "PACKAGE_SURFACE_PASSED", summary: `The package dry run contains all required runner assets across ${files.length} file(s).` }
    : { status: "fail", reason_code: "PACKAGE_SURFACE_FAILED", summary: `The package dry run is missing ${missing.length} required runner asset(s).` };
}

async function forbiddenReferences(context) {
  const runtime = ["p", "i"].join("");
  const child = ["P", "I_SUBAGENT_CHILD"].join("");
  const vendor = ["@mario", "zechner"].join("");
  const retiredExtensions = [runtime, ".(extensions|prompts)"].join("");
  const extensionPath = ["(^|/)", "extensions", "/"].join("");
  const promptPath = ["(^|/)", "prompts", "/"].join("");
  const pattern = `(^|[^[:alnum:]_])${runtime}([^[:alnum:]_]|$)|${child}|${vendor}|${retiredExtensions}|${extensionPath}|(^|/)agents/.*\\.md|${promptPath}`;
  const command = await runBoundedCommand("git", ["-C", context.target, "grep", "-nI", "-i", "-E", pattern, "--", "."], {
    cwd: context.target,
    ...context.limits,
  });
  if (command.status === "error") return command;
  if (command.exit_code === 1) {
    return { status: "pass", reason_code: "FORBIDDEN_REFERENCES_PASSED", summary: "No approved forbidden runtime reference was found." };
  }
  if (command.exit_code === 0) {
    const count = command.stdout.split("\n").filter(Boolean).length;
    return { status: "fail", reason_code: "FORBIDDEN_REFERENCES_FAILED", summary: `Found ${count} forbidden reference match(es).` };
  }
  return { status: "error", reason_code: "FORBIDDEN_REFERENCES_ERROR" };
}

const DEFAULT_EXECUTORS = Object.freeze({
  javascript_syntax: javascriptSyntax,
  test_suite: testSuite,
  governance,
  production_dependency_audit: productionDependencyAudit,
  npm_package_surface: npmPackageSurface,
  forbidden_references: forbiddenReferences,
});

function buildEvidence(executorId, status, summary, completedAt) {
  return {
    schema_version: "1.0.0",
    evidence_id: `evidence:engineering_${executorId}`,
    kind: status === "fail" ? "static_analysis" : "command_result",
    level: "deterministic",
    outcome: evidenceOutcome(status),
    summary,
    check_id: executorId,
    collected_at: completedAt,
    collected_by: PRODUCER,
    redaction: { applied: false, categories: [] },
  };
}

function normalizeExecution(executorId, execution, registration, rulesById, started) {
  const completedAt = timestamp();
  const status = ["pass", "fail", "error"].includes(execution.status) ? execution.status : "error";
  const fallback = status === "pass"
    ? "The executor completed successfully."
    : status === "fail"
      ? "The executor completed with a functional failure."
      : "The executor could not produce a trustworthy result.";
  const summary = boundedSummary(execution.summary, fallback);
  const evidence = Array.isArray(execution.evidence) && execution.evidence.length > 0
    ? execution.evidence
    : [buildEvidence(executorId, status, summary, completedAt)];
  return {
    result: {
      executor_id: executorId,
      rule_ids: registration.rule_ids,
      status,
      gate_effect: strongestEffect(registration.rule_ids, rulesById),
      reason_code: execution.reason_code ?? (status === "error" ? "EXECUTOR_ERROR" : "EXECUTOR_RESULT"),
      summary,
      duration_ms: Math.min(600000, Math.max(0, Date.now() - started)),
      evidence_ids: evidence.map((item) => item.evidence_id),
      ...(execution.checks ? { checks: execution.checks } : {}),
    },
    evidence,
  };
}

function notRun(executorId, registration, rulesById, reasonCode, summary, completedAt) {
  const evidence = buildEvidence(executorId, "not_run", summary, completedAt);
  return {
    result: {
      executor_id: executorId,
      rule_ids: registration.rule_ids,
      status: "not_run",
      gate_effect: strongestEffect(registration.rule_ids, rulesById),
      reason_code: reasonCode,
      summary,
      duration_ms: 0,
      evidence_ids: [evidence.evidence_id],
    },
    evidence: [evidence],
  };
}

function assembleDocument(startedAt, results, evidence, runError, comparisonBase, profileContext) {
  const blocked = Boolean(runError)
    || results.some((result) => result.status === "error" || result.status === "not_run");
  const failed = !blocked && results.some((result) => result.status === "fail" && result.gate_effect === "block");
  return {
    schema_version: "1.0.0",
    run_id: `run:engineering-gates-${randomUUID()}`,
    producer: PRODUCER,
    started_at: startedAt,
    completed_at: timestamp(),
    quality_profile: profileContext,
    outcome: blocked ? "blocked" : failed ? "failed" : "passed",
    ...(runError ? { run_error: runError } : {}),
    ...(comparisonBase ? { comparison_base: comparisonBase } : {}),
    evidence,
    results,
  };
}

function blockedRun(startedAt, policy, reasonCode, summary) {
  const completedAt = timestamp();
  const entries = policy.registry.executors.map((registration) => notRun(
    registration.executor_id,
    registration,
    policy.rulesById,
    reasonCode,
    summary,
    completedAt,
  ));
  const document = assembleDocument(
    startedAt,
    entries.map((entry) => entry.result),
    entries.flatMap((entry) => entry.evidence),
    { reason_code: reasonCode, summary },
    undefined,
    policy.profileContext,
  );
  return { document, exitCode: 2 };
}

async function readConfiguration(target) {
  const configPath = path.join(target, CONFIGURATION_PATH);
  let realConfig;
  try {
    await fs.lstat(configPath);
    realConfig = await fs.realpath(configPath);
  } catch (error) {
    return error?.code === "ENOENT"
      ? { error: "CONFIGURATION_MISSING", summary: "The required engineering gate configuration is missing." }
      : { error: "CONFIGURATION_UNAVAILABLE", summary: "The engineering gate configuration could not be read safely." };
  }
  if (!isContained(target, realConfig)) {
    return { error: "CONFIGURATION_UNSAFE_PATH", summary: "The engineering gate configuration escapes the target boundary." };
  }
  let configuration;
  try {
    configuration = JSON.parse(await fs.readFile(realConfig, "utf8"));
  } catch {
    return { error: "CONFIGURATION_INVALID", summary: "The engineering gate configuration is not valid JSON." };
  }
  let validation;
  try {
    validation = await validateEngineeringGateConfiguration(configuration);
  } catch {
    return { error: "CONFIGURATION_VALIDATION_ERROR", summary: "The engineering gate configuration contract could not be evaluated." };
  }
  if (!validation.valid) {
    return { error: "CONFIGURATION_INVALID", summary: "The engineering gate configuration does not satisfy the approved contract." };
  }
  return { configuration };
}

async function resolveComparisonBase(target, supplied, limits, required) {
  if (supplied === undefined) {
    return required
      ? { error: "COMPARISON_BASE_REQUIRED", summary: "The selected engineering quality profile requires an explicit comparison base." }
      : {};
  }
  if (!/^[a-f0-9]{40}$/.test(supplied)) {
    return { error: "COMPARISON_BASE_INVALID", summary: "The comparison base must be one full lowercase commit SHA." };
  }
  const exists = await runBoundedCommand("git", ["-C", target, "cat-file", "-e", `${supplied}^{commit}`], {
    cwd: target,
    ...limits,
  });
  if (exists.status === "error" || exists.exit_code !== 0) {
    return { error: "COMPARISON_BASE_UNAVAILABLE", summary: "The supplied comparison commit is unavailable in the target repository." };
  }
  const mergeBase = await runBoundedCommand("git", ["-C", target, "merge-base", supplied, "HEAD"], {
    cwd: target,
    ...limits,
  });
  const effective = mergeBase.stdout?.trim();
  if (mergeBase.status === "error" || mergeBase.exit_code !== 0 || !/^[a-f0-9]{40}$/.test(effective)) {
    return { error: "COMPARISON_BASE_UNAVAILABLE", summary: "A trustworthy merge base could not be resolved." };
  }
  return { comparisonBase: { supplied_sha: supplied, effective_merge_base_sha: effective } };
}

export async function runEngineeringGates(targetPath, options = {}) {
  const startedAt = timestamp();
  let policy;
  try {
    policy = await loadPolicy();
  } catch {
    return blockedRun(
      startedAt,
      fallbackPolicy(),
      "POLICY_UNAVAILABLE",
      "The package-owned engineering gate policy could not be loaded trustworthily.",
    );
  }
  let target;
  try {
    target = await fs.realpath(path.resolve(targetPath));
  } catch {
    return blockedRun(startedAt, policy, "TARGET_UNAVAILABLE", "The target repository could not be resolved safely.");
  }

  const configuration = await readConfiguration(target);
  if (configuration.error) return blockedRun(startedAt, policy, configuration.error, configuration.summary);
  const selectedProfile = configuration.configuration.quality_profile;
  const expectedSelection = policy.profileContext;
  if (selectedProfile.profile_id !== expectedSelection.profile_id
    || selectedProfile.profile_version !== expectedSelection.profile_version
    || selectedProfile.adapter_id !== expectedSelection.adapter_id
    || selectedProfile.adapter_version !== expectedSelection.adapter_version) {
    return blockedRun(
      startedAt,
      policy,
      "CONFIGURATION_PROFILE_MISMATCH",
      "The selected quality profile or adapter does not match package-owned policy.",
    );
  }

  const comparison = await resolveComparisonBase(target, options.comparisonBase, {
    timeoutMs: 30000,
    maxOutputBytes: 262144,
  }, policy.profile?.comparison?.required === true);
  if (comparison.error) return blockedRun(startedAt, policy, comparison.error, comparison.summary);

  const implementations = options.executors ?? DEFAULT_EXECUTORS;
  const results = [];
  const evidence = [];
  let blocked = false;
  for (const registration of policy.registry.executors) {
    if (blocked) {
      const entry = notRun(
        registration.executor_id,
        registration,
        policy.rulesById,
        "PRIOR_EXECUTOR_ERROR",
        "The executor was not run because a prior required executor was untrustworthy.",
        timestamp(),
      );
      results.push(entry.result);
      evidence.push(...entry.evidence);
      continue;
    }

    const started = Date.now();
    let execution;
    try {
      const implementation = implementations[registration.implementation];
      execution = implementation
        ? await implementation({
          target,
          comparisonBase: comparison.comparisonBase,
          qualityProfile: policy.profileContext,
          limits: {
            timeoutMs: registration.timeout_ms,
            maxOutputBytes: registration.max_output_bytes,
          },
        })
        : { status: "error", reason_code: "EXECUTOR_MISSING" };
      if (!execution || typeof execution !== "object") {
        execution = { status: "error", reason_code: "EXECUTOR_INVALID_RESULT" };
      }
    } catch {
      execution = { status: "error", reason_code: "EXECUTOR_EXCEPTION" };
    }
    const normalized = normalizeExecution(
      registration.executor_id,
      execution,
      registration,
      policy.rulesById,
      started,
    );
    results.push(normalized.result);
    evidence.push(...normalized.evidence);
    if (normalized.result.status === "error") blocked = true;
  }

  const document = assembleDocument(
    startedAt,
    results,
    evidence,
    null,
    comparison.comparisonBase,
    policy.profileContext,
  );
  let validation;
  try {
    validation = await validateEngineeringGateRun(document);
  } catch {
    validation = { ok: false };
  }
  if (!validation.ok) {
    return blockedRun(
      startedAt,
      policy,
      "RESULT_VALIDATION_FAILED",
      "The generated engineering gate result failed its canonical contract.",
    );
  }
  return {
    document,
    exitCode: document.outcome === "blocked" ? 2 : document.outcome === "failed" ? 1 : 0,
  };
}
