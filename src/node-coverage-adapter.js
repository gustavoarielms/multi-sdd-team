import { createRequire } from "node:module";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { Worker } from "node:worker_threads";

import istanbulCoverage from "istanbul-lib-coverage";

import { isContained, runBoundedCommand } from "./engineering-gate-runtime.js";
import { collectProductionChanges } from "./git-change-selector.js";

const require = createRequire(import.meta.url);
const { createCoverageMap } = istanbulCoverage;
const C8_PATH = require.resolve("c8/bin/c8.js");
const REPORTER_PATH = fileURLToPath(new URL("./node-test-reporter.js", import.meta.url));
const METRICS = Object.freeze(["lines", "branches", "functions", "statements"]);
const GLOBAL_THRESHOLDS = Object.freeze({ lines: 85, branches: 80, functions: 85, statements: 85 });
const CHANGED_THRESHOLDS = Object.freeze({ lines: 90, branches: 85, functions: 90, statements: 90 });
const MAX_MAP_BYTES = 10 * 1024 * 1024;
const MAX_MAP_FILES = 2000;
const MAX_ITEMS = 500000;
const MAX_JSON_DEPTH = 64;
const MAX_BRANCH_ITEMS = 1000;
export const COVERAGE_LIMITS = Object.freeze({
  maxChangedLocations: 500000,
  maxLocationSpanLines: 100000,
});

export function meetsCoverageThreshold(counts, threshold) {
  return counts.covered * 100 >= threshold * counts.total;
}

function validPosition(position) {
  return Number.isSafeInteger(position?.line) && position.line > 0
    && Number.isSafeInteger(position?.column) && position.column >= -1 && position.column <= 1000000;
}

function validLocation(location, sourceLineCount) {
  if (!validPosition(location?.start) || !validPosition(location?.end)) return false;
  if (location.start.line > sourceLineCount || location.end.line > sourceLineCount) return false;
  if (location.end.line - location.start.line + 1 > COVERAGE_LIMITS.maxLocationSpanLines) return false;
  return location.start.line < location.end.line
    || (location.start.line === location.end.line && location.start.column <= location.end.column);
}

function validChangedDescriptor(changed) {
  return changed
    && Array.isArray(changed.intervals)
    && Number.isSafeInteger(changed.total)
    && changed.total >= 0
    && Number.isSafeInteger(changed.sourceLineCount)
    && changed.sourceLineCount >= 0;
}

function changedIntervalLength(interval, previousEnd, sourceLineCount) {
  const valid = Number.isSafeInteger(interval?.start)
    && Number.isSafeInteger(interval?.end)
    && interval.start > previousEnd
    && interval.start >= 1
    && interval.end >= interval.start
    && interval.end <= sourceLineCount;
  if (!valid) throw new Error("Invalid coverage location.");
  return interval.end - interval.start + 1;
}

function validateChangedIntervals(changed) {
  if (!validChangedDescriptor(changed)) throw new Error("Invalid coverage location.");
  let total = 0;
  let previousEnd = 0;
  for (const interval of changed.intervals) {
    total += changedIntervalLength(interval, previousEnd, changed.sourceLineCount);
    if (!Number.isSafeInteger(total)) throw new Error("Invalid coverage location.");
    previousEnd = interval.end;
  }
  if (total !== changed.total) throw new Error("Invalid coverage location.");
}

function intersects(location, changed) {
  if (!validLocation(location, changed.sourceLineCount)) throw new Error("Invalid coverage location.");
  let low = 0;
  let high = changed.intervals.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (changed.intervals[middle].end < location.start.line) low = middle + 1;
    else high = middle;
  }
  return low < changed.intervals.length && changed.intervals[low].start <= location.end.line;
}

function consumeLocation(budget) {
  if (!budget || !Number.isSafeInteger(budget.used) || budget.used < 0
    || budget.used >= COVERAGE_LIMITS.maxChangedLocations) throw new Error("Invalid coverage location.");
  budget.used += 1;
}

function addCount(counts, metric, covered) {
  counts[metric].total += 1;
  if (covered) counts[metric].covered += 1;
}

