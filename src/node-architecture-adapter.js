import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isContained, listTrackedFiles, runBoundedCommand } from "./engineering-gate-runtime.js";
import {
  ARCHITECTURE_RULES,
  NODE_ARCHITECTURE_ANALYZER,
  NODE_ARCHITECTURE_LIMITS,
  NODE_ARCHITECTURE_POLICY_DIGEST,
  NODE_ARCHITECTURE_PROTOCOL_VERSION,
  canonicalizeCycle,
  compareCodeUnits,
  detailKey,
  exactKeys,
  graphWithinLimits,
  safeJavaScriptPath,
  safeRelativePath,
  safeText,
} from "./node-architecture-contract.js";

export { ARCHITECTURE_RULES, canonicalizeCycle, validateArchitecturePolicy } from "./node-architecture-contract.js";

const WORKER_PATH = fileURLToPath(new URL("./node-architecture-worker.js", import.meta.url));
const PRODUCTION_PATTERNS = Object.freeze([":(glob)bin/**/*.js", ":(glob)src/**/*.js"]);
const TEST_PATTERNS = Object.freeze([":(glob)test/**/*.js"]);
const PRODUCER = Object.freeze({ kind: "deterministic", id: "sdd_engineering_gates", runtime: "ci" });
const PREFLIGHT_REASONS = Object.freeze({
  input: "NODE_ARCHITECTURE_INPUT_INVALID",
  manifest: "NODE_ARCHITECTURE_MANIFEST_INVALID",
  resource: "NODE_ARCHITECTURE_RESOURCE_LIMIT",
});

class ArchitecturePreflightError extends Error {
  constructor(category) {
    super(category);
    this.category = category;
  }
}

function failPreflight(category) {
  throw new ArchitecturePreflightError(category);
}

function architectureError(reasonCode = "NODE_ARCHITECTURE_UNAVAILABLE") {
  return {
    status: "error",
    reason_code: reasonCode,
    summary: "The package-owned architecture analyzer could not produce trustworthy bounded evidence.",
  };
}

function identity(stat, realpath) {
  return {
    realpath,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: Number(stat.size),
    mtime_ns: stat.mtimeNs.toString(),
  };
}

async function captureIdentity(root, relative, maximum, invalidCategory = "input", limitCategory = "resource") {
  try {
    if (!safeRelativePath(relative)) failPreflight(invalidCategory);
    const resolved = path.resolve(root, relative);
    const real = await fs.realpath(resolved);
    if (!isContained(root, real)) failPreflight(invalidCategory);
    const stat = await fs.stat(real, { bigint: true });
    if (!stat.isFile()) failPreflight(invalidCategory);
    if (stat.size > BigInt(maximum)) failPreflight(limitCategory);
    return identity(stat, real);
  } catch (error) {
    if (error instanceof ArchitecturePreflightError) throw error;
    failPreflight(invalidCategory);
  }
}

async function inventories(target, limits) {
  const [production, tests] = await Promise.all([
    listTrackedFiles(target, PRODUCTION_PATTERNS, limits),
    listTrackedFiles(target, TEST_PATTERNS, limits),
  ]);
  if (production.status === "error" || tests.status === "error") failPreflight("input");
  if (production.files.length === 0) failPreflight("input");
  if (production.files.length + tests.files.length > NODE_ARCHITECTURE_LIMITS.fileCount) failPreflight("resource");
  const all = [...production.files, ...tests.files];
  if (new Set(all).size !== all.length || all.some((file) => !safeJavaScriptPath(file))) failPreflight("input");
  let aggregate = 0;
  const captured = new Map();
  for (const relative of all) {
    const value = await captureIdentity(target, relative, NODE_ARCHITECTURE_LIMITS.fileBytes);
    aggregate += value.size;
    if (aggregate > NODE_ARCHITECTURE_LIMITS.aggregateBytes) failPreflight("resource");
    captured.set(relative, value);
  }
  const manifestIdentity = await captureIdentity(
    target,
    "package.json",
    NODE_ARCHITECTURE_LIMITS.manifestBytes,
    "manifest",
    "manifest",
  );
  return {
    production_files: production.files.map((file) => ({ path: file, identity: captured.get(file) })),
    test_files: tests.files.map((file) => ({ path: file, identity: captured.get(file) })),
    manifest_identity: manifestIdentity,
  };
}

