#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NODE_ARCHITECTURE_ADAPTER_TRUST } from "../src/governance-trust.js";
import { compareCodeUnits } from "../src/node-architecture-contract.js";
import { runtimeClosure } from "../src/node-architecture-runtime-topology.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : path.resolve(process.argv[index + 1]);
}

const installRoot = argument("--install-root", repositoryRoot);
const outputRoot = argument("--output-root", path.join(repositoryRoot, "vendor/node-architecture-runtime"));
const manifestPath = argument(
  "--manifest",
  path.join(repositoryRoot, NODE_ARCHITECTURE_ADAPTER_TRUST.runtime_manifest_path),
);
const noticePath = argument("--notice", path.join(repositoryRoot, "NOTICE.md"));

async function copyPackage(installed) {
  const destination = path.join(outputRoot, installed.relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(installed.directory, destination, {
    recursive: true,
    filter(source) {
      return path.basename(source) !== "node_modules";
    },
  });
}

async function licenseText(installed) {
  const entries = await fs.readdir(installed.directory);
  const candidate = entries.sort(compareCodeUnits).find((entry) => /^(licen[cs]e|copying)(?:[._-].+)?$/iu.test(entry));
  if (!candidate) throw new Error(`missing license text: ${installed.manifest.name}`);
  const source = path.join(installed.directory, candidate);
  const stat = await fs.stat(source);
  if (!stat.isFile()) throw new Error(`invalid license text: ${installed.manifest.name}`);
  return fs.readFile(source);
}

function licenseFileName(name, version) {
  return `${name.replaceAll("/", "__").replaceAll("@", "_")}@${version}.txt`;
}

async function writeLicenses(packages) {
  const byIdentity = new Map();
  for (const installed of packages.values()) {
    byIdentity.set(`${installed.manifest.name}\u0000${installed.manifest.version}`, installed);
  }
  const inventory = [];
  const directory = path.join(outputRoot, "licenses");
  await fs.mkdir(directory, { recursive: true });
  for (const installed of [...byIdentity.values()].sort((left, right) => {
    const byName = compareCodeUnits(left.manifest.name, right.manifest.name);
    return byName || compareCodeUnits(left.manifest.version, right.manifest.version);
  })) {
    const name = installed.manifest.name;
    const license = installed.manifest.license;
    if (typeof license !== "string" || license.length === 0) throw new Error(`missing license: ${name}`);
    const file = licenseFileName(name, installed.manifest.version);
    await fs.writeFile(path.join(directory, file), await licenseText(installed));
    inventory.push({
      package: name,
      version: installed.manifest.version,
      license,
      text_path: `licenses/${file}`,
    });
  }
  await fs.writeFile(path.join(directory, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  const generated = [
    "<!-- BEGIN GENERATED NODE ARCHITECTURE RUNTIME NOTICES -->",
    "",
    "## Bundled node-architecture runtime",
    "",
    "This package bundles the following dependency-cruiser runtime packages.",
    "Corresponding license texts are shipped under vendor/node-architecture-runtime/licenses/.",
    "",
    ...inventory.map((item) => `- ${item.package}@${item.version} — ${item.license}`),
    "",
    "<!-- END GENERATED NODE ARCHITECTURE RUNTIME NOTICES -->",
    "",
  ];
  const start = "<!-- BEGIN GENERATED NODE ARCHITECTURE RUNTIME NOTICES -->";
  const end = "<!-- END GENERATED NODE ARCHITECTURE RUNTIME NOTICES -->";
  let notice = await fs.readFile(noticePath, "utf8").catch(() => "");
  const startIndex = notice.indexOf(start);
  const endIndex = notice.indexOf(end);
  if (startIndex >= 0 && endIndex > startIndex) {
    notice = `${notice.slice(0, startIndex)}${generated.join("\n")}${notice.slice(endIndex + end.length).replace(/^\n*/u, "")}`;
  } else {
    const header = await fs.readFile(path.join(repositoryRoot, NODE_ARCHITECTURE_ADAPTER_TRUST.notice_header_path), "utf8");
    notice = `${header.trimEnd()}\n\n${generated.join("\n")}`;
  }
  await fs.writeFile(noticePath, notice);
}

async function walk(directory, prefix = "") {
  const files = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => compareCodeUnits(a.name, b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`runtime symlink is forbidden: ${relative}`);
    if (entry.isDirectory()) files.push(...await walk(absolute, relative));
    else if (entry.isFile()) files.push({ relative, absolute });
    else throw new Error(`runtime special file is forbidden: ${relative}`);
  }
  return files;
}

async function contentManifest() {
  const files = [];
  for (const file of await walk(outputRoot)) {
    const bytes = await fs.readFile(file.absolute);
    files.push({
      path: file.relative,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  files.sort((left, right) => compareCodeUnits(left.path, right.path));
  return {
    schema_version: "1.0.0",
    entry: NODE_ARCHITECTURE_ADAPTER_TRUST.runtime_entry,
    files,
  };
}

await fs.rm(outputRoot, { recursive: true, force: true });
await fs.mkdir(outputRoot, { recursive: true });
const packages = await runtimeClosure(installRoot);
for (const installed of [...packages.values()].sort((left, right) => compareCodeUnits(left.relative, right.relative))) {
  await copyPackage(installed);
}
await writeLicenses(packages);
const manifest = await contentManifest();
await fs.mkdir(path.dirname(manifestPath), { recursive: true });
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${packages.size} package(s), ${manifest.files.length} file(s)\n`);
