#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NODE_ARCHITECTURE_ADAPTER_TRUST } from "../src/governance-trust.js";
import { validateArchitectureAdapterTrust } from "../src/governance-validator.js";
import { compareCodeUnits } from "../src/node-architecture-contract.js";
import { runtimeResolutionGraph } from "../src/node-architecture-runtime-topology.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "node-architecture-runtime-verify-"));

function run(executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${executable} verification command failed`);
  return result.stdout;
}

async function files(directory, prefix = "") {
  const result = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => compareCodeUnits(a.name, b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(absolute, relative));
    else if (entry.isFile()) result.push({ relative, absolute });
    else throw new Error(`unexpected generated entry: ${relative}`);
  }
  return result.sort((left, right) => compareCodeUnits(left.relative, right.relative));
}

async function equalFile(left, right) {
  return Buffer.compare(await fs.readFile(left), await fs.readFile(right)) === 0;
}

async function equalTree(left, right) {
  const [leftFiles, rightFiles] = await Promise.all([files(left), files(right)]);
  if (JSON.stringify(leftFiles.map((file) => file.relative)) !== JSON.stringify(rightFiles.map((file) => file.relative))) {
    return false;
  }
  for (let index = 0; index < leftFiles.length; index += 1) {
    if (!await equalFile(leftFiles[index].absolute, rightFiles[index].absolute)) return false;
  }
  return true;
}

async function validNoticeHeader(noticePath) {
  const [notice, header] = await Promise.all([
    fs.readFile(noticePath, "utf8"),
    fs.readFile(path.join(repositoryRoot, NODE_ARCHITECTURE_ADAPTER_TRUST.notice_header_path), "utf8"),
  ]);
  const marker = "<!-- BEGIN GENERATED NODE ARCHITECTURE RUNTIME NOTICES -->";
  const markerIndex = notice.indexOf(marker);
  return markerIndex >= 0 && notice.slice(0, markerIndex).trimEnd() === header.trimEnd();
}

try {
  const trust = await validateArchitectureAdapterTrust();
  if (!trust.ok) throw new Error("committed architecture trust anchor is invalid");
  for (const file of ["package.json", "package-lock.json"]) {
    await fs.copyFile(path.join(repositoryRoot, file), path.join(temporaryRoot, file));
  }
  run("npm", ["ci", "--offline", "--ignore-scripts"], temporaryRoot);
  const generatedRuntime = path.join(temporaryRoot, "generated-runtime");
  const generatedManifest = path.join(temporaryRoot, "generated-manifest.json");
  const generatedNotice = path.join(temporaryRoot, "NOTICE.md");
  await fs.copyFile(path.join(repositoryRoot, "NOTICE.md"), generatedNotice);
  run(process.execPath, [
    path.join(repositoryRoot, "scripts/generate-node-architecture-runtime.js"),
    "--install-root", temporaryRoot,
    "--output-root", generatedRuntime,
    "--manifest", generatedManifest,
    "--notice", generatedNotice,
  ], repositoryRoot);
  const [installedGraph, generatedGraph, committedGraph] = await Promise.all([
    runtimeResolutionGraph(temporaryRoot),
    runtimeResolutionGraph(generatedRuntime),
    runtimeResolutionGraph(path.join(repositoryRoot, NODE_ARCHITECTURE_ADAPTER_TRUST.runtime_root_path)),
  ]);
  if (!await equalTree(path.join(repositoryRoot, "vendor/node-architecture-runtime"), generatedRuntime)
    || !await equalFile(
      path.join(repositoryRoot, "governance/adapters/v1/node-dependency-cruiser-runtime-manifest.json"),
      generatedManifest,
    )
    || !await equalFile(path.join(repositoryRoot, "NOTICE.md"), generatedNotice)
    || !await validNoticeHeader(generatedNotice)
    || JSON.stringify(installedGraph) !== JSON.stringify(generatedGraph)
    || JSON.stringify(installedGraph) !== JSON.stringify(committedGraph)) {
    throw new Error("committed architecture runtime is not reproducible from the lockfile");
  }
  const pack = JSON.parse(run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], repositoryRoot))[0];
  const packedPaths = new Set(pack.files.map((file) => file.path));
  const manifest = JSON.parse(await fs.readFile(generatedManifest, "utf8"));
  const required = [
    "NOTICE.md",
    NODE_ARCHITECTURE_ADAPTER_TRUST.notice_header_path,
    "governance/adapters/v1/node-dependency-cruiser.json",
    "governance/adapters/v1/node-dependency-cruiser-runtime-manifest.json",
    "scripts/generate-node-architecture-runtime.js",
    "scripts/verify-node-architecture-runtime.js",
    "src/node-architecture-runtime-topology.js",
    ...manifest.files.map((file) => `vendor/node-architecture-runtime/${file.path}`),
  ];
  if (required.some((file) => !packedPaths.has(file))) throw new Error("npm pack omits architecture runtime assets");
  process.stdout.write(`verified ${manifest.files.length} runtime file(s)\n`);
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