function sameIdentity(left, right) {
  return exactKeys(right, ["realpath", "dev", "ino", "size", "mtime_ns"])
    && Object.keys(left).every((key) => left[key] === right[key]);
}

async function captureTargetIdentity(target) {
  const real = await fs.realpath(target);
  if (real !== target) failPreflight("input");
  const stat = await fs.stat(real, { bigint: true });
  if (!stat.isDirectory()) failPreflight("input");
  return identity(stat, real);
}

async function revalidateIdentities(target, targetIdentity, inventory) {
  const currentTarget = await captureTargetIdentity(target);
  if (!["realpath", "dev", "ino"].every((key) => targetIdentity[key] === currentTarget[key])) {
    failPreflight("input");
  }
  const currentManifest = await captureIdentity(
    target,
    "package.json",
    NODE_ARCHITECTURE_LIMITS.manifestBytes,
    "manifest",
    "manifest",
  );
  if (!sameIdentity(inventory.manifest_identity, currentManifest)) failPreflight("manifest");
  if (!sameIdentity(targetIdentity, currentTarget)) failPreflight("input");
  for (const file of [...inventory.production_files, ...inventory.test_files]) {
    const current = await captureIdentity(target, file.path, NODE_ARCHITECTURE_LIMITS.fileBytes, "input", "input");
    if (!sameIdentity(file.identity, current)) failPreflight("input");
  }
}

function validCycleDetail(detail, production) {
  if (!exactKeys(detail, ["kind", "members"]) || detail.kind !== "cycle") return false;
  try {
    const canonical = canonicalizeCycle(detail.members);
    return [
      JSON.stringify(canonical) === JSON.stringify(detail.members),
      detail.members.every((member) => production.has(member)),
    ].every(Boolean);
  } catch {
    return false;
  }
}

function validProductionTestDetail(detail, production, tests) {
  return [
    exactKeys(detail, ["kind", "source", "target"]),
    detail?.kind === "edge",
    production.has(detail?.source),
    tests.has(detail?.target),
    detail?.target?.startsWith("test/"),
  ].every(Boolean);
}

function validSourceBinDetail(detail, production) {
  return [
    exactKeys(detail, ["kind", "source", "target"]),
    detail?.kind === "edge",
    production.has(detail?.source),
    detail?.source?.startsWith("src/"),
    production.has(detail?.target),
    detail?.target?.startsWith("bin/"),
  ].every(Boolean);
}

function validUnresolvedDetail(detail, production) {
  return [
    exactKeys(detail, ["kind", "source", "specifier"]),
    detail?.kind === "unresolved",
    production.has(detail?.source),
    safeText(detail?.specifier, 1024),
  ].every(Boolean);
}

function validPackageDetail(detail, production) {
  return [
    exactKeys(detail, ["kind", "source", "package"]),
    detail?.kind === "package",
    production.has(detail?.source),
    safeText(detail?.package, 214),
  ].every(Boolean);
}

function validDetail(detail, rule, production, tests) {
  const validators = {
    "ARCH-NO-CYCLES-001": () => validCycleDetail(detail, production),
    "ARCH-PROD-NO-TEST-001": () => validProductionTestDetail(detail, production, tests),
    "ARCH-SRC-NO-BIN-001": () => validSourceBinDetail(detail, production),
    "ARCH-IMPORT-RESOLUTION-001": () => validUnresolvedDetail(detail, production),
    "ARCH-PROD-NO-DEV-DEPS-001": () => validPackageDetail(detail, production),
  };
  return validators[rule.rule_id]?.() === true;
}

