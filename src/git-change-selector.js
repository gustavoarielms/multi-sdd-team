import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isContained, runBoundedCommand } from "./engineering-gate-runtime.js";

const PRODUCTION_PATH = /^(?:bin|src)\/(?:[^/\0]+\/)*[^/\0]+\.js$/;
const MAX_PATHS = 2000;
const MAX_PATH_BYTES = 1024;
const MAX_HUNKS_PER_FILE = 10000;
const MAX_HUNKS_TOTAL = 50000;
const MAX_SOURCE_LINES = 100000;
const MAX_CHANGED_LINES_PER_FILE = 100000;
const MAX_CHANGED_LINES_TOTAL = 500000;
const GIT_PREFIX = Object.freeze([
  "-c", "color.ui=false",
  "-c", "core.quotepath=false",
  "-c", `core.hooksPath=${os.devNull}`,
  "-c", "core.fsmonitor=false",
  "-c", "diff.external=",
]);
const PATHSPECS = Object.freeze([":(glob)bin/**/*.js", ":(glob)src/**/*.js"]);

function gitEnvironment() {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
    PATH: process.env.PATH ?? "",
  };
}

export async function runTrustedGit(target, args, limits, runner = runBoundedCommand) {
  const result = await runner("git", [...GIT_PREFIX, "-C", target, ...args], {
    cwd: target,
    env: gitEnvironment(),
    ...limits,
  });
  if (result.status === "error") return result;
  if (result.exit_code !== 0) return { status: "error", reason_code: "GIT_QUERY_FAILED" };
  return result;
}

function validProductionPath(value) {
  return typeof value === "string"
    && Buffer.byteLength(value) <= MAX_PATH_BYTES
    && !value.includes("�")
    && PRODUCTION_PATH.test(value);
}

function parsePathList(stdout) {
  if (!stdout.endsWith("\0") && stdout.length > 0) throw new Error("unterminated git path list");
  const paths = stdout.split("\0").filter(Boolean);
  if (paths.length > MAX_PATHS || paths.some((value) => !validProductionPath(value))) {
    throw new Error("invalid git path list");
  }
  return [...new Set(paths)].sort();
}

function parseNameStatus(stdout) {
  const fields = stdout.split("\0");
  if (fields.at(-1) !== "") throw new Error("unterminated git status list");
  fields.pop();
  const paths = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!/^(?:A|C\d{1,3}|M|R\d{1,3})$/.test(status)) throw new Error("invalid git status");
    if (status.startsWith("R") || status.startsWith("C")) index += 1;
    const finalPath = fields[index++];
    if (!validProductionPath(finalPath)) throw new Error("invalid git status path");
    paths.push(finalPath);
    if (paths.length > MAX_PATHS) throw new Error("too many git status paths");
  }
  return [...new Set(paths)].sort();
}

async function validatePhysicalPaths(target, paths) {
  const realTarget = await fs.realpath(target);
  for (const relative of paths) {
    const absolute = path.join(realTarget, relative);
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe production path");
    const real = await fs.realpath(absolute);
    if (!isContained(realTarget, real)) throw new Error("unsafe production path");
  }
}

