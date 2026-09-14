import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { runDockerLifecycle } from "../src/docker-runtime.js";
import {
  DOCKER_RUNTIME_CONTRACT,
  buildDockerCreateInvocation,
} from "../src/docker-runtime-contract.js";

const APPROVED_IMAGE = Object.freeze({
  digest: "sha256:32d7b44df8092f6f1aadcdd59b94693596597d9a51ee1360ffe1869cc100fe91",
  reference: "issue18-task2-fixture-v2@sha256:32d7b44df8092f6f1aadcdd59b94693596597d9a51ee1360ffe1869cc100fe91",
  user: "10001:10001",
});
const EXPECTED_IMAGE_ID = "sha256:45e46f8d613548260ae31e627184ca50cbb2b128999cf835ae6bc99f9715a5fe";
const CAPTURE_LIMIT = 2 * 1024 * 1024;
const FULL_ID = /^[a-f0-9]{64}$/u;
const PROMPT = "name = \"synthetic-main\"\nmodel = \"fixture-only\"\n";
const MANIFEST = "{\"fixture\":true,\"version\":1}\n";

if (process.env.SDD_REAL_DOCKER_FIXTURE !== "1") {
  process.stderr.write("Set SDD_REAL_DOCKER_FIXTURE=1 to run the isolated real-Docker fixture.\n");
  process.exitCode = 77;
} else {
  await main();
}

function sha256(...values) {
  const hash = crypto.createHash("sha256");
  for (const value of values) hash.update(value);
  return `sha256:${hash.digest("hex")}`;
}

function capturedSpawn(records) {
  return (command, args, options) => {
    const record = { args: [...args], code: null, command, signal: null, stderr: [], stderrBytes: 0, stdout: [], stdoutBytes: 0 };
    records.push(record);
    const child = spawn(command, args, options);
    const capture = (name, chunk) => {
      const bytesKey = `${name}Bytes`;
      const remaining = CAPTURE_LIMIT - record[bytesKey];
      if (remaining > 0) record[name].push(Buffer.from(chunk).subarray(0, remaining));
      record[bytesKey] += chunk.length;
    };
    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.on("close", (code, signal) => { record.code = code; record.signal = signal; });
    return child;
  };
}

function operation(record) {
  assert.equal(record.args[0], "--host=unix:///var/run/docker.sock");
  assert.match(record.args[1], /^--config=\/tmp\/sdd-docker-[A-Za-z0-9]+$/u);
  return record.args.slice(2);
}

function output(record, name = "stdout") {
  assert.ok(record[`${name}Bytes`] <= CAPTURE_LIMIT, `${name} exceeded fixture capture limit`);
  return Buffer.concat(record[name]).toString("utf8");
}

async function waitFor(readValue, predicate, message, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  let value;
  while (Date.now() < end) {
    try { value = await readValue(); } catch { value = undefined; }
    if (predicate(value)) return value;
    await delay(25);
  }
  assert.fail(message);
}

