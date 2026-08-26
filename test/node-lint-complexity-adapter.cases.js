import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "./classified-test.js";

import eslintJs from "@eslint/js";

import { runNodeLintComplexity } from "../src/node-lint-complexity-adapter.js";
import {
  NODE_COMPLEXITY_MAXIMUM,
  NODE_ESLINT_CONFIG,
  NODE_ESLINT_VERSION,
} from "../src/node-eslint-policy.js";

const limits = Object.freeze({ timeoutMs: 60000, maxOutputBytes: 262144 });

async function temporaryRepository(t) {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "node-lint-complexity-test-"));
  t.after(() => fs.rm(target, { recursive: true, force: true }));
  for (const args of [
    ["init"],
    ["config", "user.name", "Adapter Test"],
    ["config", "user.email", "adapter-test@example.invalid"],
  ]) {
    const execution = spawnSync("git", ["-C", target, ...args], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  }
  return target;
}

async function trackedFiles(target, files) {
  for (const [relative, source] of Object.entries(files)) {
    const absolute = path.join(target, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, source);
  }
  const added = spawnSync("git", ["-C", target, "add", "--", ...Object.keys(files)], { encoding: "utf8" });
  assert.equal(added.status, 0, added.stderr);
}

function complexityFixture(symbol, branches) {
  const conditions = Array.from(
    { length: branches },
    (_, index) => `  if (values[${index}]) score += 1;`,
  ).join("\n");
  return `export function ${symbol}(values) {\n  let score = 0;\n${conditions}\n  return score;\n}\n`;
}

function completedWorker(report) {
  return async () => ({
    status: "completed",
    exit_code: 0,
    stdout: `${JSON.stringify(report)}\n`,
    stderr: "",
  });
}

function workerReport(overrides = {}) {
  return {
    protocol_version: "1.0.0",
    analyzer: { id: "eslint", version: "10.8.1" },
    files_analyzed: 1,
    counts: { lint_errors: 0, warnings: 0, complexity_violations: 0 },
    lint_errors: [],
    warnings: [],
    complexity_violations: [],
    ...overrides,
  };
}

test("the package-owned policy fixes exact recommended errors and classic complexity", () => {
  assert.equal(NODE_ESLINT_VERSION, "10.8.1");
  assert.equal(NODE_COMPLEXITY_MAXIMUM, 15);
  assert.equal(NODE_ESLINT_CONFIG.length, 1);
  const [configuration] = NODE_ESLINT_CONFIG;
  assert.equal(configuration.languageOptions.ecmaVersion, 2024);
  assert.equal(configuration.languageOptions.sourceType, "module");
  assert.deepEqual(
    Object.fromEntries(Object.keys(eslintJs.configs.recommended.rules).map((ruleId) => [
      ruleId,
      configuration.rules[ruleId],
    ])),
    eslintJs.configs.recommended.rules,
  );
  assert.deepEqual(configuration.rules.complexity, ["error", { max: 15, variant: "classic" }]);
  assert.equal(configuration.rules["sdd/no-inline-config-directives"], "error");
  assert.equal(Object.values(configuration.rules).some((setting) => setting === "warn" || setting === 1), false);
});

test("classic McCabe complexity allows 15 and blocks every function measured at 16", async (t) => {
  const passingTarget = await temporaryRepository(t);
  await trackedFiles(passingTarget, { "src/boundary.js": complexityFixture("boundary", 14) });
  const passing = await runNodeLintComplexity({ target: passingTarget, limits });
  assert.equal(passing.status, "pass");
  assert.equal(passing.reason_code, "NODE_LINT_COMPLEXITY_PASSED");

  const failingTarget = await temporaryRepository(t);
  await trackedFiles(failingTarget, {
    "src/mixed.js": [
      "export function simple() { return 1; }\n",
      complexityFixture("offender", 15).replace("export function offender", "export async function offender"),
      "export function alsoSimple() { return 2; }\n",
    ].join("\n"),
  });
  const failing = await runNodeLintComplexity({ target: failingTarget, limits });
  assert.equal(failing.status, "fail");
  assert.equal(failing.reason_code, "NODE_LINT_COMPLEXITY_FAILED");
  const finding = failing.evidence.find((item) => item.location?.symbol === "offender");
  assert.ok(finding);
  assert.equal(finding.outcome, "fail");
  assert.equal(finding.location.path, "src/mixed.js");
  assert.match(finding.summary, /ESLint 10\.8\.1/);
  assert.match(finding.summary, /complexity 16/);
  assert.match(finding.summary, /maximum 15/);
});

test("the package-owned lint policy covers ESM and Node globals under bin, src, and test", async (t) => {
  const target = await temporaryRepository(t);
  await trackedFiles(target, {
    "bin/entry.js": "#!/usr/bin/env node\nimport process from 'node:process';\nprocess.stdout.write('ok\\n');\n",
    "src/library.js": "export function bytes(value) { return Buffer.byteLength(value); }\n",
    "test/library.test.js": "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('fixture', () => assert.equal(1, 1));\n",
  });
  const result = await runNodeLintComplexity({ target, limits });
  assert.equal(result.status, "pass");
  assert.match(result.summary, /3 tracked JavaScript file\(s\)/);
});

