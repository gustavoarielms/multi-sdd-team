import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const TEMPLATE_ROOT = path.join(PACKAGE_ROOT, "codex");
const GOVERNANCE_SCHEMAS_ROOT = path.join(PACKAGE_ROOT, "governance", "schemas", "v1");
const GOVERNANCE_RULES_ROOT = path.join(PACKAGE_ROOT, "governance", "rules", "v1");
const GOVERNANCE_CHECKS_ROOT = path.join(PACKAGE_ROOT, "governance", "checks", "v1");
const GOVERNANCE_GATES_ROOT = path.join(PACKAGE_ROOT, "governance", "gates", "v1");
const GOVERNANCE_PROFILES_ROOT = path.join(PACKAGE_ROOT, "governance", "profiles", "v1");
const MANAGED_MARKER = "multi-sdd-team";
const MANIFEST_NAME = ".sdd-codegraph.json";
const DEFAULT_PERMISSION_PROFILE = "workspace-only";
const PERMISSION_PROFILE_VALUES = new Map([
  ["workspace-only", "workspace-only"],
  ["read-only", ":read-only"],
  ["workspace", ":workspace"],
  ["danger-full-access", ":danger-full-access"],
]);

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

async function canonicalInstallRoot(targetPath) {
  const requestedRoot = path.resolve(targetPath);
  await fs.mkdir(requestedRoot, { recursive: true });
  return fs.realpath(requestedRoot);
}

async function assertManagedPathSafe(installRoot, relativePath) {
  const target = path.resolve(installRoot, relativePath);
  const relative = path.relative(installRoot, target);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Managed path escapes installation root: ${relativePath}`);
  }

  let current = installRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Managed path contains a symbolic link: ${relativePath}`);
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

async function readManagedTextIfExists(installRoot, relativePath) {
  await assertManagedPathSafe(installRoot, relativePath);
  return readTextIfExists(path.join(installRoot, relativePath));
}

