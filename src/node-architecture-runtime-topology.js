import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { isContained } from "./engineering-gate-runtime.js";
import {
  NODE_ARCHITECTURE_ANALYZER,
  NODE_ARCHITECTURE_PATHS,
  compareCodeUnits,
} from "./node-architecture-contract.js";

async function installedPackage(directory, expectedName) {
  const real = await fs.realpath(directory);
  const manifest = JSON.parse(await fs.readFile(path.join(real, "package.json"), "utf8"));
  if (manifest.name !== expectedName || typeof manifest.version !== "string") {
    throw new Error(`invalid installed package identity: ${expectedName}`);
  }
  return { directory: real, manifest };
}

async function resolvePackage(parentDirectory, name, installRoot) {
  let current = parentDirectory;
  while (isContained(installRoot, current)) {
    const candidate = path.join(current, "node_modules", ...name.split("/"));
    try {
      const installed = await installedPackage(candidate, name);
      if (!isContained(installRoot, installed.directory)) throw new Error(`escaped runtime dependency: ${name}`);
      return installed;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (current === installRoot) break;
    current = path.dirname(current);
  }
  return undefined;
}

async function packageFiles(directory, prefix = "") {
  const files = [];
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .sort((left, right) => compareCodeUnits(left.name, right.name));
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`runtime package symlink is forbidden: ${relative}`);
    if (entry.isDirectory()) files.push(...await packageFiles(absolute, relative));
    else if (entry.isFile()) files.push({ relative, absolute });
    else throw new Error(`runtime package special entry is forbidden: ${relative}`);
  }
  return files;
}

async function packageDigest(directory) {
  const hash = createHash("sha256");
  for (const file of await packageFiles(directory)) {
    const bytes = await fs.readFile(file.absolute);
    hash.update(file.relative, "utf8");
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function relativePackagePath(installRoot, directory) {
  const relative = path.relative(installRoot, directory).split(path.sep).join("/");
  if (!relative.startsWith("node_modules/") || relative.includes("../")) {
    throw new Error("invalid runtime package location");
  }
  return relative;
}

export async function runtimeClosure(installRoot) {
  const realRoot = await fs.realpath(installRoot);
  const analyzerDirectory = path.join(realRoot, "node_modules", ...NODE_ARCHITECTURE_ANALYZER.id.split("/"));
  const entryPath = await fs.realpath(path.join(realRoot, NODE_ARCHITECTURE_PATHS.runtimeEntry));
  if (!isContained(analyzerDirectory, entryPath) || !(await fs.stat(entryPath)).isFile()) {
    throw new Error("invalid runtime entry topology");
  }
  const rootPackage = await installedPackage(analyzerDirectory, NODE_ARCHITECTURE_ANALYZER.id);
  const pending = [rootPackage];
  const packages = new Map();
  while (pending.length > 0) {
    pending.sort((left, right) => compareCodeUnits(
      relativePackagePath(realRoot, left.directory),
      relativePackagePath(realRoot, right.directory),
    ));
    const installed = pending.shift();
    const relative = relativePackagePath(realRoot, installed.directory);
    if (packages.has(relative)) continue;
    const dependencyNames = new Set([
      ...Object.keys(installed.manifest.dependencies ?? {}),
      ...Object.keys(installed.manifest.optionalDependencies ?? {}),
      ...Object.keys(installed.manifest.peerDependencies ?? {}),
    ]);
    const dependencies = [];
    for (const name of [...dependencyNames].sort(compareCodeUnits)) {
      const resolved = await resolvePackage(installed.directory, name, realRoot);
      if (!resolved) {
        if (Object.hasOwn(installed.manifest.dependencies ?? {}, name)) {
          throw new Error(`missing runtime dependency: ${installed.manifest.name} -> ${name}`);
        }
        continue;
      }
      const resolvedPath = relativePackagePath(realRoot, resolved.directory);
      dependencies.push({ name, path: resolvedPath, version: resolved.manifest.version });
      pending.push(resolved);
    }
    packages.set(relative, { ...installed, relative, dependencies });
  }
  return packages;
}

export async function runtimeResolutionGraph(installRoot) {
  const packages = await runtimeClosure(installRoot);
  const graph = [];
  for (const installed of packages.values()) {
    graph.push({
      path: installed.relative,
      name: installed.manifest.name,
      version: installed.manifest.version,
      content_sha256: await packageDigest(installed.directory),
      dependencies: installed.dependencies,
    });
  }
  return graph.sort((left, right) => compareCodeUnits(left.path, right.path));
}
