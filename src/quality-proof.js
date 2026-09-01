import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { runTrustedGit } from "./git-change-selector.js";
import { validateAgentResult, validateEngineeringGateRun } from "./governance-validator.js";

export const PROOF_LIMITS = Object.freeze({ manifestBytes: 16384, artifactBytes: 2 * 1024 * 1024, totalBytes: 8 * 1024 * 1024, snapshotFiles: 5000, snapshotFileBytes: 16 * 1024 * 1024, snapshotBytes: 64 * 1024 * 1024 });
export const PROOF_LAYOUTS = Object.freeze(["source", "local", "global", "packed"]);
export const PROOF_NODES = Object.freeze(["22.14.0", "24.19.0"]);
const STAGES = Object.freeze(["initial", "review", "implementation", "final", "revalidation"]);
const DEPENDENCIES = Object.freeze([[], ["initial"], ["review"], ["implementation"], ["final", "review"]]);
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RULE = "ARCH-PROD-NO-TEST-001";
const INSTRUMENTAL_COVERAGE_IDS = new Set(["coverage_global", "coverage_changed", "coverage_unit", "coverage_integration"]);

function requireProof(condition, code = "PROOF_INVALID") {
  if (!condition) throw new Error(code);
}

function exactKeys(value, names) {
  requireProof(value && typeof value === "object" && !Array.isArray(value));
  requireProof(Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name)));
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function relativePath(relative) {
  requireProof(typeof relative === "string" && relative.length > 0 && relative.length <= 1024, "PROOF_PATH");
  requireProof(!path.isAbsolute(relative) && !/[\\:]/.test(relative), "PROOF_PATH");
  requireProof([...relative].every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127), "PROOF_PATH");
  requireProof(relative.split("/").every((part) => part && part !== "." && part !== ".."), "PROOF_PATH");
}

async function containedPath(root, relative) {
  relativePath(relative);
  const parts = relative.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    requireProof(stat.isDirectory() && !stat.isSymbolicLink(), "PROOF_PATH");
  }
  return path.join(root, ...parts);
}

async function proofRoot(root) {
  const stat = await fs.lstat(root);
  requireProof(stat.isDirectory() && !stat.isSymbolicLink(), "PROOF_PATH");
  return fs.realpath(root);
}

async function regularFile(root, relative, maximum) {
  const file = await containedPath(root, relative);
  const stat = await fs.lstat(file);
  requireProof(stat.isFile() && !stat.isSymbolicLink(), "PROOF_FILE");
  requireProof(stat.size <= maximum, "PROOF_SIZE");
  return { file, stat };
}

