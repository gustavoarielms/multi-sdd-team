import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleProof, captureSnapshot, PROOF_LAYOUTS, PROOF_NODES, PROOF_LIMITS,
  readProofJson, snapshotInventory, validateCapture, validateFinalMatrix, verifyProof,
} from "../src/quality-proof.js";
import { runBoundedCommand } from "../src/engineering-gate-runtime.js";
import { runTrustedGit } from "../src/git-change-selector.js";
import { validateAgentResult } from "../src/governance-validator.js";

const PACKAGE = path.join("@gustavoarielms", "sdd-codegraph-cli");
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE_SOURCE = "\nimport { issue13Increment } from '../test/issue13-remediation-helper.js';\nexport function issue13RemediationValue(value) { return issue13Increment(value); }\n";
const FIXTURE_TEST = "\nimport issue13Test from 'node:test';\nimport issue13Assert from 'node:assert/strict';\nimport { issue13RemediationValue } from '../../src/node-test-reporter.js';\nissue13Test('issue 13 preserves increment behavior', () => { issue13Assert.equal(issue13RemediationValue(1), 2); });\n";

function ensure(condition, code = "PROOF_COMMAND") {
  if (!condition) throw new Error(code);
}

function environment(node, npmConfig) {
  return {
    PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ""}`,
    ...(npmConfig ? {
      NPM_CONFIG_CACHE: npmConfig.cache,
      NPM_CONFIG_USERCONFIG: npmConfig.userConfig,
      NPM_CONFIG_GLOBALCONFIG: npmConfig.globalConfig,
    } : {}),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_OPTIONAL_LOCKS: "0",
  };
}

async function command(executable, args, cwd, env, runner, timeoutMs = 120000) {
  const result = await runner(executable, args, { cwd, env, timeoutMs, maxOutputBytes: PROOF_LIMITS.artifactBytes });
  ensure(result.status !== "error" && result.exit_code === 0);
  return result.stdout;
}

async function requirePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  ensure(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, "PROOF_NPM_CONFIG");
}

async function requirePrivateEmptyFile(file) {
  try {
    const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = await fs.lstat(file);
  ensure(stat.isFile() && !stat.isSymbolicLink() && stat.size === 0 && (stat.mode & 0o777) === 0o600, "PROOF_NPM_CONFIG");
}

async function privateNpmConfiguration(cache) {
  await requirePrivateDirectory(cache);
  const configuration = path.join(cache, "config");
  await requirePrivateDirectory(configuration);
  const userConfig = path.join(configuration, "user.npmrc");
  const globalConfig = path.join(configuration, "global.npmrc");
  await requirePrivateEmptyFile(userConfig);
  await requirePrivateEmptyFile(globalConfig);
  return { cache, userConfig, globalConfig };
}

async function npm(node, args, cwd, cache, runner) {
  const cli = await fs.realpath(path.join(path.dirname(node), "npm"));
  const npmConfig = await privateNpmConfiguration(cache);
  return command(node, [cli, ...args], cwd, environment(node, npmConfig), runner);
}

async function git(args, cwd, runner) {
  return command("git", ["-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", ...args], cwd, environment(process.execPath), runner);
}

async function writeJson(root, name, value) {
  await fs.writeFile(path.join(root, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

async function copyCandidate(source, target, inventory) {
  for (const entry of inventory.files) {
    const destination = path.join(target, entry.path);
    if (entry.mode === "deleted") { await fs.rm(destination, { force: true }); continue; }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rm(destination, { force: true });
    if (entry.mode === "120000") await fs.symlink(await fs.readlink(path.join(source, entry.path)), destination);
    else {
      await fs.copyFile(path.join(source, entry.path), destination);
      await fs.chmod(destination, entry.mode === "100755" ? 0o755 : 0o644);
    }
  }
}

async function requireAbsent(file, code) {
  try { await fs.lstat(file); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(code);
}

async function newWorkspace(source, work) {
  const requested = path.resolve(work);
  const parent = await fs.realpath(path.dirname(requested));
  const output = path.join(parent, path.basename(requested));
  const relative = path.relative(source, output);
  ensure(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "PROOF_WORKSPACE");
  await requireAbsent(output, "PROOF_WORKSPACE_EXISTS");
  return output;
}

async function fixtureMutationPaths(root) {
  ensure(Number.isInteger(constants.O_NOFOLLOW), "PROOF_NOFOLLOW_UNAVAILABLE");
  const rootStat = await fs.lstat(root);
  ensure(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "PROOF_FIXTURE_PATH");
  const paths = {};
  for (const [name, relative] of Object.entries({ reporter: "src/node-test-reporter.js", wrapper: "test/integration/engineering-gates.test.js", helper: "test/issue13-remediation-helper.js" })) {
    let directory = root;
    for (const part of relative.split("/").slice(0, -1)) {
      directory = path.join(directory, part);
      const stat = await fs.lstat(directory);
      ensure(stat.isDirectory() && !stat.isSymbolicLink(), "PROOF_FIXTURE_PATH");
    }
    const file = path.join(root, relative);
    if (name === "helper") await requireAbsent(file, "PROOF_FIXTURE_EXISTS");
    else {
      const stat = await fs.lstat(file);
      ensure(stat.isFile() && !stat.isSymbolicLink(), "PROOF_FIXTURE_PATH");
    }
    paths[name] = file;
  }
  return paths;
}

async function appendFixture(file, text) {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    ensure((await handle.stat()).isFile(), "PROOF_FIXTURE_PATH");
    await handle.writeFile(text);
  } finally { await handle.close(); }
}

function nulPaths(source) {
  ensure(source === "" || source.endsWith("\0"), "PROOF_GIT_PATHS");
  const paths = source.split("\0").filter(Boolean);
  ensure(new Set(paths).size === paths.length, "PROOF_GIT_PATHS");
  return paths;
}

async function ignoredPaths(source, candidates, runner) {
  if (candidates.length === 0) return new Set();
  const result = await runner("git", ["-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", "-C", source,
    "check-ignore", "--no-index", "-z", "-v", "--non-matching", "--stdin"], {
    cwd: source, env: environment(process.execPath), input: `${candidates.join("\0")}\0`, timeoutMs: 30000, maxOutputBytes: 1024 * 1024,
  });
  ensure(result.status !== "error" && [0, 1].includes(result.exit_code) && result.stderr === "", "PROOF_GIT_PATHS");
  const fields = result.stdout.split("\0");
  ensure(fields.pop() === "" && fields.length === candidates.length * 4, "PROOF_GIT_PATHS");
  const ignored = new Set();
  for (let index = 0; index < fields.length; index += 4) {
    ensure(fields[index + 3] === candidates[index / 4], "PROOF_GIT_PATHS");
    if (fields[index + 2]) ignored.add(fields[index + 3]);
  }
  return ignored;
}

async function candidateIndexPaths(source, inventory, runner) {
  const limits = { timeoutMs: 30000, maxOutputBytes: 1024 * 1024 };
  const untracked = await runTrustedGit(source, ["ls-files", "-z", "--others", "--exclude-standard"], limits, runner);
  const additions = await runTrustedGit(source, ["diff", "--name-only", "-z", "--diff-filter=A", "--ita-visible-in-index", "HEAD", "--"], limits, runner);
  ensure(untracked.status !== "error" && additions.status !== "error", "PROOF_GIT_PATHS");
  const untrackedPaths = nulPaths(untracked.stdout);
  const stagedPaths = nulPaths(additions.stdout);
  const staged = new Set(stagedPaths);
  ensure(untrackedPaths.every((relative) => !staged.has(relative)), "PROOF_GIT_PATHS");
  const candidates = [...untrackedPaths, ...stagedPaths];
  const inventoryPaths = new Set(inventory.files.filter((entry) => entry.mode !== "deleted").map((entry) => entry.path));
  ensure(candidates.every((relative) => inventoryPaths.has(relative)), "PROOF_GIT_PATHS");
  const ignored = await ignoredPaths(source, untrackedPaths, runner);
  return { intentPaths: untrackedPaths.filter((relative) => !ignored.has(relative)), stagedPaths };
}

async function validateCopiedAdditions(target, inventory, paths) {
  const entries = new Map(inventory.files.map((entry) => [entry.path, entry]));
  for (const relative of paths) {
    const entry = entries.get(relative);
    ensure(entry && entry.mode !== "deleted", "PROOF_COPY");
    const file = path.join(target, relative);
    const stat = await fs.lstat(file);
    const symlink = entry.mode === "120000";
    ensure(symlink ? stat.isSymbolicLink() : stat.isFile() && !stat.isSymbolicLink(), "PROOF_COPY");
    const mode = symlink ? "120000" : stat.mode & 0o111 ? "100755" : "100644";
    const bytes = symlink ? Buffer.from(await fs.readlink(file)) : await fs.readFile(file);
    ensure(mode === entry.mode && createHash("sha256").update(bytes).digest("hex") === entry.sha256, "PROOF_COPY");
  }
}

export async function prepareFixture(candidate, work, comparisonBase, runner = runBoundedCommand) {
  const source = await fs.realpath(candidate);
  const output = await newWorkspace(source, work);
  await fixtureMutationPaths(source);
  const before = await captureSnapshot(source, comparisonBase);
  const inventory = await snapshotInventory(source, comparisonBase);
  const indexPaths = await candidateIndexPaths(source, inventory, runner);
  await fs.mkdir(output, { mode: 0o700 });
  const target = path.join(output, "target");
  await git(["clone", "--no-hardlinks", "--no-checkout", "--", source, target], output, runner);
  await git(["checkout", "--detach", before.head_sha], target, runner);
  await copyCandidate(source, target, inventory);
  ensure(JSON.stringify(await captureSnapshot(source, comparisonBase)) === JSON.stringify(before), "PROOF_SNAPSHOT_CHANGED");
  await validateCopiedAdditions(target, inventory, indexPaths.stagedPaths);
  if (indexPaths.stagedPaths.length > 0) await git(["update-index", "--add", "--", ...indexPaths.stagedPaths], target, runner);
  ensure(JSON.stringify(await captureSnapshot(target, comparisonBase)) === JSON.stringify(before), "PROOF_COPY");
  const mutation = await fixtureMutationPaths(target);
  ensure(!(await fs.readFile(mutation.reporter, "utf8")).includes("issue13RemediationValue"), "PROOF_FIXTURE_EXISTS");
  await appendFixture(mutation.reporter, FIXTURE_SOURCE);
  await fs.writeFile(mutation.helper, "export function issue13Increment(value) { return value + 1; }\n", { flag: "wx" });
  await appendFixture(mutation.wrapper, FIXTURE_TEST);
  await git(["add", "-N", "--", ...indexPaths.intentPaths, "test/issue13-remediation-helper.js"], target, runner);
  await fs.mkdir(path.join(output, "dossier"));
  await npm(process.execPath, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], target, path.join(output, "cache"), runner);
  const initial = await captureSnapshot(target, comparisonBase);
  await writeJson(output, "state.json", { schema_version: "1.0.0", comparison_base: comparisonBase, initial_snapshot: initial });
  return { phase: "prepared", eligible: false, next: "initial" };
}

export async function captureGates(target, comparisonBase, node, layout, entrypoint, runner = runBoundedCommand) {
  const env = environment(node);
  const version = (await command(node, ["--version"], target, env, runner)).trim().replace(/^v/, "");
  ensure(PROOF_NODES.includes(version), "PROOF_NODE_VERSION");
  const before = await captureSnapshot(target, comparisonBase);
  const registry = JSON.parse(await fs.readFile(path.join(ROOT, "governance/gates/v1/registry.json"), "utf8"));
  const timeoutMs = registry.executors.reduce((total, executor) => total + executor.timeout_ms, 0);
  const execution = await runner(node, [entrypoint, "run-gates", target, "--comparison-base", comparisonBase], {
    cwd: target, env, timeoutMs, maxOutputBytes: PROOF_LIMITS.artifactBytes,
  });
  const after = await captureSnapshot(target, comparisonBase);
  ensure(execution.status !== "error" && execution.stderr === "", "PROOF_GATE_CAPTURE");
  let run;
  try { run = JSON.parse(execution.stdout); } catch { throw new Error("PROOF_GATE_JSON"); }
  return validateCapture({ schema_version: "1.0.0", node_version: version, layout, snapshot_before: before, snapshot_after: after, exit_code: execution.exit_code, run });
}

async function stateFor(work) {
  const state = await readProofJson(work, "state.json");
  ensure(Object.keys(state).sort().join(",") === "comparison_base,initial_snapshot,schema_version" && state.schema_version === "1.0.0", "PROOF_STATE");
  return state;
}

async function initialCapture(work, node) {
  const state = await stateFor(work);
  const target = path.join(work, "target");
  ensure(JSON.stringify(await captureSnapshot(target, state.comparison_base)) === JSON.stringify(state.initial_snapshot), "PROOF_SNAPSHOT_CHANGED");
  const capture = await captureGates(target, state.comparison_base, node, "source", path.join(target, "bin/sdd-codegraph.js"));
  await writeJson(path.join(work, "dossier"), "initial.json", capture);
  return { phase: "initial_captured", eligible: false, gate_exit_code: capture.exit_code, next: "real_review_and_implementer" };
}

export async function materializeLaunchers(target, directory, node, runner = runBoundedCommand) {
  await fs.mkdir(directory);
  const cache = path.join(directory, "cache");
  const launchers = { source: path.join(target, "bin/sdd-codegraph.js") };
  for (const layout of ["local", "global", "packed"]) await fs.mkdir(path.join(directory, layout));
  await npm(node, ["install", "--install-links", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", target], path.join(directory, "local"), cache, runner);
  await npm(node, ["install", "--global", "--prefix", path.join(directory, "global"), "--install-links", "--ignore-scripts", "--no-audit", "--no-fund", target], directory, cache, runner);
  const pack = JSON.parse(await npm(node, ["pack", target, "--json", "--ignore-scripts"], directory, cache, runner));
  ensure(pack.length === 1 && /^[A-Za-z0-9_.-]+\.tgz$/.test(pack[0].filename), "PROOF_PACKAGE");
  await npm(node, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", path.join(directory, pack[0].filename)], path.join(directory, "packed"), cache, runner);
  launchers.local = path.join(directory, "local/node_modules", PACKAGE, "bin/sdd-codegraph.js");
  launchers.global = path.join(directory, "global/lib/node_modules", PACKAGE, "bin/sdd-codegraph.js");
  launchers.packed = path.join(directory, "packed/node_modules", PACKAGE, "bin/sdd-codegraph.js");
  return launchers;
}

export async function finalCaptures(work, nodes, runner = runBoundedCommand) {
  const state = await stateFor(work);
  const dossier = path.join(work, "dossier");
  const review = await readProofJson(dossier, "review.json");
  const implementation = await readProofJson(dossier, "implementation.json");
  ensure((await validateAgentResult(review, { expectedAgent: "architecture_reviewer" })).ok, "PROOF_REVIEW");
  ensure((await validateAgentResult(implementation, { expectedAgent: "implementer" })).ok && implementation.parent_run_id === review.run_id, "PROOF_IMPLEMENTATION");
  const target = path.join(work, "target");
  const snapshot = await captureSnapshot(target, state.comparison_base);
  ensure(snapshot.digest !== state.initial_snapshot.digest, "PROOF_NOT_CORRECTED");
  const captures = [];
  const setup = await fs.mkdtemp(path.join(work, "launchers-"));
  for (const [index, node] of nodes.entries()) {
    const launchers = await materializeLaunchers(target, path.join(setup, `node-${index}`), node, runner);
    for (const layout of PROOF_LAYOUTS) {
      const capture = await captureGates(target, state.comparison_base, node, layout, launchers[layout], runner);
      await writeJson(setup, `capture-${index}-${layout}.json`, capture);
      ensure(capture.node_version === PROOF_NODES[index] && capture.snapshot_before.digest === snapshot.digest, "PROOF_MATRIX");
      captures.push(capture);
      ensure(capture.exit_code === 0, "PROOF_FINAL_GATE");
    }
  }
  const matrix = { schema_version: "1.0.0", captures };
  await validateFinalMatrix(matrix, { snapshot_before: state.initial_snapshot });
  await writeJson(dossier, "final.json", matrix);
  return { phase: "final_matrix_captured", captures: captures.length, eligible: false, next: "original_reviewer_revalidation" };
}

export async function runProofCommand(args) {
  const [phase, ...values] = args;
  if (phase === "prepare" && values.length === 3) return prepareFixture(...values);
  if (phase === "initial" && values.length === 2) return initialCapture(path.resolve(values[0]), path.resolve(values[1]));
  if (phase === "matrix" && values.length === 3) return finalCaptures(path.resolve(values[0]), values.slice(1).map((value) => path.resolve(value)));
  if (phase === "assemble" && values.length === 1) return assembleProof(path.join(path.resolve(values[0]), "dossier"));
  if (phase === "verify" && values.length === 1) return verifyProof(path.resolve(values[0]));
  throw new Error("PROOF_USAGE: prepare <candidate> <new-work> <base> | initial <work> <node> | matrix <work> <node22> <node24> | assemble <work> | verify <dossier>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runProofCommand(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = result.gate_exit_code ?? 0;
  } catch (error) {
    const code = /^PROOF_[A-Z_]+$/.test(error.message) ? error.message : "PROOF_REJECTED";
    process.stdout.write(JSON.stringify({ eligible: false, error: code }) + "\n");
    process.exitCode = 2;
  }
}