async function fixtureOperation(transport, projectRoot, state) {
  const line = await waitFor(
    async () => transport.read().toString("utf8").split("\n").find((candidate) => candidate.startsWith("{\"event\":\"fixture_probe\"")),
    Boolean,
    "fixture probe output was not observed",
  );
  const probe = JSON.parse(line);
  assert.deepEqual(probe, {
    event: "fixture_probe",
    uid_is_expected: true,
    gid_is_expected: true,
    ordinary_write_succeeded: true,
    prompt_write_read_only: true,
    prompt_create_read_only: true,
    nested_mount_observed: true,
    nested_mount_read_only: true,
    nested_write_read_only: true,
    detached_spawner_completed: true,
  });

  assert.equal(await fs.readFile(path.join(projectRoot, "ordinary-write.txt"), "utf8"), "fixture-ordinary-write\n");
  assert.equal(await fs.readFile(path.join(projectRoot, ".codex/agents/main.toml"), "utf8"), PROMPT);
  await assert.rejects(fs.access(path.join(projectRoot, ".codex/agents/fixture-write.tmp")));
  await assert.rejects(fs.access(path.join(projectRoot, ".codex/nested/fixture-write.tmp")));

  const descendantPid = await waitFor(
    () => fs.readFile(path.join(projectRoot, "detached-descendant.pid"), "utf8"),
    (value) => typeof value === "string" && /^[1-9][0-9]*\n$/u.test(value),
    "detached descendant PID was not observed",
  );
  const heartbeatPath = path.join(projectRoot, "detached-heartbeat.txt");
  const first = await waitFor(() => fs.readFile(heartbeatPath, "utf8"), (value) => /^[1-9][0-9]*\n$/u.test(value ?? ""), "heartbeat was not observed");
  await delay(250);
  const second = await fs.readFile(heartbeatPath, "utf8");
  assert.notEqual(second, first, "detached descendant did not remain alive after its spawner exited");
  state.descendantPidObserved = /^[1-9][0-9]*\n$/u.test(descendantPid);
  state.heartbeatPath = heartbeatPath;
  state.heartbeatBeforeRemoval = second;
  state.probe = probe;
}

function findRecord(records, predicate, message) {
  const record = records.find((candidate) => predicate(operation(candidate)));
  assert.ok(record, message);
  return record;
}

function validateDockerEvidence(records, projectRoot) {
  for (const record of records) {
    assert.equal(record.command, "docker");
    operation(record);
  }
  const versionRecord = findRecord(records, (args) => args[0] === "version", "Docker version preflight missing");
  const infoRecord = findRecord(records, (args) => args[0] === "info", "Docker info preflight missing");
  const imageRecord = findRecord(records, (args) => args[0] === "image" && args[1] === "inspect", "image inspection missing");
  const createRecord = findRecord(records, (args) => args[0] === "create", "container create missing");
  const createArgs = operation(createRecord);
  const runPrefix = `--label=${DOCKER_RUNTIME_CONTRACT.labels.run}=`;
  const runId = createArgs.find((arg) => arg.startsWith(runPrefix))?.slice(runPrefix.length);
  assert.match(runId, FULL_ID);
  assert.deepEqual(createArgs, buildDockerCreateInvocation({ approvedImage: APPROVED_IMAGE, permissionProfile: "workspace-only", projectRoot, runId }).args);

  const id = output(createRecord).trim();
  assert.match(id, FULL_ID);
  const removeRecord = findRecord(records, (args) => args[0] === "rm", "force removal missing");
  assert.deepEqual(operation(removeRecord), ["rm", "--force", id]);
  assert.equal(removeRecord.code, 0);
  assert.equal(output(removeRecord), `${id}\n`);

  const inspectRecords = records.filter((record) => operation(record)[0] === "container" && operation(record)[1] === "inspect");
  assert.equal(inspectRecords.length, 2);
  const absenceRecord = inspectRecords[1];
  assert.deepEqual(operation(absenceRecord), ["container", "inspect", id]);
  assert.equal(absenceRecord.code, 1);
  assert.match(output(absenceRecord), /^\[\]\n?$/u);
  assert.match(output(absenceRecord, "stderr"), new RegExp(`No such container: ${id}`));

  const labelRecord = findRecord(records, (args) => args[0] === "container" && args[1] === "ls", "ownership-label cleanup query missing");
  assert.equal(labelRecord.code, 0);
  assert.equal(output(labelRecord), "");
  assert.ok(operation(labelRecord).includes(`--filter=label=${DOCKER_RUNTIME_CONTRACT.labels.run}=${runId}`));

  const server = JSON.parse(output(versionRecord));
  const info = JSON.parse(output(infoRecord));
  const image = JSON.parse(output(imageRecord));
  assert.equal(server.Os, "linux");
  assert.equal(server.Arch, "arm64");
  assert.ok(info.SecurityOptions.includes("name=userns"));
  assert.equal(info.DefaultRuntime, "runc");
  assert.equal(image.length, 1);
  assert.equal(image[0].Id, EXPECTED_IMAGE_ID);
  assert.ok(image[0].RepoDigests.includes(APPROVED_IMAGE.reference));
  return {
    cleanup: { exact_id_absent: true, exact_id_force_removed: true, ownership_label_absent: true },
    daemon: { api: server.ApiVersion, architecture: server.Arch, engine: server.Version, kernel: info.KernelVersion, userns_remap: true },
    image: { id_matches: true, immutable_reference_matches: true },
    run_id_was_unique: true,
  };
}

