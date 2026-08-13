import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const TEMPLATE_ROOT = path.join(PACKAGE_ROOT, "codex");
const GOVERNANCE_SCHEMAS_ROOT = path.join(PACKAGE_ROOT, "governance", "schemas", "v1");
const MANAGED_MARKER = "multi-sdd-team";
const MANIFEST_NAME = ".sdd-codegraph.json";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function assertReadable(filePath) {
  try {
    await fs.access(filePath, fsConstants.R_OK);
  } catch {
    throw new Error(`Missing package template: ${filePath}`);
  }
}

export function mergeManagedBlock(existing, managedContent, marker = MANAGED_MARKER) {
  const begin = `<!-- ${marker}: begin -->`;
  const end = `<!-- ${marker}: end -->`;
  const block = `${begin}\n${managedContent.trimEnd()}\n${end}\n`;
  const pattern = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`);

  if (pattern.test(existing)) return existing.replace(pattern, block);

  let result = existing;
  if (result && !result.endsWith("\n")) result += "\n";
  if (result) result += "\n";
  return result + block;
}

function isTable(line) {
  const value = line.trim();
  return value.startsWith("[") && value.endsWith("]");
}

function keyPattern(key) {
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
}

export function setTomlKey(existing, table, key, value) {
  const lines = existing.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const pattern = keyPattern(key);

  if (table === "") {
    const firstTable = lines.findIndex(isTable);
    const end = firstTable === -1 ? lines.length : firstTable;
    const index = lines.slice(0, end).findIndex((line) => pattern.test(line));
    if (index === -1) lines.splice(end, 0, `${key} = ${value}`);
    else lines[index] = `${key} = ${value}`;
  } else {
    const header = `[${table}]`;
    const start = lines.findIndex((line) => line.trim() === header);
    if (start === -1) {
      if (lines.length > 0 && lines.at(-1).trim()) lines.push("");
      lines.push(header, `${key} = ${value}`);
    } else {
      const relativeEnd = lines.slice(start + 1).findIndex(isTable);
      const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
      const relativeIndex = lines.slice(start + 1, end).findIndex((line) => pattern.test(line));
      if (relativeIndex === -1) lines.splice(start + 1, 0, `${key} = ${value}`);
      else lines[start + 1 + relativeIndex] = `${key} = ${value}`;
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function loadPackageMetadata() {
  return JSON.parse(await fs.readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
}

async function loadTemplates() {
  const agentsRoot = path.join(TEMPLATE_ROOT, "agents");
  const pipelinePath = path.join(TEMPLATE_ROOT, "pipeline.json");
  const agentsPath = path.join(TEMPLATE_ROOT, "AGENTS.md");
  await Promise.all([
    assertReadable(agentsRoot),
    assertReadable(pipelinePath),
    assertReadable(agentsPath),
    assertReadable(GOVERNANCE_SCHEMAS_ROOT),
  ]);

  const agentNames = (await fs.readdir(agentsRoot))
    .filter((name) => name.endsWith(".toml"))
    .sort();

  if (agentNames.length === 0) throw new Error(`No Codex agent templates found in ${agentsRoot}`);

  const agents = new Map();
  for (const name of agentNames) {
    agents.set(name, await fs.readFile(path.join(agentsRoot, name), "utf8"));
  }

  const governanceSchemas = new Map();
  const schemaNames = (await fs.readdir(GOVERNANCE_SCHEMAS_ROOT))
    .filter((name) => name.endsWith(".schema.json"))
    .sort();
  for (const name of schemaNames) {
    governanceSchemas.set(name, await fs.readFile(path.join(GOVERNANCE_SCHEMAS_ROOT, name), "utf8"));
  }

  return {
    agents,
    governanceSchemas,
    pipeline: await fs.readFile(pipelinePath, "utf8"),
    agentsPolicy: await fs.readFile(agentsPath, "utf8"),
  };
}

async function expectedProjectFiles(projectRoot) {
  const [metadata, templates] = await Promise.all([loadPackageMetadata(), loadTemplates()]);
  const files = new Map();

  for (const [name, content] of templates.agents) {
    files.set(path.join(".codex", "agents", name), content);
  }
  for (const [name, content] of templates.governanceSchemas) {
    files.set(path.join(".codex", "governance", "schemas", "v1", name), content);
  }

  files.set("pipeline.json", templates.pipeline);

  const agentsPath = path.join(projectRoot, "AGENTS.md");
  const currentAgents = await readTextIfExists(agentsPath);
  files.set("AGENTS.md", mergeManagedBlock(currentAgents, templates.agentsPolicy));

  const configPath = path.join(projectRoot, ".codex", "config.toml");
  let config = await readTextIfExists(configPath);
  config = setTomlKey(config, "", "service_tier", '"fast"');
  config = setTomlKey(config, "features", "fast_mode", "true");
  config = setTomlKey(config, "agents", "max_threads", "6");
  config = setTomlKey(config, "agents", "max_depth", "1");
  files.set(path.join(".codex", "config.toml"), config);

  const manifest = {
    schemaVersion: 1,
    package: metadata.name,
    version: metadata.version,
  };
  files.set(MANIFEST_NAME, `${JSON.stringify(manifest, null, 2)}\n`);

  return files;
}

export async function installProject(targetPath) {
  const projectRoot = path.resolve(targetPath);
  await fs.mkdir(projectRoot, { recursive: true });
  const expected = await expectedProjectFiles(projectRoot);
  const changed = [];

  for (const [relativePath, content] of expected) {
    const target = path.join(projectRoot, relativePath);
    const current = await readTextIfExists(target);
    if (current === content) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    changed.push(relativePath);
  }

  return { projectRoot, changed };
}

export async function checkProjectFiles(targetPath) {
  const projectRoot = path.resolve(targetPath);
  const expected = await expectedProjectFiles(projectRoot);
  const drift = [];

  for (const [relativePath, content] of expected) {
    const current = await readTextIfExists(path.join(projectRoot, relativePath));
    if (current !== content) drift.push(relativePath);
  }

  return { projectRoot, drift };
}

function runCodeGraph(args, projectRoot, runner) {
  const result = runner("codegraph", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error?.code === "ENOENT") {
    throw new Error("CodeGraph executable not found in PATH.");
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`CodeGraph command failed: ${details}`);
  }
  return result.stdout ?? "";
}

export function getCodeGraphStatus(targetPath, runner = spawnSync) {
  const projectRoot = path.resolve(targetPath);
  const output = runCodeGraph(["status", "--json", projectRoot], projectRoot, runner);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("CodeGraph returned an invalid status response.");
  }
}

export function syncCodeGraph(targetPath, runner = spawnSync) {
  const projectRoot = path.resolve(targetPath);
  const status = getCodeGraphStatus(projectRoot, runner);
  const args = status.initialized ? ["sync", projectRoot] : ["init", "-i", projectRoot];
  runCodeGraph(args, projectRoot, runner);
  return status.initialized ? "synced" : "initialized";
}

export function checkCodeGraph(targetPath, runner = spawnSync) {
  const status = getCodeGraphStatus(targetPath, runner);
  if (!status.initialized) return { ok: false, reason: "CodeGraph is not initialized." };

  const pending = status.pendingChanges ?? {};
  const pendingCount = (pending.added ?? 0) + (pending.modified ?? 0) + (pending.removed ?? 0);
  if (pendingCount > 0) {
    return { ok: false, reason: `CodeGraph has ${pendingCount} pending change(s).` };
  }

  return { ok: true, reason: "CodeGraph is initialized and up to date." };
}