function validGraph(graph) {
  return [
    exactKeys(graph, ["module_count", "edge_count"]),
    graphWithinLimits(graph?.module_count, graph?.edge_count),
  ].every(Boolean);
}

function validReportHeader(report) {
  return [
    exactKeys(report, ["protocol_version", "analyzer", "policy_digest", "files", "graph", "rules"]),
    report?.protocol_version === NODE_ARCHITECTURE_PROTOCOL_VERSION,
    exactKeys(report?.analyzer, ["id", "version"]),
    report?.analyzer?.id === NODE_ARCHITECTURE_ANALYZER.id,
    report?.analyzer?.version === NODE_ARCHITECTURE_ANALYZER.version,
    report?.policy_digest === NODE_ARCHITECTURE_POLICY_DIGEST,
    validGraph(report?.graph),
  ].every(Boolean);
}

function validateReport(report, inventory) {
  if (!validReportHeader(report)) return false;
  const expectedFiles = inventory.production_files.map((file) => file.path);
  if (JSON.stringify(report.files) !== JSON.stringify(expectedFiles) || !Array.isArray(report.rules)
    || report.rules.length !== ARCHITECTURE_RULES.length) return false;
  const production = new Set(expectedFiles);
  const tests = new Set(inventory.test_files.map((file) => file.path));
  return report.rules.every((entry, index) => {
    const rule = ARCHITECTURE_RULES[index];
    if (!exactKeys(entry, ["check_id", "rule_id", "total", "details"])
      || entry.check_id !== rule.check_id || entry.rule_id !== rule.rule_id
      || !Number.isSafeInteger(entry.total) || entry.total < 0 || !Array.isArray(entry.details)
      || entry.details.length !== Math.min(entry.total, NODE_ARCHITECTURE_LIMITS.detailCount)) return false;
    let prior;
    const keys = new Set();
    for (const detail of entry.details) {
      if (!validDetail(detail, rule, production, tests)) return false;
      const key = detailKey(detail);
      if (keys.has(key) || (prior !== undefined && compareCodeUnits(prior, key) >= 0)) return false;
      keys.add(key);
      prior = key;
    }
    return true;
  });
}

function evidence(rule, suffix, outcome, summary, detail) {
  const source = detail?.source ?? detail?.members?.[0];
  return {
    schema_version: "1.0.0",
    evidence_id: `evidence:node_architecture_${rule.check_id}_${suffix}`,
    kind: source ? "source_location" : "static_analysis",
    level: "deterministic",
    outcome,
    summary: summary.slice(0, 500),
    ...(source ? { location: { path: source } } : {}),
    check_id: rule.check_id,
    collected_at: new Date().toISOString(),
    collected_by: PRODUCER,
    redaction: { applied: false, categories: [] },
  };
}

function detailSummary(rule, detail) {
  if (detail.kind === "cycle") return `Directed production cycle: ${detail.members.join(" -> ")} -> ${detail.members[0]}.`;
  if (detail.kind === "edge") return `${rule.check_id} edge: ${detail.source} -> ${detail.target}.`;
  if (detail.kind === "unresolved") return `Unresolved production import from ${detail.source}.`;
  return `Development-only dependency imported by ${detail.source}: ${detail.package}.`;
}

function successfulResult(report) {
  const collected = [];
  const checks = report.rules.map((entry, index) => {
    const rule = ARCHITECTURE_RULES[index];
    const failed = entry.total > 0;
    const summary = `${rule.check_id}: ${entry.total} violation(s) found by dependency-cruiser ${NODE_ARCHITECTURE_ANALYZER.version}.`;
    const owned = [evidence(rule, "summary", failed ? "fail" : "pass", summary)];
    entry.details.forEach((detail, detailIndex) => {
      owned.push(evidence(rule, `detail_${detailIndex + 1}`, "fail", detailSummary(rule, detail), detail));
    });
    collected.push(...owned);
    return {
      check_id: rule.check_id,
      rule_id: rule.rule_id,
      status: failed ? "fail" : "pass",
      gate_effect: "block",
      summary,
      evidence_ids: owned.map((item) => item.evidence_id),
    };
  });
  const failed = checks.some((check) => check.status === "fail");
  return {
    status: failed ? "fail" : "pass",
    reason_code: failed ? "NODE_ARCHITECTURE_FAILED" : "NODE_ARCHITECTURE_PASSED",
    summary: `dependency-cruiser ${NODE_ARCHITECTURE_ANALYZER.version} evaluated ${report.files.length} production module(s) against five architecture rules.`,
    evidence: collected,
    checks,
  };
}