export function selectChangedCoverage(fileCoverage, changed, budget = { used: 0 }) {
  validateChangedIntervals(changed);
  const counts = Object.fromEntries(METRICS.map((metric) => [metric, { covered: 0, total: 0 }]));
  selectChangedLines(fileCoverage.getLineCoverage(), changed, budget, counts);
  selectMappedLocations(fileCoverage.statementMap, fileCoverage.s, "statements", changed, budget, counts);
  const functionLocations = Object.fromEntries(
    Object.entries(fileCoverage.fnMap).map(([identifier, definition]) => [identifier, definition.loc]),
  );
  selectMappedLocations(functionLocations, fileCoverage.f, "functions", changed, budget, counts);
  selectChangedBranches(fileCoverage.branchMap, fileCoverage.b, changed, budget, counts);
  return counts;
}

function selectChangedLines(lineCoverage, changed, budget, counts) {
  for (const [line, hits] of Object.entries(lineCoverage)) {
    consumeLocation(budget);
    const lineNumber = Number(line);
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || lineNumber > changed.sourceLineCount
      || !Number.isSafeInteger(hits) || hits < 0) throw new Error("Invalid coverage location.");
    if (intersects({ start: { line: lineNumber, column: 0 }, end: { line: lineNumber, column: 0 } }, changed)) {
      addCount(counts, "lines", hits > 0);
    }
  }
}

function selectMappedLocations(locationMap, hitsMap, metric, changed, budget, counts) {
  for (const [identifier, location] of Object.entries(locationMap)) {
    consumeLocation(budget);
    if (intersects(location, changed)) addCount(counts, metric, hitsMap[identifier] > 0);
  }
}

function selectChangedBranches(branchMap, branchHits, changed, budget, counts) {
  for (const [identifier, definition] of Object.entries(branchMap)) {
    const hits = branchHits[identifier];
    if (!Array.isArray(definition.locations) || !Array.isArray(hits) || definition.locations.length !== hits.length) {
      throw new Error("Invalid coverage location.");
    }
    definition.locations.forEach((location, index) => {
      consumeLocation(budget);
      if (intersects(location, changed)) addCount(counts, "branches", hits[index] > 0);
    });
  }
}

function abortError() {
  const error = new Error("coverage map parse aborted");
  error.name = "AbortError";
  return error;
}

export function parseCoverageMapSource(source, limits = {}) {
  if (limits.signal?.aborted) return Promise.reject(abortError());
  const timeoutMs = limits.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    return Promise.reject(new Error("invalid coverage map parse timeout"));
  }
  const worker = new Worker(new URL("./coverage-map-worker.js", import.meta.url), {
    workerData: {
      source,
      maxDepth: MAX_JSON_DEPTH,
      maxFiles: MAX_MAP_FILES,
      maxItems: MAX_ITEMS,
      maxBranchItems: MAX_BRANCH_ITEMS,
    },
  });
  return new Promise((resolve, reject) => {
    let finishing = false;
    const cleanup = () => {
      clearTimeout(timer);
      limits.signal?.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
    };
    const finish = async (error, value) => {
      if (finishing) return;
      finishing = true;
      cleanup();
      await worker.terminate();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => void finish(abortError());
    const timer = setTimeout(() => void finish(new Error("coverage map parse timeout")), timeoutMs);
    limits.signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message) => {
      if (message?.ok === true) void finish(undefined, message.value);
      else void finish(new Error("invalid coverage map"));
    });
    worker.once("error", () => void finish(new Error("invalid coverage map")));
    worker.once("exit", (code) => {
      if (!finishing) void finish(new Error(`invalid coverage map worker exit ${code}`));
    });
    if (limits.signal?.aborted) onAbort();
  });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableFile(before, after) {
  return sameIdentity(before, after)
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

async function boundedHandleRead(handle, expectedSize, signal) {
  const buffer = Buffer.alloc(expectedSize + 1);
  let offset = 0;
  while (offset < buffer.length) {
    if (signal?.aborted) throw abortError();
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== expectedSize) throw new Error("unsafe coverage map");
  return buffer.subarray(0, expectedSize);
}

async function openOwnedMap(mapPath, ownedRoot, io) {
  const [realMap, realOwned] = await Promise.all([fs.realpath(mapPath), fs.realpath(ownedRoot)]);
  if (!isContained(realOwned, realMap)) throw new Error("unsafe coverage map");
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  return io.open(mapPath, flags);
}

async function readStableMapBytes(mapPath, ownedRoot, limits, io) {
  let handle;
  try {
    handle = await openOwnedMap(mapPath, ownedRoot, io);
    const before = await handle.stat({ bigint: true });
    const pathBefore = await fs.lstat(mapPath, { bigint: true });
    if (!before.isFile() || !pathBefore.isFile() || pathBefore.isSymbolicLink()
      || !sameIdentity(before, pathBefore) || before.size > BigInt(MAX_MAP_BYTES)) {
      throw new Error("unsafe coverage map");
    }
    const bytes = await boundedHandleRead(handle, Number(before.size), limits.signal);
    const [after, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(mapPath, { bigint: true }),
    ]);
    if (!stableFile(before, after) || !sameIdentity(after, pathAfter) || pathAfter.isSymbolicLink()) {
      throw new Error("unsafe coverage map");
    }
    return bytes;
  } finally {
    if (handle) await handle.close();
  }
}

