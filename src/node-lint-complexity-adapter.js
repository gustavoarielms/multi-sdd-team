import path from "node:path";
import { fileURLToPath } from "node:url";

import { listTrackedFiles, runBoundedCommand } from "./engineering-gate-runtime.js";
import { NODE_COMPLEXITY_MAXIMUM, NODE_ESLINT_VERSION } from "./node-eslint-policy.js";

const WORKER_PATH = fileURLToPath(new URL("./node-lint-complexity-worker.js", import.meta.url));
const SOURCE_PATTERNS = Object.freeze([
  ":(glob)bin/**/*.js",
  ":(glob)src/**/*.js",
  ":(glob)test/**/*.js",
]);
const PRODUCER = Object.freeze({ kind: "deterministic", id: "sdd_engineering_gates", runtime: "ci" });
const DIAGNOSTIC_KEYS = Object.freeze([
  "column",
  "end_column",
  "end_line",
  "line",
  "message_id",
  "path",
  "rule_id",
  "symbol",
]);
const COMPLEXITY_KEYS = Object.freeze([...DIAGNOSTIC_KEYS, "threshold", "value"].sort());

function timestamp() {
  return new Date().toISOString();
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function safeText(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    });
}

function safeRelativePath(value, files) {
  return safeText(value, 1024) && !path.isAbsolute(value) && !value.includes("\\")
    && !value.split("/").includes("..") && files.has(value);
}

function validLocationNumber(value) {
  return Number.isInteger(value) && value >= 1;
}

function validDiagnosticKeys(value, complexity) {
  const keys = Object.keys(value ?? {}).sort();
  const allowed = complexity ? COMPLEXITY_KEYS : DIAGNOSTIC_KEYS;
  return keys.every((key) => allowed.includes(key));
}

function validRequiredDiagnosticFields(value, files) {
  return safeText(value?.rule_id, 128) && safeRelativePath(value?.path, files)
    && validLocationNumber(value?.line) && validLocationNumber(value?.column);
}

function validOptionalDiagnosticFields(value) {
  if (value.message_id !== undefined && !safeText(value.message_id, 128)) return false;
  if (value.symbol !== undefined && !safeText(value.symbol, 512)) return false;
  if (value.end_line !== undefined && !validLocationNumber(value.end_line)) return false;
  if (value.end_column !== undefined && !validLocationNumber(value.end_column)) return false;
  return true;
}

function validBaseDiagnostic(value, files, complexity) {
  return validDiagnosticKeys(value, complexity)
    && validRequiredDiagnosticFields(value, files)
    && validOptionalDiagnosticFields(value);
}

function validComplexityDiagnostic(value) {
  return value.rule_id === "complexity" && value.message_id === "complex"
    && Number.isInteger(value.value) && value.value > NODE_COMPLEXITY_MAXIMUM
    && value.threshold === NODE_COMPLEXITY_MAXIMUM && safeText(value.symbol, 512);
}

function validDiagnostic(value, files, complexity) {
  if (!validBaseDiagnostic(value, files, complexity)) return false;
  return !complexity || validComplexityDiagnostic(value);
}

function validCollection(values, count, files, complexity = false) {
  return Array.isArray(values) && Number.isInteger(count) && count >= 0
    && values.length === Math.min(count, 50)
    && values.every((value) => validDiagnostic(value, files, complexity));
}

function validateReport(report, files) {
  const topLevel = [
    "analyzer",
    "complexity_violations",
    "counts",
    "files_analyzed",
    "lint_errors",
    "protocol_version",
    "warnings",
  ];
  const countKeys = ["complexity_violations", "lint_errors", "warnings"];
  if (!exactKeys(report, topLevel) || report.protocol_version !== "1.0.0"
    || !exactKeys(report.analyzer, ["id", "version"])
    || !exactKeys(report.counts, countKeys)
    || report.files_analyzed !== files.size) return false;
  return validCollection(report.lint_errors, report.counts.lint_errors, files)
    && validCollection(report.warnings, report.counts.warnings, files)
    && validCollection(
      report.complexity_violations,
      report.counts.complexity_violations,
      files,
      true,
    );
}

function location(diagnostic) {
  return {
    path: diagnostic.path,
    line_start: diagnostic.line,
    ...(diagnostic.end_line ? { line_end: diagnostic.end_line } : {}),
    ...(diagnostic.symbol ? { symbol: diagnostic.symbol } : {}),
  };
}