async function readStableFile(metadata) {
  const handle = await fs.open(metadata.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    requireProof(before.dev === metadata.stat.dev && before.ino === metadata.stat.ino && before.size === metadata.stat.size, "PROOF_CHANGED");
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    requireProof(offset === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs, "PROOF_CHANGED");
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function boundedJson(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (escaped) { escaped = false; continue; }
    if (quoted && character === "\\") { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (character === "{" || character === "[") depth += 1;
    if (character === "}" || character === "]") depth -= 1;
    requireProof(depth >= 0 && depth <= 32, "PROOF_DEPTH");
  }
  try {
    const value = JSON.parse(text);
    limitCollections(value);
    return value;
  } catch {
    throw new Error("PROOF_JSON");
  }
}

function limitCollections(value) {
  if (typeof value === "string") requireProof(value.length <= 16384, "PROOF_SIZE");
  if (value && typeof value === "object") {
    const entries = Object.values(value);
    requireProof(entries.length <= 4096, "PROOF_SIZE");
    entries.forEach(limitCollections);
  }
}

export async function readProofJson(root, relative, maximum = PROOF_LIMITS.artifactBytes) {
  try {
    return boundedJson(await readStableFile(await regularFile(await proofRoot(root), relative, maximum)));
  } catch {
    throw new Error("PROOF_READ_REJECTED");
  }
}

async function trustedGit(root, args) {
  const result = await runTrustedGit(root, args, { timeoutMs: 30000, maxOutputBytes: 1024 * 1024 });
  requireProof(result.status !== "error", "PROOF_GIT");
  return result.stdout;
}

export async function snapshotInventory(root, comparisonBase) {
  requireProof(SHA.test(comparisonBase), "PROOF_BASE");
  const realRoot = await proofRoot(root);
  const head = (await trustedGit(realRoot, ["rev-parse", "HEAD"])).trim();
  requireProof((await trustedGit(realRoot, ["merge-base", comparisonBase, head])).trim() === comparisonBase, "PROOF_BASE");
  const names = [...new Set((await trustedGit(realRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean))].sort();
  requireProof(names.length <= PROOF_LIMITS.snapshotFiles, "PROOF_SIZE");
  const metadata = [];
  let total = 0;
  for (const relative of names) {
    const entry = await snapshotMetadata(realRoot, relative);
    total += entry.stat?.size ?? 0;
    requireProof(total <= PROOF_LIMITS.snapshotBytes, "PROOF_SIZE");
    metadata.push(entry);
  }
  const files = [];
  for (const entry of metadata) files.push(await snapshotValue(entry));
  return { head_sha: head, comparison_base: comparisonBase, files };
}

async function snapshotMetadata(root, relative) {
  let file;
  let stat;
  try { file = await containedPath(root, relative); stat = await fs.lstat(file); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { relative, stat: null };
  }
  requireProof(stat.isFile() || stat.isSymbolicLink(), "PROOF_FILE");
  requireProof(stat.size <= PROOF_LIMITS.snapshotFileBytes, "PROOF_SIZE");
  return { relative, file, stat };
}

async function snapshotValue({ relative, file, stat }) {
  if (!stat) return { path: relative, mode: "deleted", sha256: digest("") };
  const bytes = stat.isSymbolicLink() ? Buffer.from(await fs.readlink(file)) : await readStableFile({ file, stat });
  const mode = stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644";
  return { path: relative, mode, sha256: digest(bytes) };
}

export async function captureSnapshot(root, comparisonBase) {
  const inventory = await snapshotInventory(root, comparisonBase);
  return { head_sha: inventory.head_sha, comparison_base: comparisonBase, digest: `sha256:${digest(JSON.stringify(inventory))}` };
}

function validateSnapshot(value) {
  exactKeys(value, ["head_sha", "comparison_base", "digest"]);
  requireProof(SHA.test(value.head_sha) && SHA.test(value.comparison_base) && DIGEST.test(value.digest), "PROOF_SNAPSHOT");
}

function sameSnapshot(left, right) {
  return left.head_sha === right.head_sha && left.comparison_base === right.comparison_base && left.digest === right.digest;
}

function time(value) {
  const parsed = Date.parse(value);
  requireProof(Number.isFinite(parsed), "PROOF_TIME");
  return parsed;
}

export async function validateCapture(value) {
  exactKeys(value, ["schema_version", "node_version", "layout", "snapshot_before", "snapshot_after", "exit_code", "run"]);
  requireProof(value.schema_version === "1.0.0" && PROOF_NODES.includes(value.node_version) && PROOF_LAYOUTS.includes(value.layout));
  validateSnapshot(value.snapshot_before);
  validateSnapshot(value.snapshot_after);
  requireProof(sameSnapshot(value.snapshot_before, value.snapshot_after), "PROOF_SNAPSHOT_CHANGED");
  requireProof(value.run.schema_version === "1.1.0" && (await validateEngineeringGateRun(value.run)).ok, "PROOF_GATE_DOCUMENT");
  requireProof(value.run.run_error || value.run.comparison_base?.supplied_sha === value.snapshot_before.comparison_base, "PROOF_BASE");
  const exitCode = { passed: 0, failed: 1, blocked: 2 }[value.run.outcome];
  requireProof(value.exit_code === exitCode, "PROOF_EXIT");
  requireProof(time(value.run.started_at) <= time(value.run.completed_at), "PROOF_TIME");
  return value;
}

export function gateSemantics(run) {
  const { run_id, started_at, completed_at, ...rest } = run;
  void run_id; void started_at; void completed_at;
  const stableCoverageEntry = (value, id) => {
    if (!INSTRUMENTAL_COVERAGE_IDS.has(id.replace(/^evidence:/, ""))) return value;
    const { summary, counts, ...stable } = value;
    void summary; void counts;
    return stable;
  };
  return {
    ...rest,
    results: run.results.map(({ duration_ms, ...result }) => {
      void duration_ms;
      return Array.isArray(result.checks)
        ? { ...result, checks: result.checks.map((check) => stableCoverageEntry(check, check.check_id)) }
        : result;
    }),
    evidence: run.evidence.map(({ collected_at, ...evidence }) => {
      void collected_at;
      return stableCoverageEntry(evidence, evidence.evidence_id);
    }),
  };
}

function initialFailure(capture) {
  const results = capture.run.results;
  requireProof(capture.exit_code === 1 && capture.layout === "source", "PROOF_INITIAL_GATE");
  requireProof(results.every((result) => result.status === (result.executor_id === "node_architecture" ? "fail" : "pass")), "PROOF_INITIAL_GATE");
  requireProof(results[5].checks.every((check) => check.status === (check.check_id === "production_must_not_import_tests" ? "fail" : "pass")), "PROOF_INITIAL_GATE");
}

export async function validateFinalMatrix(value, initial) {
  exactKeys(value, ["schema_version", "captures"]);
  requireProof(value.schema_version === "1.0.0" && Array.isArray(value.captures) && value.captures.length === 8, "PROOF_MATRIX");
  const snapshot = value.captures[0].snapshot_before;
  requireProof(snapshot.digest !== initial.snapshot_before.digest && snapshot.head_sha === initial.snapshot_before.head_sha, "PROOF_SNAPSHOT");
  for (const [index, capture] of value.captures.entries()) {
    await validateCapture(capture);
    requireProof(capture.node_version === PROOF_NODES[Math.floor(index / 4)] && capture.layout === PROOF_LAYOUTS[index % 4], "PROOF_MATRIX_ORDER");
    requireProof(capture.exit_code === 0 && capture.run.results.every((result) => result.status === "pass"), "PROOF_FINAL_GATE");
    requireProof(sameSnapshot(capture.snapshot_before, snapshot), "PROOF_SNAPSHOT");
    const reference = value.captures[Math.floor(index / 4) * 4];
    requireProof(JSON.stringify(gateSemantics(capture.run)) === JSON.stringify(gateSemantics(reference.run)), "PROOF_EQUIVALENCE");
  }
  return snapshot;
}

async function reviewChain(review, implementation, revalidation) {
  for (const [value, expectedAgent] of [[review, "architecture_reviewer"], [implementation, "implementer"], [revalidation, "architecture_reviewer"]]) {
    requireProof((await validateAgentResult(value, { expectedAgent })).ok && value.outcome === "completed", "PROOF_AGENT_DOCUMENT");
  }
  requireProof(review.findings.length === 1 && revalidation.findings.length === 1, "PROOF_FINDING");
  const finding = review.findings[0];
  const resolved = revalidation.findings[0];
  requireProof(finding.rule_id === RULE && finding.status === "open" && finding.validation_status === "verified" && finding.recommended_gate_effect === "block", "PROOF_FINDING");
  requireProof(review.handoff.next_owner === "implementer" && review.handoff.unresolved_finding_ids.includes(finding.finding_id), "PROOF_HANDOFF");
  requireProof(implementation.parent_run_id === review.run_id && implementation.handoff.next_owner === review.producer.id && implementation.handoff.unresolved_finding_ids.length === 0, "PROOF_HANDOFF");
  requireProof(revalidation.parent_run_id === review.run_id && revalidation.producer.id === review.producer.id, "PROOF_ORIGINAL_REVIEWER");
  validateResolvedFinding(finding, resolved);
  requireProof(revalidation.handoff.unresolved_finding_ids.length === 0, "PROOF_REVALIDATION");
  return finding.finding_id;
}

function validateProofLink(result, name, uri, sha256) {
  const id = `evidence:proof-${name}`;
  const links = result.evidence.filter((entry) => entry.evidence_id === id);
  requireProof(links.length === 1, "PROOF_LINK");
  const link = links[0];
  requireProof(link.kind === "document" && link.level === "observed" && link.outcome === "observed", "PROOF_LINK");
  requireProof(link.artifact?.uri === uri && link.artifact.sha256 === sha256 && link.artifact.media_type === "application/json", "PROOF_LINK");
  requireProof(time(link.collected_at) >= time(result.started_at) && time(link.collected_at) <= time(result.completed_at), "PROOF_LINK_TIME");
  return id;
}

function validateReviewGates(result, reference, expected) {
  const required = result.gate_decisions.filter((gate) => gate.required);
  const allowed = expected === "fail" ? ["pass", "fail"] : ["pass"];
  requireProof(required.every((gate) => allowed.includes(gate.status)), "PROOF_REVIEW_GATE");
  const evaluated = required.filter((gate) => gate.evaluated_rule_ids.includes(RULE));
  requireProof(evaluated.length > 0 && result.findings[0].evidence_ids.includes(reference), "PROOF_LINK");
  requireProof(evaluated.every((gate) => gate.status === expected && gate.evidence_ids.includes(reference) && gate.finding_ids.includes(result.findings[0].finding_id)), "PROOF_LINK");
}

function validateHandoffLinks(loaded, final) {
  requireProof(loaded.every((entry, index) => entry.path === `${STAGES[index]}.json`), "PROOF_LINK");
  const review = loaded[1].value;
  const implementation = loaded[2].value;
  const revalidation = loaded[4].value;
  const initialRef = validateProofLink(review, "initial", "initial.json", loaded[0].sha256);
  validateReviewGates(review, initialRef, "fail");
  validateProofLink(implementation, "review", "review.json", loaded[1].sha256);
  validateProofLink(implementation, "corrected-snapshot", "urn:multi-sdd:quality-proof:corrected-snapshot", final.digest.slice(7));
  requireProof(implementation.gate_decisions.filter((gate) => gate.required).every((gate) => gate.status === "pass"), "PROOF_REVIEW_GATE");
  const finalRef = validateProofLink(revalidation, "final", "final.json", loaded[3].sha256);
  validateReviewGates(revalidation, finalRef, "pass");
}

function validateResolvedFinding(finding, resolved) {
  requireProof(resolved.finding_id === finding.finding_id && resolved.fingerprint === finding.fingerprint && resolved.rule_id === finding.rule_id && resolved.status === "resolved", "PROOF_FINDING");
  requireProof(resolved.validation_status === "verified" && resolved.rule_status === "approved", "PROOF_REVALIDATION");
}

function validateRunTimes(result) {
  const started = time(result.started_at);
  const completed = time(result.completed_at);
  const timestamps = [
    ...(result.evidence ?? []).map((entry) => entry.collected_at),
    ...(result.findings ?? []).map((finding) => finding.reported_at),
    ...(result.gate_decisions ?? []).map((gate) => gate.decided_at),
  ];
  requireProof(timestamps.every((timestamp) => time(timestamp) >= started && time(timestamp) <= completed), "PROOF_TIME");
}

function validateTimes(initial, review, implementation, matrix, revalidation) {
  const runs = [initial.run, review, implementation, ...matrix.captures.map((capture) => capture.run), revalidation];
  requireProof(new Set(runs.map((run) => run.run_id)).size === runs.length, "PROOF_DUPLICATE_RUN");
  let completed = 0;
  for (const run of runs) {
    requireProof(time(run.started_at) >= completed && time(run.completed_at) >= time(run.started_at), "PROOF_SEQUENCE");
    validateRunTimes(run);
    completed = time(run.completed_at);
  }
}

function validateManifest(manifest) {
  exactKeys(manifest, ["schema_version", "comparison_base", "finding_id", "artifacts"]);
  requireProof(manifest.schema_version === "1.0.0" && SHA.test(manifest.comparison_base) && typeof manifest.finding_id === "string");
  requireProof(Array.isArray(manifest.artifacts) && manifest.artifacts.length === STAGES.length, "PROOF_ARTIFACT_COUNT");
  manifest.artifacts.forEach((artifact, index) => {
    exactKeys(artifact, ["id", "type", "path", "sha256", "snapshot_digest", "depends_on"]);
    requireProof(artifact.id === STAGES[index] && artifact.type === STAGES[index], "PROOF_ARTIFACT_ORDER");
    relativePath(artifact.path);
    requireProof(/^[a-f0-9]{64}$/.test(artifact.sha256) && DIGEST.test(artifact.snapshot_digest));
    requireProof(JSON.stringify(artifact.depends_on) === JSON.stringify(DEPENDENCIES[index]), "PROOF_REFERENCES");
  });
}

async function loadArtifacts(root, artifacts) {
  const realRoot = await proofRoot(root);
  const metadata = await Promise.all(artifacts.map((artifact) => regularFile(realRoot, artifact.path, PROOF_LIMITS.artifactBytes)));
  requireProof(metadata.reduce((total, item) => total + item.stat.size, PROOF_LIMITS.manifestBytes) <= PROOF_LIMITS.totalBytes, "PROOF_SIZE");
  const identities = metadata.map((item) => `${item.stat.dev}:${item.stat.ino}`);
  requireProof(new Set(identities).size === artifacts.length, "PROOF_FILE_ALIAS");
  const bytes = await Promise.all(metadata.map(readStableFile));
  return bytes.map((source, index) => ({ value: boundedJson(source), sha256: digest(source), path: artifacts[index].path }));
}

async function validateChain(loaded) {
  const [initial, review, implementation, matrix, revalidation] = loaded.map((entry) => entry.value);
  await validateCapture(initial);
  initialFailure(initial);
  const final = await validateFinalMatrix(matrix, initial);
  const findingId = await reviewChain(review, implementation, revalidation);
  validateHandoffLinks(loaded, final);
  validateTimes(initial, review, implementation, matrix, revalidation);
  requireProof(final.comparison_base === initial.snapshot_before.comparison_base, "PROOF_BASE");
  return { initial: initial.snapshot_before, final, findingId };
}

export async function assembleProof(root) {
  const loaded = await loadArtifacts(root, STAGES.map((stage) => ({ path: `${stage}.json` })));
  const chain = await validateChain(loaded);
  const manifest = {
    schema_version: "1.0.0", comparison_base: chain.initial.comparison_base, finding_id: chain.findingId,
    artifacts: loaded.map((entry, index) => ({ id: STAGES[index], type: STAGES[index], path: entry.path, sha256: entry.sha256, snapshot_digest: index < 2 ? chain.initial.digest : chain.final.digest, depends_on: DEPENDENCIES[index] })),
  };
  const text = JSON.stringify(manifest, null, 2) + "\n";
  requireProof(Buffer.byteLength(text) <= PROOF_LIMITS.manifestBytes, "PROOF_SIZE");
  await fs.writeFile(path.join(await proofRoot(root), "manifest.json"), text, { flag: "wx", mode: 0o600 });
  return verifyProof(root);
}

export async function verifyProof(root) {
  const manifest = await readProofJson(root, "manifest.json", PROOF_LIMITS.manifestBytes);
  validateManifest(manifest);
  const loaded = await loadArtifacts(root, manifest.artifacts);
  loaded.forEach((entry, index) => requireProof(entry.sha256 === manifest.artifacts[index].sha256, "PROOF_HASH"));
  const chain = await validateChain(loaded);
  requireProof(chain.findingId === manifest.finding_id && chain.initial.comparison_base === manifest.comparison_base, "PROOF_REFERENCES");
  manifest.artifacts.forEach((entry, index) => requireProof(entry.snapshot_digest === (index < 2 ? chain.initial.digest : chain.final.digest), "PROOF_SNAPSHOT"));
  return { eligible: true, scope: "bounded_issue_13_proof", snapshot: chain.final, finding_id: chain.findingId, authorization: "human_approval_required", provenance: "hashes_do_not_authenticate_authorship_or_execution" };
}