export async function readOwnedCoverageMap(mapPath, ownedRoot, target, allowedPaths, limits = {}, injectedIo = {}) {
  const bytes = await readStableMapBytes(mapPath, ownedRoot, limits, { open: injectedIo.open ?? fs.open });
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = await parseCoverageMapSource(source, limits);
  const realTarget = await fs.realpath(target);
  for (const [file, coverage] of Object.entries(value)) {
    const absolute = path.resolve(file);
    if (!isContained(realTarget, absolute)) throw new Error("unsafe coverage source");
    const relative = path.relative(realTarget, absolute).split(path.sep).join("/");
    if (!allowedPaths.has(relative) || coverage.path !== file) throw new Error("unexpected coverage source");
  }
  return value;
}

async function rejectTargetCoverageControls(target, productionPaths) {
  const rootEntries = await fs.readdir(target);
  if (rootEntries.some((name) => name.startsWith(".c8rc") || name.startsWith(".nycrc"))) {
    throw new Error("target coverage configuration");
  }
  const packageJson = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf8"));
  if (Object.hasOwn(packageJson, "c8") || Object.hasOwn(packageJson, "nyc")) throw new Error("target coverage configuration");
  const ignorePattern = /(?:c8|istanbul|nyc)\s+ignore/i;
  for (const relative of productionPaths) {
    if (ignorePattern.test(await fs.readFile(path.join(target, relative), "utf8"))) {
      throw new Error("coverage suppression");
    }
  }
}

async function safeSuiteRoot(target, suite) {
  const realTarget = await fs.realpath(target);
  const root = path.join(realTarget, "test", suite);
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe coverage suite");
  const realRoot = await fs.realpath(root);
  if (!isContained(realTarget, realRoot)) throw new Error("unsafe coverage suite");
  return { realTarget, realRoot };
}

async function safeSuiteEntry(entry, realRoot, realTarget) {
  const absolute = path.join(entry.parentPath ?? entry.path, entry.name);
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) throw new Error("unsafe coverage suite");
  const real = await fs.realpath(absolute);
  if (!isContained(realRoot, real)) throw new Error("unsafe coverage suite");
  if (!stat.isFile() || !entry.name.endsWith(".test.js")) return null;
  return path.relative(realTarget, real);
}

async function discoverSuiteFiles(target, suite) {
  const { realTarget, realRoot } = await safeSuiteRoot(target, suite);
  const entries = await fs.readdir(realRoot, { withFileTypes: true, recursive: true });
  const files = [];
  for (const entry of entries) {
    const relative = await safeSuiteEntry(entry, realRoot, realTarget);
    if (relative) files.push(relative);
  }
  return files.sort();
}

