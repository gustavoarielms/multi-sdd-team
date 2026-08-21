import fs from "node:fs/promises";
import path from "node:path";

import { ESLint } from "eslint";

import {
  NODE_COMPLEXITY_MAXIMUM,
  NODE_ESLINT_CONFIG,
  NODE_ESLINT_VERSION,
} from "./node-eslint-policy.js";

const MAX_DIAGNOSTICS_PER_KIND = 50;
const PARSE_ERROR_RULE_ID = "eslint-parse-error";
const COMPLEXITY_MESSAGE = /^(?<kind>.+) has a complexity of (?<value>[0-9]+)\. Maximum allowed is (?<threshold>[0-9]+)\.$/u;
const NAMED_SYMBOL = /^(?:Async )?(?:Function|function|Generator function|generator function|Method|method) '(?<symbol>[^']+)'$/u;

function normalizeSymbol(kind) {
  return NAMED_SYMBOL.exec(kind)?.groups?.symbol ?? kind;
}

function normalizeLocation(target, result, message) {
  const relative = path.relative(target, result.filePath).split(path.sep).join("/");
  return {
    path: relative,
    line: message.line,
    column: message.column,
    ...(message.endLine ? { end_line: message.endLine } : {}),
    ...(message.endColumn ? { end_column: message.endColumn } : {}),
  };
}

function normalizeMessage(target, result, message) {
  const ruleId = message.ruleId === null && message.fatal === true
    ? PARSE_ERROR_RULE_ID
    : message.ruleId;
  if (typeof ruleId !== "string" || ruleId.length === 0
    || !Number.isInteger(message.line) || !Number.isInteger(message.column)) {
    throw new Error("malformed analyzer diagnostic");
  }
  return {
    rule_id: ruleId,
    ...(message.messageId ? { message_id: message.messageId } : {}),
    ...normalizeLocation(target, result, message),
  };
}

function normalizeComplexity(target, result, message) {
  if (message.ruleId !== "complexity" || message.messageId !== "complex") {
    throw new Error("unexpected complexity diagnostic");
  }
  const parsed = COMPLEXITY_MESSAGE.exec(message.message);
  if (!parsed?.groups) throw new Error("malformed complexity diagnostic");
  const value = Number(parsed.groups.value);
  const threshold = Number(parsed.groups.threshold);
  if (!Number.isInteger(value) || threshold !== NODE_COMPLEXITY_MAXIMUM || value <= threshold) {
    throw new Error("invalid complexity diagnostic");
  }
  return {
    ...normalizeMessage(target, result, message),
    symbol: normalizeSymbol(parsed.groups.kind),
    value,
    threshold,
  };
}

async function readManifest() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const manifest = JSON.parse(input);
  if (!manifest || typeof manifest.target !== "string" || !Array.isArray(manifest.files)
    || manifest.files.some((file) => typeof file !== "string")) {
    throw new Error("invalid worker manifest");
  }
  return manifest;
}

async function analyze() {
  const manifest = await readManifest();
  const target = await fs.realpath(manifest.target);
  if (ESLint.version !== NODE_ESLINT_VERSION) throw new Error("analyzer version mismatch");
  const eslint = new ESLint({
    cwd: target,
    overrideConfigFile: true,
    overrideConfig: NODE_ESLINT_CONFIG,
    allowInlineConfig: false,
    ignore: false,
    applySuppressions: false,
    cache: false,
    globInputPaths: false,
  });
  const results = manifest.files.length === 0 ? [] : await eslint.lintFiles(manifest.files);
  const lintErrors = [];
  const warnings = [];
  const complexityViolations = [];
  let lintErrorCount = 0;
  let warningCount = 0;
  let complexityCount = 0;

  for (const result of results) {
    for (const message of result.messages) {
      if (message.ruleId === "complexity") {
        complexityCount += 1;
        const normalized = normalizeComplexity(target, result, message);
        if (complexityViolations.length < MAX_DIAGNOSTICS_PER_KIND) complexityViolations.push(normalized);
      } else if (message.severity === 2) {
        lintErrorCount += 1;
        const normalized = normalizeMessage(target, result, message);
        if (lintErrors.length < MAX_DIAGNOSTICS_PER_KIND) lintErrors.push(normalized);
      } else if (message.severity === 1) {
        warningCount += 1;
        const normalized = normalizeMessage(target, result, message);
        if (warnings.length < MAX_DIAGNOSTICS_PER_KIND) warnings.push(normalized);
      } else {
        throw new Error("unsupported analyzer severity");
      }
    }
  }

  return {
    protocol_version: "1.0.0",
    analyzer: { id: "eslint", version: ESLint.version },
    files_analyzed: results.length,
    counts: {
      lint_errors: lintErrorCount,
      warnings: warningCount,
      complexity_violations: complexityCount,
    },
    lint_errors: lintErrors,
    warnings,
    complexity_violations: complexityViolations,
  };
}

try {
  process.stdout.write(`${JSON.stringify(await analyze())}\n`);
} catch {
  process.exitCode = 2;
}