function commandError(command) {
  const reasons = {
    COMMAND_TIMEOUT: "NODE_ARCHITECTURE_TIMEOUT",
    COMMAND_OUTPUT_LIMIT: "NODE_ARCHITECTURE_OUTPUT_LIMIT",
    COMMAND_SIGNALLED: "NODE_ARCHITECTURE_SIGNALLED",
    COMMAND_SPAWN_FAILED: "NODE_ARCHITECTURE_SPAWN_FAILED",
  };
  return architectureError(reasons[command.reason_code]);
}

function workerError(command) {
  if (command.exit_code !== 2) return architectureError();
  try {
    const envelope = JSON.parse(command.stdout);
    if (!exactKeys(envelope, ["protocol_version", "error_category"])
      || envelope.protocol_version !== NODE_ARCHITECTURE_PROTOCOL_VERSION) {
      return architectureError("NODE_ARCHITECTURE_PROTOCOL_INVALID");
    }
    const reasons = {
      input: "NODE_ARCHITECTURE_INPUT_INVALID",
      manifest: "NODE_ARCHITECTURE_MANIFEST_INVALID",
      policy: "NODE_ARCHITECTURE_POLICY_INVALID",
      runtime: "NODE_ARCHITECTURE_RUNTIME_INVALID",
      analyzer: "NODE_ARCHITECTURE_ANALYZER_INVALID",
      resource: "NODE_ARCHITECTURE_RESOURCE_LIMIT",
      evidence: "NODE_ARCHITECTURE_EVIDENCE_INVALID",
    };
    return reasons[envelope.error_category]
      ? architectureError(reasons[envelope.error_category])
      : architectureError("NODE_ARCHITECTURE_PROTOCOL_INVALID");
  } catch {
    return architectureError("NODE_ARCHITECTURE_PROTOCOL_INVALID");
  }
}

function preflightError(error) {
  return architectureError(PREFLIGHT_REASONS[error?.category] ?? PREFLIGHT_REASONS.input);
}

export async function runNodeArchitecture(context, dependencies = {}) {
  let target;
  let targetIdentity;
  let inventory;
  try {
    target = await fs.realpath(context.target);
    inventory = await inventories(target, context.limits);
    targetIdentity = await captureTargetIdentity(target);
  } catch (error) {
    return preflightError(error);
  }
  const runCommand = dependencies.runCommand ?? runBoundedCommand;
  const command = await runCommand(process.execPath, ["--max-old-space-size=256", WORKER_PATH], {
    cwd: target,
    ...context.limits,
    env: {},
    input: JSON.stringify({
      protocol_version: NODE_ARCHITECTURE_PROTOCOL_VERSION,
      target_root: target,
      ...inventory,
    }),
  });
  if (command.status === "error") return commandError(command);
  if (command.exit_code !== 0) return workerError(command);
  let report;
  try {
    report = JSON.parse(command.stdout);
    if (!validateReport(report, inventory)) {
      return architectureError("NODE_ARCHITECTURE_PROTOCOL_INVALID");
    }
  } catch {
    return architectureError("NODE_ARCHITECTURE_PROTOCOL_INVALID");
  }
  try {
    await revalidateIdentities(target, targetIdentity, inventory);
  } catch (error) {
    return preflightError(error);
  }
  return successfulResult(report);
}