test("ESLint parse diagnostics remain functional lint failures", async (t) => {
  const target = await temporaryRepository(t);
  await trackedFiles(target, {
    "src/invalid.js": "export function invalid( {\n",
  });

  const result = await runNodeLintComplexity({ target, limits });

  assert.equal(result.status, "fail");
  assert.equal(result.reason_code, "NODE_LINT_COMPLEXITY_FAILED");
  const finding = result.evidence.find((item) => item.location?.path === "src/invalid.js");
  assert.ok(finding);
  assert.equal(finding.outcome, "fail");
  assert.match(finding.summary, /eslint-parse-error/);
});

test("lint errors block while warnings remain observed and do not change status", async (t) => {
  const target = await temporaryRepository(t);
  await trackedFiles(target, {
    "src/lint-error.js": "export function broken() { return missingValue; }\n",
  });
  const failed = await runNodeLintComplexity({ target, limits });
  assert.equal(failed.status, "fail");
  const lintFinding = failed.evidence.find((item) => item.location?.path === "src/lint-error.js");
  assert.ok(lintFinding);
  assert.equal(lintFinding.outcome, "fail");
  assert.match(lintFinding.summary, /no-undef/);

  const warningTarget = await temporaryRepository(t);
  await trackedFiles(warningTarget, { "src/warning.js": "export const value = 1;\n" });
  const warning = await runNodeLintComplexity(
    { target: warningTarget, limits },
    {
      runCommand: completedWorker(workerReport({
        counts: { lint_errors: 0, warnings: 1, complexity_violations: 0 },
        warnings: [{
          rule_id: "example-warning",
          message_id: "example",
          path: "src/warning.js",
          line: 1,
          column: 1,
          symbol: "value",
        }],
      })),
    },
  );
  assert.equal(warning.status, "pass");
  assert.equal(warning.evidence.some((item) => item.outcome === "observed"), true);
});

test("target ESLint configuration is ignored and inline directives are rejected", async (t) => {
  const configuredTarget = await temporaryRepository(t);
  await trackedFiles(configuredTarget, {
    "eslint.config.js": "throw new Error('target eslint configuration was loaded');\n",
    "src/clean.js": "export const clean = 1;\n",
  });
  const ignored = await runNodeLintComplexity({ target: configuredTarget, limits });
  assert.equal(ignored.status, "pass");

  const suppressedTarget = await temporaryRepository(t);
  await trackedFiles(suppressedTarget, {
    "src/suppressed.js": "/* eslint-disable no-undef */\nexport function broken() { return missingValue; }\n",
  });
  const rejected = await runNodeLintComplexity({ target: suppressedTarget, limits });
  assert.equal(rejected.status, "fail");
  assert.equal(
    rejected.evidence.some((item) => item.summary.includes("sdd/no-inline-config-directives")),
    true,
  );
});

test("only tracked JavaScript under the approved roots is analyzed", async (t) => {
  const target = await temporaryRepository(t);
  await trackedFiles(target, {
    "src/clean.js": "export const clean = 1;\n",
    "other/tracked-error.js": "export const outside = missingOutside;\n",
  });
  await fs.writeFile(path.join(target, "src", "untracked-error.js"), "export const ignored = missingUntracked;\n");
  const result = await runNodeLintComplexity({ target, limits });
  assert.equal(result.status, "pass");
  assert.match(result.summary, /analyzed 1 tracked JavaScript file\(s\)/);
});

test("missing, mismatched, malformed, timed out, and overflowing analyzers are errors", async (t) => {
  const target = await temporaryRepository(t);
  await trackedFiles(target, { "src/clean.js": "export const clean = 1;\n" });
  const cases = [
    [{ status: "error", reason_code: "COMMAND_SPAWN_FAILED" }, "NODE_ANALYZER_UNAVAILABLE"],
    [{ status: "error", reason_code: "COMMAND_TIMEOUT" }, "NODE_ANALYZER_TIMEOUT"],
    [{ status: "error", reason_code: "COMMAND_OUTPUT_LIMIT" }, "NODE_ANALYZER_OUTPUT_LIMIT"],
    [{ status: "completed", exit_code: 0, stdout: "not-json", stderr: "secret output" }, "NODE_ANALYZER_MALFORMED"],
  ];
  for (const [execution, reasonCode] of cases) {
    const result = await runNodeLintComplexity(
      { target, limits },
      { runCommand: async () => execution },
    );
    assert.equal(result.status, "error");
    assert.equal(result.reason_code, reasonCode);
    assert.doesNotMatch(JSON.stringify(result), /secret output/);
  }

  const mismatch = await runNodeLintComplexity(
    { target, limits },
    { runCommand: completedWorker(workerReport({ analyzer: { id: "eslint", version: "10.8.0" } })) },
  );
  assert.equal(mismatch.status, "error");
  assert.equal(mismatch.reason_code, "NODE_ANALYZER_VERSION_MISMATCH");
});

