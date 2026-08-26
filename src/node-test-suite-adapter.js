import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isContained, runBoundedCommand } from "./engineering-gate-runtime.js";

const REPORTER_PATH = fileURLToPath(new URL("./node-test-reporter.js", import.meta.url));
const SUITES = Object.freeze({ unit: "test/unit", integration: "test/integration" });
const COUNT_KEYS = Object.freeze(["tests", "passed", "failed", "cancelled", "skipped", "todo", "suites"]);

async function discoverTests(target, suite) {
  const relativeRoot = SUITES[suite];
  if (!relativeRoot) return { error: "TEST_SUITE_UNKNOWN" };
  let realTarget;
  let realRoot;
  try {
    realTarget = await fs.realpath(target);
    const rootStat = await fs.lstat(path.join(realTarget, relativeRoot));
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { error: "TEST_SUITE_UNSAFE_PATH" };
    realRoot = await fs.realpath(path.join(realTarget, relativeRoot));
  } catch {
    return { error: "TEST_SUITE_MISSING" };
  }
  if (!isContained(realTarget, realRoot)) return { error: "TEST_SUITE_UNSAFE_PATH" };
  const entries = await fs.readdir(realRoot, { withFileTypes: true, recursive: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) return { error: "TEST_SUITE_UNSAFE_PATH" };
    if (!entry.isFile() || !entry.name.endsWith(".test.js")) continue;
    const parentPath = entry.parentPath ?? entry.path;
    const absolute = path.join(parentPath, entry.name);
    const real = await fs.realpath(absolute);
    if (!isContained(realRoot, real)) return { error: "TEST_SUITE_UNSAFE_PATH" };
    files.push(path.relative(realTarget, real));
  }
  files.sort();
  return files.length === 0 ? { error: "TEST_SUITE_EMPTY" } : { files };
}

function parseReporter(stdout, suite) {
  if (Buffer.byteLength(stdout) > 65536) return { error: "TEST_REPORTER_OVERFLOW" };
  let report;
  try {
    const lines = stdout.trim().split("\n");
    if (lines.length !== 1) return { error: "TEST_REPORTER_MALFORMED" };
    report = JSON.parse(lines[0]);
  } catch {
    return { error: "TEST_REPORTER_MALFORMED" };
  }
  const keys = Object.keys(report).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["counts", "failures", "protocol_version", "status", "suite"])) {
    return { error: "TEST_REPORTER_MALFORMED" };
  }
  if (report.protocol_version !== "1.0.0" || report.suite !== suite || !["pass", "fail"].includes(report.status)) {
    return { error: "TEST_REPORTER_MALFORMED" };
  }
  if (!report.counts || Object.keys(report.counts).sort().join(",") !== [...COUNT_KEYS].sort().join(",")
    || COUNT_KEYS.some((key) => !Number.isInteger(report.counts[key]) || report.counts[key] < 0)) {
    return { error: "TEST_REPORTER_MALFORMED" };
  }
  if (!Array.isArray(report.failures) || report.failures.length > 20
    || report.failures.some((failure) => Object.keys(failure).join(",") !== "name"
      || typeof failure.name !== "string" || failure.name.length > 200)) {
    return { error: "TEST_REPORTER_MALFORMED" };
  }
  return { report };
}

function classifySuiteExecution(command, report, suite) {
  const { counts } = report;
  if (counts.tests === 0) return { status: "error", reason_code: "TEST_SUITE_UNDISCOVERED" };
  if (counts.cancelled > 0 || counts.skipped > 0 || counts.todo > 0
    || counts.passed + counts.failed + counts.cancelled + counts.skipped + counts.todo !== counts.tests) {
    return { status: "error", reason_code: "TEST_SUITE_INCONSISTENT" };
  }
  const summary = `${suite} tests: ${counts.tests} total, ${counts.passed} passed, ${counts.failed} failed, 0 skipped, 0 todo.`;
  if (counts.failed > 0 && command.exit_code !== 0 && report.status === "fail") {
    return { status: "fail", reason_code: `${suite.toUpperCase()}_TESTS_FAILED`, summary };
  }
  if (counts.failed === 0 && command.exit_code === 0 && report.status === "pass") {
    return { status: "pass", reason_code: `${suite.toUpperCase()}_TESTS_PASSED`, summary };
  }
  return { status: "error", reason_code: "TEST_SUITE_INCONSISTENT" };
}

export async function runNodeTestSuite(context, suite, runner = runBoundedCommand) {
  const discovery = await discoverTests(context.target, suite);
  if (discovery.error) return { status: "error", reason_code: discovery.error };
  const command = await runner(process.execPath, [
    "--test",
    `--test-reporter=${REPORTER_PATH}`,
    ...discovery.files,
  ], {
    cwd: context.target,
    env: { PATH: process.env.PATH ?? "", SDD_TEST_SUITE: suite },
    ...context.limits,
  });
  if (command.status === "error") return command;
  const parsed = parseReporter(command.stdout, suite);
  if (parsed.error) return { status: "error", reason_code: parsed.error };
  return classifySuiteExecution(command, parsed.report, suite);
}

export function runUnitTests(context) {
  return runNodeTestSuite(context, "unit");
}

export function runIntegrationTests(context) {
  return runNodeTestSuite(context, "integration");
}