async function writeManagedFile(installRoot, relativePath, content) {
  await assertManagedPathSafe(installRoot, relativePath);
  const target = path.join(installRoot, relativePath);
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  await assertManagedPathSafe(installRoot, relativePath);

  let mode = 0o666;
  try {
    mode = (await fs.lstat(target)).mode & 0o777;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporary = path.join(parent, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
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

function tomlKeySource(key) {
  const escapedKey = escapeRegExp(key);
  if (/^[A-Za-z0-9_-]+$/.test(key)) {
    return `(?:${escapedKey}|"${escapedKey}"|'${escapedKey}')`;
  }
  return escapedKey;
}

function keyPattern(key) {
  return new RegExp(`^\\s*${tomlKeySource(key)}\\s*=`);
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

function validatePermissionProfile(permissionProfile) {
  if (!PERMISSION_PROFILE_VALUES.has(permissionProfile)) {
    throw new Error(
      `Unsupported permissions profile: ${permissionProfile}. Expected one of: ${[
        ...PERMISSION_PROFILE_VALUES.keys(),
      ].join(", ")}`,
    );
  }
  return permissionProfile;
}

function configuredPermissionProfile(config) {
  const lines = config.split(/\r?\n/);
  const firstTable = lines.findIndex(isTable);
  const topLevelLines = firstTable === -1 ? lines : lines.slice(0, firstTable);
  const declarations = topLevelLines.filter((line) => keyPattern("default_permissions").test(line));
  if (declarations.length === 0) return undefined;

  const declarationPattern = new RegExp(
    `^\\s*${tomlKeySource("default_permissions")}\\s*=\\s*`
      + `(?:"([^"]+)"|'([^']+)')\\s*(?:#.*)?$`,
  );
  const match = declarations.length === 1
    ? declarations[0].match(declarationPattern)
    : null;
  const configuredValue = match?.[1] ?? match?.[2];
  for (const [profile, value] of PERMISSION_PROFILE_VALUES) {
    if (value === configuredValue) return profile;
  }

  throw new Error(
    "Unsupported or ambiguous default_permissions in .codex/config.toml. "
      + `Explicitly select one with --permissions: ${[...PERMISSION_PROFILE_VALUES.keys()].join(", ")}`,
  );
}

async function resolvePermissionProfile(installRoot, requestedProfile) {
  if (requestedProfile !== undefined) return validatePermissionProfile(requestedProfile);

  const config = await readManagedTextIfExists(installRoot, path.join(".codex", "config.toml"));
  return configuredPermissionProfile(config) ?? DEFAULT_PERMISSION_PROFILE;
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
    assertReadable(GOVERNANCE_RULES_ROOT),
    assertReadable(GOVERNANCE_CHECKS_ROOT),
    assertReadable(GOVERNANCE_GATES_ROOT),
    assertReadable(GOVERNANCE_PROFILES_ROOT),
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

  const governanceRules = new Map();
  for (const name of (await fs.readdir(GOVERNANCE_RULES_ROOT)).filter((item) => item.endsWith(".json")).sort()) {
    governanceRules.set(name, await fs.readFile(path.join(GOVERNANCE_RULES_ROOT, name), "utf8"));
  }
  const governanceChecks = new Map();
  for (const name of (await fs.readdir(GOVERNANCE_CHECKS_ROOT)).filter((item) => item.endsWith(".json")).sort()) {
    governanceChecks.set(name, await fs.readFile(path.join(GOVERNANCE_CHECKS_ROOT, name), "utf8"));
  }
  const governanceGates = new Map();
  for (const name of (await fs.readdir(GOVERNANCE_GATES_ROOT)).filter((item) => item.endsWith(".json")).sort()) {
    governanceGates.set(name, await fs.readFile(path.join(GOVERNANCE_GATES_ROOT, name), "utf8"));
  }
  const governanceProfiles = new Map();
  for (const name of (await fs.readdir(GOVERNANCE_PROFILES_ROOT)).filter((item) => item.endsWith(".json")).sort()) {
    governanceProfiles.set(name, await fs.readFile(path.join(GOVERNANCE_PROFILES_ROOT, name), "utf8"));
  }

  return {
    agents,
    governanceSchemas,
    governanceRules,
    governanceChecks,
    governanceGates,
    governanceProfiles,
    pipeline: await fs.readFile(pipelinePath, "utf8"),
    agentsPolicy: await fs.readFile(agentsPath, "utf8"),
  };
}

async function expectedInstallFiles(installRoot, codexPrefix, includeManifest, permissionProfile) {
  const [metadata, templates] = await Promise.all([loadPackageMetadata(), loadTemplates()]);
  const files = new Map();

  for (const [name, content] of templates.agents) {
    files.set(path.join(codexPrefix, "agents", name), content);
  }
  for (const [name, content] of templates.governanceSchemas) {
    files.set(path.join(codexPrefix, "governance", "schemas", "v1", name), content);
  }
  for (const [name, content] of templates.governanceRules) {
    files.set(path.join(codexPrefix, "governance", "rules", "v1", name), content);
  }
  for (const [name, content] of templates.governanceChecks) {
    files.set(path.join(codexPrefix, "governance", "checks", "v1", name), content);
  }
  for (const [name, content] of templates.governanceGates) {
    files.set(path.join(codexPrefix, "governance", "gates", "v1", name), content);
  }
  for (const [name, content] of templates.governanceProfiles) {
    files.set(path.join(codexPrefix, "governance", "profiles", "v1", name), content);
  }

  files.set("pipeline.json", templates.pipeline);

  const currentAgents = await readManagedTextIfExists(installRoot, "AGENTS.md");
  files.set("AGENTS.md", mergeManagedBlock(currentAgents, templates.agentsPolicy));

  const configRelativePath = path.join(codexPrefix, "config.toml");
  let config = await readManagedTextIfExists(installRoot, configRelativePath);
  config = setTomlKey(config, "", "service_tier", '"fast"');
  config = setTomlKey(config, "features", "fast_mode", "true");
  config = setTomlKey(config, "agents", "max_threads", "6");
  config = setTomlKey(config, "agents", "max_depth", "1");
  if (includeManifest) {
    config = setTomlKey(config, "", "default_permissions", JSON.stringify(
      PERMISSION_PROFILE_VALUES.get(permissionProfile),
    ));
    if (permissionProfile === "workspace-only") {
      config = setTomlKey(config, "permissions.workspace-only", "extends", '":workspace"');
      config = setTomlKey(config, "permissions.workspace-only.filesystem", '":root"', '"deny"');
      config = setTomlKey(config, "permissions.workspace-only.filesystem", '":minimal"', '"read"');
      config = setTomlKey(config, "permissions.workspace-only.filesystem", '":tmpdir"', '"deny"');
      config = setTomlKey(config, "permissions.workspace-only.filesystem", '":slash_tmp"', '"deny"');
      config = setTomlKey(config, "permissions.workspace-only.network", "enabled", "false");
    }
  }
  files.set(configRelativePath, config);

  if (includeManifest) {
    const manifest = {
      schemaVersion: 1,
      package: metadata.name,
      version: metadata.version,
      permissionsProfile: permissionProfile,
    };
    files.set(MANIFEST_NAME, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return files;
}

async function installFiles(targetPath, codexPrefix, includeManifest, options = {}) {
  const installRoot = await canonicalInstallRoot(targetPath);
  const permissionProfile = includeManifest
    ? await resolvePermissionProfile(installRoot, options.permissions)
    : undefined;
  const expected = await expectedInstallFiles(
    installRoot,
    codexPrefix,
    includeManifest,
    permissionProfile,
  );
  await Promise.all([...expected.keys()].map((relativePath) => (
    assertManagedPathSafe(installRoot, relativePath)
  )));
  const changed = [];

  for (const [relativePath, content] of expected) {
    const current = await readManagedTextIfExists(installRoot, relativePath);
    if (current === content) continue;
    await writeManagedFile(installRoot, relativePath, content);
    changed.push(relativePath);
  }

  return { installRoot, changed };
}

export async function installProject(targetPath, options = {}) {
  const result = await installFiles(targetPath, ".codex", true, options);
  return { projectRoot: result.installRoot, changed: result.changed };
}

export async function installGlobal(targetPath) {
  const result = await installFiles(targetPath, "", false);
  return { codexHome: result.installRoot, changed: result.changed };
}

export async function checkProjectFiles(targetPath) {
  const projectRoot = await fs.realpath(path.resolve(targetPath));
  const permissionProfile = await resolvePermissionProfile(projectRoot);
  const expected = await expectedInstallFiles(projectRoot, ".codex", true, permissionProfile);
  const drift = [];

  for (const [relativePath, content] of expected) {
    const current = await readManagedTextIfExists(projectRoot, relativePath);
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