async function runCoverageSuite(target, suite, productionPaths, root, configPath, limits, runner) {
  const reportDirectory = path.join(root, `${suite}-report`);
  const temporaryDirectory = path.join(root, `${suite}-v8`);
  await fs.mkdir(reportDirectory);
  await fs.mkdir(temporaryDirectory);
  const tests = await discoverSuiteFiles(target, suite);
  if (tests.length === 0) throw new Error("empty coverage suite");
  const args = [
    C8_PATH,
    `--config=${configPath}`,
    "--reporter=json",
    `--reports-dir=${reportDirectory}`,
    `--temp-directory=${temporaryDirectory}`,
    "--all",
    ...productionPaths.flatMap((relative) => ["--include", relative]),
    process.execPath,
    "--test",
    `--test-reporter=${REPORTER_PATH}`,
    ...tests,
  ];
  const command = await runner(process.execPath, args, {
    cwd: target,
    env: { PATH: process.env.PATH ?? "", SDD_TEST_SUITE: suite },
    ...limits,
  });
  if (command.status === "error") return command;
  return command.exit_code === 0
    ? { status: "completed", mapPath: path.join(reportDirectory, "coverage-final.json") }
    : { status: "error", reason_code: "COVERAGE_EXECUTION_FAILED" };
}

function emptyCounts() {
  return Object.fromEntries(METRICS.map((metric) => [metric, { covered: 0, total: 0 }]));
}

function addCounts(target, additions) {
  for (const metric of METRICS) {
    target[metric].covered += additions[metric].covered;
    target[metric].total += additions[metric].total;
  }
}

function summaryCounts(map, requireNonEmpty = false) {
  const summary = map.getCoverageSummary();
  const counts = Object.fromEntries(METRICS.map((metric) => [metric, {
    covered: summary[metric].covered,
    total: summary[metric].total,
  }]));
  if (requireNonEmpty && METRICS.some((metric) => counts[metric].total === 0)) {
    throw new Error("empty coverage denominator");
  }
  return counts;
}

function passes(counts, thresholds) {
  return METRICS.every((metric) => meetsCoverageThreshold(counts[metric], thresholds[metric]));
}

function evidence(checkId, outcome, counts) {
  const details = METRICS.map((metric) => `${metric} ${counts[metric].covered}/${counts[metric].total}`).join(", ");
  return {
    schema_version: "1.0.0",
    evidence_id: `evidence:${checkId}`,
    kind: "test_result",
    level: "deterministic",
    outcome,
    summary: outcome === "not_applicable" ? "No changed or new production coverage item is applicable." : details,
    check_id: checkId,
    collected_at: new Date().toISOString(),
    collected_by: { kind: "deterministic", id: "sdd_engineering_gates", runtime: "ci" },
    redaction: { applied: false, categories: [] },
  };
}

function coverageResult(globalCounts, changedCounts) {
  const globalPass = passes(globalCounts, GLOBAL_THRESHOLDS);
  const changedApplicable = METRICS.some((metric) => changedCounts[metric].total > 0);
  const changedPass = !changedApplicable || passes(changedCounts, CHANGED_THRESHOLDS);
  const globalEvidence = evidence("coverage_global", globalPass ? "pass" : "fail", globalCounts);
  const changedEvidence = evidence("coverage_changed", changedApplicable ? (changedPass ? "pass" : "fail") : "not_applicable", changedCounts);
  const checks = [
    { check_id: "coverage_global", rule_id: "TEST-COVERAGE-GLOBAL-001", status: globalPass ? "pass" : "fail", gate_effect: "block", summary: globalEvidence.summary, evidence_ids: [globalEvidence.evidence_id] },
    { check_id: "coverage_changed", rule_id: "TEST-COVERAGE-CHANGED-001", status: changedPass ? "pass" : "fail", gate_effect: changedApplicable ? "block" : "none", summary: changedEvidence.summary, evidence_ids: [changedEvidence.evidence_id] },
  ];
  const status = globalPass && changedPass ? "pass" : "fail";
  return { status, reason_code: status === "pass" ? "COVERAGE_PASSED" : "COVERAGE_FAILED", summary: "Combined unit and integration coverage was evaluated with exact item counts.", evidence: [globalEvidence, changedEvidence], checks };
}