async function main() {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "arm64");
  const records = [];
  const state = {};
  let mounted = false;
  let projectRoot;
  try {
    projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "issue18-task2-real-")));
    const agents = path.join(projectRoot, ".codex/agents");
    const nested = path.join(projectRoot, ".codex/nested");
    await fs.mkdir(agents, { recursive: true });
    await fs.mkdir(nested);
    await fs.writeFile(path.join(agents, "main.toml"), PROMPT, { mode: 0o666 });
    await fs.writeFile(path.join(projectRoot, ".codex/managed-prompts.json"), MANIFEST, { mode: 0o666 });
    await Promise.all([projectRoot, path.join(projectRoot, ".codex"), agents, nested].map((target) => fs.chmod(target, 0o777)));
    state.promptHashBefore = sha256(PROMPT, MANIFEST);

    execFileSync("sudo", ["mount", "-t", "tmpfs", "-o", "size=1m,mode=0777,nodev,nosuid,noexec", `issue18-task2-${process.pid}`, nested], { stdio: "pipe" });
    mounted = true;

    let operationFailure;
    const result = await runDockerLifecycle({ approvedImage: APPROVED_IMAGE, permissionProfile: "workspace-only", projectRoot }, {
      spawnProcess: capturedSpawn(records),
      operate: async (transport) => {
        try { await fixtureOperation(transport, projectRoot, state); }
        catch (error) { operationFailure = error; throw error; }
      },
    });
    if (operationFailure) throw operationFailure;
    assert.deepEqual(result, { trusted: false, runtime: "docker", permission_profile: "workspace-only", reason_code: "BROKER_PROCESS_CONTAINMENT_UNAVAILABLE" });

    const dockerEvidence = validateDockerEvidence(records, projectRoot);
    await delay(300);
    const afterRemoval = await fs.readFile(state.heartbeatPath, "utf8");
    await delay(300);
    assert.equal(await fs.readFile(state.heartbeatPath, "utf8"), afterRemoval, "heartbeat continued after authoritative container removal");
    assert.equal(sha256(await fs.readFile(path.join(projectRoot, ".codex/agents/main.toml")), await fs.readFile(path.join(projectRoot, ".codex/managed-prompts.json"))), state.promptHashBefore);

    process.stdout.write(`${JSON.stringify({
      adapter: result,
      assertions: {
        codex_recursive_read_only: state.probe.nested_mount_observed && state.probe.nested_mount_read_only && state.probe.nested_write_read_only,
        detached_reparented_descendant_observed: state.descendantPidObserved,
        descendant_stopped_after_removal: true,
        ordinary_workspace_write: state.probe.ordinary_write_succeeded,
        prompt_bytes_unchanged: true,
        prompt_create_and_write_read_only: state.probe.prompt_create_read_only && state.probe.prompt_write_read_only,
      },
      ...dockerEvidence,
      event: "issue18_task2_real_docker_fixture",
      passed: true,
    })}\n`);
  } finally {
    if (mounted) execFileSync("sudo", ["umount", "--", path.join(projectRoot, ".codex/nested")], { stdio: "pipe" });
    if (projectRoot) await fs.rm(projectRoot, { force: true, recursive: true });
  }
}