test("target-owned NODE_OPTIONS cannot preload a forged analyzer pass", async (t) => {
  const target = await temporaryRepository(t);
  await trackedFiles(target, {
    "src/bad.js": `${complexityFixture("tooComplex", 15)}\nexport const lintError = missingValue;\n`,
  });
  const forged = workerReport({ files_analyzed: 1 });
  const preload = path.join(target, "forge.cjs");
  await fs.writeFile(
    preload,
    `process.stdout.write(${JSON.stringify(`${JSON.stringify(forged)}\n`)}); process.exit(0);\n`,
  );
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require=${preload}`;
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  });

  const result = await runNodeLintComplexity({ target, limits });
  assert.equal(result.status, "fail");
  assert.match(result.summary, /1 lint error\(s\), 1 function\(s\) above maximum 15/);
});

test("ambient ESLint timing output cannot contaminate the worker protocol", async (t) => {
  const target = await temporaryRepository(t);
  await trackedFiles(target, { "src/clean.js": "export const clean = 1;\n" });
  const previous = process.env.TIMING;
  process.env.TIMING = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.TIMING;
    else process.env.TIMING = previous;
  });

  const result = await runNodeLintComplexity({ target, limits });
  assert.equal(result.status, "pass");
});

test("the worker receives an empty environment without ambient secrets", async (t) => {
  const target = await temporaryRepository(t);
  await trackedFiles(target, { "src/clean.js": "export const clean = 1;\n" });
  const previous = process.env.SDD_SECRET_CANARY;
  process.env.SDD_SECRET_CANARY = "must-not-reach-worker";
  t.after(() => {
    if (previous === undefined) delete process.env.SDD_SECRET_CANARY;
    else process.env.SDD_SECRET_CANARY = previous;
  });
  let workerEnvironment;
  const result = await runNodeLintComplexity(
    { target, limits },
    {
      runCommand: async (executable, args, options) => {
        workerEnvironment = options.env;
        return completedWorker(workerReport())();
      },
    },
  );
  assert.equal(result.status, "pass");
  assert.deepEqual(workerEnvironment, {});
  assert.doesNotMatch(JSON.stringify(result), /must-not-reach-worker/);
});

test("malformed normalized diagnostics fail closed without exposing analyzer payloads", async (t) => {
  const target = await temporaryRepository(t);
  await trackedFiles(target, { "src/clean.js": "export const clean = 1;\n" });
  const malformed = workerReport({
    counts: { lint_errors: 1, warnings: 0, complexity_violations: 0 },
    lint_errors: [{
      rule_id: "no-undef",
      message_id: "undef",
      path: "../escape.js",
      line: 1,
      column: 1,
      raw: "token=raw-analyzer-payload",
    }],
  });
  const result = await runNodeLintComplexity(
    { target, limits },
    { runCommand: completedWorker(malformed) },
  );
  assert.equal(result.status, "error");
  assert.equal(result.reason_code, "NODE_ANALYZER_MALFORMED");
  assert.doesNotMatch(JSON.stringify(result), /raw-analyzer-payload/);
});

test("tracked symlinks cannot escape the target realpath boundary", async (t) => {
  const target = await temporaryRepository(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "node-lint-complexity-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "escaped.js"), "export const secret = 'must-not-leak';\n");
  await fs.mkdir(path.join(target, "src"));
  await fs.symlink(path.join(outside, "escaped.js"), path.join(target, "src", "escaped.js"));
  const added = spawnSync("git", ["-C", target, "add", "--", "src/escaped.js"], { encoding: "utf8" });
  assert.equal(added.status, 0, added.stderr);

  const result = await runNodeLintComplexity({ target, limits });
  assert.equal(result.status, "error");
  assert.equal(result.reason_code, "SOURCE_UNSAFE_PATH");
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
});

test("evidence is bounded, canonical, and excludes source, raw output, environment, and traces", async (t) => {
  const target = await temporaryRepository(t);
  const sensitive = "token=source-secret-value";
  await trackedFiles(target, {
    "src/bounded.js": `export function broken() { const payload = '${sensitive}'; return payload + missingValue; }\n`,
  });
  const result = await runNodeLintComplexity({ target, limits });
  const serialized = JSON.stringify(result);
  assert.equal(result.status, "fail");
  assert.equal(result.evidence.every((item) => item.check_id === "node_lint_complexity"), true);
  assert.equal(result.evidence.every((item) => item.collected_by.id === "sdd_engineering_gates"), true);
  assert.equal(result.evidence.every((item) => item.summary.length <= 500), true);
  assert.doesNotMatch(serialized, /source-secret-value/);
  assert.doesNotMatch(serialized, /process\.env|stack|trace|raw/i);
});