async function prepareCoverage(context, runner, state) {
  const base = context.comparisonBase?.effective_merge_base_sha;
  if (!/^[a-f0-9]{40}$/.test(base ?? "")) {
    return { result: { status: "error", reason_code: "COMPARISON_BASE_INVALID" } };
  }
  const production = await collectProductionChanges(context.target, base, context.limits, runner);
  if (production.status === "error") return { result: production };
  const allPaths = [...new Set([...production.tracked, ...production.untracked])].sort();
  if (production.tracked.length === 0) {
    return { result: { status: "error", reason_code: "COVERAGE_EMPTY_PRODUCTION" } };
  }
  state.phase = "controls";
  await rejectTargetCoverageControls(context.target, allPaths);
  state.temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-node-coverage-"));
  const configPath = path.join(state.temporaryRoot, "c8-config.json");
  await fs.writeFile(configPath, "{}\n", { flag: "wx", mode: 0o600 });
  return { production, allPaths, configPath };
}

async function collectCoverageMaps(context, runner, state, prepared) {
  state.phase = "unit";
  const unit = await runCoverageSuite(
    context.target,
    "unit",
    prepared.allPaths,
    state.temporaryRoot,
    prepared.configPath,
    context.limits,
    runner,
  );
  if (unit.status === "error") return { result: unit };
  state.phase = "integration";
  const integration = await runCoverageSuite(
    context.target,
    "integration",
    prepared.allPaths,
    state.temporaryRoot,
    prepared.configPath,
    context.limits,
    runner,
  );
  if (integration.status === "error") return { result: integration };
  state.phase = "map";
  const allowed = new Set(prepared.allPaths);
  const [unitValue, integrationValue] = await Promise.all([
    readOwnedCoverageMap(unit.mapPath, state.temporaryRoot, context.target, allowed, context.limits),
    readOwnedCoverageMap(integration.mapPath, state.temporaryRoot, context.target, allowed, context.limits),
  ]);
  const combined = createCoverageMap(unitValue);
  combined.merge(integrationValue);
  return { combined };
}

function evaluateCoverage(context, production, combined, state) {
  state.phase = "evaluation";
  const globalMap = createCoverageMap();
  for (const relative of production.tracked) {
    globalMap.addFileCoverage(combined.fileCoverageFor(path.resolve(context.target, relative)));
  }
  state.phase = "denominator";
  const globalCounts = summaryCounts(globalMap, true);
  state.phase = "evaluation";
  const changedCounts = emptyCounts();
  const locationBudget = { used: 0 };
  for (const [relative, changed] of production.changed) {
    const absolute = path.resolve(context.target, relative);
    if (!combined.data[absolute]) throw new Error("missing changed coverage source");
    addCounts(changedCounts, selectChangedCoverage(combined.fileCoverageFor(absolute), changed, locationBudget));
  }
  return coverageResult(globalCounts, changedCounts);
}

function coverageError(error, context, phase) {
  if (error?.name === "AbortError" || context.limits?.signal?.aborted) {
    return { status: "error", reason_code: "EXECUTOR_ABORTED" };
  }
  const reasons = {
    controls: "COVERAGE_CONFIGURATION_REJECTED",
    unit: "COVERAGE_UNIT_EXECUTION_ERROR",
    integration: "COVERAGE_INTEGRATION_EXECUTION_ERROR",
    map: "COVERAGE_MAP_INVALID",
    denominator: "COVERAGE_EMPTY_DENOMINATOR",
    evaluation: "COVERAGE_EVALUATION_INVALID",
  };
  return { status: "error", reason_code: reasons[phase] ?? "COVERAGE_UNTRUSTWORTHY" };
}

export async function runNodeCoverage(context, runner = runBoundedCommand) {
  const state = { phase: "precondition", temporaryRoot: undefined };
  try {
    const prepared = await prepareCoverage(context, runner, state);
    if (prepared.result) return prepared.result;
    const maps = await collectCoverageMaps(context, runner, state, prepared);
    if (maps.result) return maps.result;
    return evaluateCoverage(context, prepared.production, maps.combined, state);
  } catch (error) {
    return coverageError(error, context, state.phase);
  } finally {
    if (state.temporaryRoot) await fs.rm(state.temporaryRoot, { recursive: true, force: true });
  }
}