function evidence(id, outcome, summary, diagnostic) {
  return {
    schema_version: "1.0.0",
    evidence_id: `evidence:node_lint_complexity_${id}`,
    kind: diagnostic ? "source_location" : "static_analysis",
    level: "deterministic",
    outcome,
    summary: summary.slice(0, 500),
    ...(diagnostic ? { location: location(diagnostic) } : {}),
    check_id: "node_lint_complexity",
    collected_at: timestamp(),
    collected_by: PRODUCER,
    redaction: { applied: false, categories: [] },
  };
}

function successfulResult(report) {
  const { counts } = report;
  const failed = counts.lint_errors > 0 || counts.complexity_violations > 0;
  const primarySummary = `ESLint ${NODE_ESLINT_VERSION} analyzed ${report.files_analyzed} tracked JavaScript file(s): ${counts.lint_errors} lint error(s), ${counts.complexity_violations} function(s) above maximum ${NODE_COMPLEXITY_MAXIMUM}, and ${counts.warnings} informational warning(s).`;
  const collected = [evidence("summary", failed ? "fail" : "pass", primarySummary)];
  report.lint_errors.forEach((diagnostic, index) => {
    collected.push(evidence(
      `lint_${index + 1}`,
      "fail",
      `ESLint ${NODE_ESLINT_VERSION} reported error ${diagnostic.rule_id}.`,
      diagnostic,
    ));
  });
  report.complexity_violations.forEach((diagnostic, index) => {
    collected.push(evidence(
      `complexity_${index + 1}`,
      "fail",
      `ESLint ${NODE_ESLINT_VERSION} measured complexity ${diagnostic.value} with classic McCabe maximum ${diagnostic.threshold} for ${diagnostic.symbol}.`,
      diagnostic,
    ));
  });
  report.warnings.forEach((diagnostic, index) => {
    collected.push(evidence(
      `warning_${index + 1}`,
      "observed",
      `ESLint ${NODE_ESLINT_VERSION} reported informational warning ${diagnostic.rule_id}.`,
      diagnostic,
    ));
  });
  return {
    status: failed ? "fail" : "pass",
    reason_code: failed ? "NODE_LINT_COMPLEXITY_FAILED" : "NODE_LINT_COMPLEXITY_PASSED",
    summary: primarySummary,
    evidence: collected,
  };
}

function analyzerError(reasonCode) {
  return {
    status: "error",
    reason_code: reasonCode,
    summary: "The package-owned Node.js analyzer could not produce trustworthy bounded evidence.",
  };
}

function commandError(command) {
  if (command.reason_code === "COMMAND_TIMEOUT") return analyzerError("NODE_ANALYZER_TIMEOUT");
  if (command.reason_code === "COMMAND_OUTPUT_LIMIT") return analyzerError("NODE_ANALYZER_OUTPUT_LIMIT");
  return analyzerError("NODE_ANALYZER_UNAVAILABLE");
}

export async function runNodeLintComplexity(context, dependencies = {}) {
  const listed = await listTrackedFiles(context.target, SOURCE_PATTERNS, context.limits);
  if (listed.status === "error") return listed;
  const runCommand = dependencies.runCommand ?? runBoundedCommand;
  const command = await runCommand(process.execPath, [WORKER_PATH], {
    cwd: context.target,
    ...context.limits,
    env: {},
    input: JSON.stringify({ target: context.target, files: listed.files }),
  });
  if (command.status === "error") return commandError(command);
  if (command.exit_code !== 0) return analyzerError("NODE_ANALYZER_UNAVAILABLE");
  let report;
  try {
    report = JSON.parse(command.stdout);
  } catch {
    return analyzerError("NODE_ANALYZER_MALFORMED");
  }
  const fileSet = new Set(listed.files);
  if (!validateReport(report, fileSet)) return analyzerError("NODE_ANALYZER_MALFORMED");
  if (report.analyzer.id !== "eslint") return analyzerError("NODE_ANALYZER_MISMATCH");
  if (report.analyzer.version !== NODE_ESLINT_VERSION) {
    return analyzerError("NODE_ANALYZER_VERSION_MISMATCH");
  }
  return successfulResult(report);
}