export function parseChangedLineIntervals(stdout, sourceLineCount, aggregate) {
  if (!Number.isSafeInteger(sourceLineCount) || sourceLineCount < 0 || sourceLineCount > MAX_SOURCE_LINES
    || !aggregate || !Number.isSafeInteger(aggregate.lines) || aggregate.lines < 0
    || aggregate.lines > MAX_CHANGED_LINES_TOTAL || !Number.isSafeInteger(aggregate.hunks)
    || aggregate.hunks < 0 || aggregate.hunks > MAX_HUNKS_TOTAL) {
    throw new Error("invalid git hunk");
  }
  const intervals = [];
  let total = 0;
  let hunkCount = 0;
  for (const header of stdout.matchAll(/^@@.*$/gm)) {
    hunkCount += 1;
    if (hunkCount > MAX_HUNKS_PER_FILE || aggregate.hunks > MAX_HUNKS_TOTAL - hunkCount) {
      throw new Error("invalid git hunk");
    }
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@.*$/.exec(header[0]);
    if (!match) throw new Error("invalid git hunk");
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    const end = count === 0 ? start : start + count - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || !Number.isSafeInteger(end)
      || start < 0 || count < 0 || count > MAX_CHANGED_LINES_PER_FILE
      || (count > 0 && (start === 0 || end > sourceLineCount))) {
      throw new Error("invalid git hunk");
    }
    if (count === 0) continue;
    if (intervals.length > 0 && start <= intervals.at(-1).end) throw new Error("invalid git hunk");
    total += count;
    if (!Number.isSafeInteger(total) || total > MAX_CHANGED_LINES_PER_FILE) throw new Error("invalid git hunk");
    intervals.push({ start, end });
  }
  if (aggregate.lines > MAX_CHANGED_LINES_TOTAL - total) throw new Error("invalid git hunk");
  aggregate.lines += total;
  aggregate.hunks += hunkCount;
  return { intervals, total, sourceLineCount };
}

function countSourceLines(source) {
  if (source.length === 0) return 0;
  let lines = source.endsWith("\n") ? 0 : 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) lines += 1;
    if (lines > MAX_SOURCE_LINES) throw new Error("production file too large");
  }
  return lines;
}

async function sourceLineCount(target, relative) {
  const source = await fs.readFile(path.join(target, relative), "utf8");
  return countSourceLines(source);
}

async function fullFileInterval(target, relative, aggregate) {
  const count = await sourceLineCount(target, relative);
  if (aggregate.lines > MAX_CHANGED_LINES_TOTAL - count) throw new Error("invalid git hunk");
  aggregate.lines += count;
  return {
    intervals: count === 0 ? [] : [{ start: 1, end: count }],
    total: count,
    sourceLineCount: count,
  };
}

export async function collectProductionChanges(target, comparisonBase, limits, runner = runBoundedCommand) {
  try {
    const trackedResult = await runTrustedGit(target, ["ls-files", "-z", "--", ...PATHSPECS], limits, runner);
    const deletedResult = await runTrustedGit(target, ["ls-files", "-z", "--deleted", "--", ...PATHSPECS], limits, runner);
    const untrackedResult = await runTrustedGit(target, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...PATHSPECS], limits, runner);
    const changedResult = await runTrustedGit(target, [
      "diff", "--name-status", "-z", "--find-renames", "--diff-filter=ACMR", "--no-ext-diff",
      comparisonBase, "--", ...PATHSPECS,
    ], limits, runner);
    if ([trackedResult, deletedResult, untrackedResult, changedResult].some((result) => result.status === "error")) {
      return { status: "error", reason_code: "GIT_QUERY_FAILED" };
    }
    const deleted = new Set(parsePathList(deletedResult.stdout));
    const tracked = parsePathList(trackedResult.stdout).filter((relative) => !deleted.has(relative));
    const untracked = parsePathList(untrackedResult.stdout);
    const changedTracked = parseNameStatus(changedResult.stdout);
    await validatePhysicalPaths(target, [...tracked, ...untracked]);
    const changed = new Map();
    const aggregate = { lines: 0, hunks: 0 };
    for (const relative of changedTracked) {
      const diff = await runTrustedGit(target, [
        "diff", "--unified=0", "--no-color", "--no-ext-diff", "--no-textconv",
        comparisonBase, "--", relative,
      ], limits, runner);
      if (diff.status === "error") return { status: "error", reason_code: "GIT_QUERY_FAILED" };
      const lineCount = await sourceLineCount(target, relative);
      changed.set(relative, parseChangedLineIntervals(diff.stdout, lineCount, aggregate));
    }
    for (const relative of untracked) changed.set(relative, await fullFileInterval(target, relative, aggregate));
    return { status: "completed", tracked, untracked, changed };
  } catch {
    return { status: "error", reason_code: "GIT_OUTPUT_MALFORMED" };
  }
}
