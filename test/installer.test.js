import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkCodeGraph,
  checkProjectFiles,
  installProject,
  mergeManagedBlock,
  setTomlKey,
  syncCodeGraph,
} from "../src/installer.js";

async function temporaryProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), "sdd-codegraph-test-"));
}

test("package is configured for public MIT publication", async () => {
  const packagePath = new URL("../package.json", import.meta.url);
  const metadata = JSON.parse(await fs.readFile(packagePath, "utf8"));
  assert.equal("private" in metadata, false);
  assert.equal(metadata.license, "MIT");
  assert.equal(metadata.publishConfig.access, "public");
  assert.equal("prepublishOnly" in metadata.scripts, false);
  assert.equal(metadata.version, "0.2.0");
  assert.deepEqual(metadata.files, [
    "README.md",
    "NOTICE.md",
    "bin",
    "docs",
    "codex",
    "governance",
    "src",
    "setup.sh",
  ]);
  assert.equal("peerDependencies" in metadata, false);
  assert.equal("peerDependenciesMeta" in metadata, false);
  assert.deepEqual(metadata.keywords, ["codex", "codegraph", "derivative", "sdd", "subagents", "multi-agent"]);
});

test("package source contains only the Codex runtime surface", async () => {
  for (const relative of ["agents", "extensions", "prompts"]) {
    await assert.rejects(fs.access(new URL(`../${relative}/`, import.meta.url)), { code: "ENOENT" });
  }
});

test("Codex exposes the complete governed agent catalog", async () => {
  const root = new URL("../", import.meta.url);
  const codexAgentFiles = (await fs.readdir(new URL("codex/agents/", root)))
    .filter((name) => name.endsWith(".toml"));

  const readDeclaredNames = async (directory, files, pattern) => Promise.all(
    files.map(async (file) => {
      const content = await fs.readFile(new URL(`${directory}/${file}`, root), "utf8");
      const match = content.match(pattern);
      assert.ok(match, `missing declared agent name in ${directory}/${file}`);
      return match[1].replaceAll("-", "_");
    }),
  );

  const codexNames = await readDeclaredNames("codex/agents", codexAgentFiles, /^name\s*=\s*"([^"]+)"$/m);
  const expected = [
    "architecture_reviewer",
    "documentator",
    "explorer",
    "hacker",
    "implementer",
    "orchestrator",
    "planner",
    "tester_reviewer",
  ];

  assert.deepEqual(codexNames.sort(), expected);
});

test("Codex review gates require pure governance JSON", async () => {
  const root = new URL("../", import.meta.url);
  const reviewAgents = [
    ["architecture-reviewer", "architecture_reviewer", "architecture"],
    ["tester-reviewer", "tester_reviewer", "quality"],
    ["hacker", "hacker", "security"],
  ];

  for (const [fileName, role, gateType] of reviewAgents) {
    const codexPrompt = await fs.readFile(new URL(`codex/agents/${fileName}.toml`, root), "utf8");
    assert.match(codexPrompt, /exactamente un objeto JSON/);
    assert.match(codexPrompt, /sin Markdown/);
    assert.match(codexPrompt, new RegExp(`producer\\.role.{0,10}${role}`));
    assert.match(codexPrompt, new RegExp(`gate_type.{0,10}${gateType}`));
    assert.match(codexPrompt, /producer\.runtime.{0,10}codex/);
  }
});

test("pipeline routes review remediation through implementer and architecture revalidation", async () => {
  const pipeline = JSON.parse(await fs.readFile(new URL("../codex/pipeline.json", import.meta.url), "utf8"));
  const sdd = pipeline.strategies.SDD_SUBAGENTS.sequence;
  const byId = new Map(sdd.map((step) => [step.id, step]));

  assert.equal(pipeline.version, 2);
  assert.equal(byId.get("architecture_design_review").actor, "architecture_reviewer");
  assert.equal(byId.get("architecture_compliance_review").actor, "architecture_reviewer");
  assert.deepEqual(byId.get("architecture_compliance_review").depends_on, ["deterministic_checks"]);
  assert.match(byId.get("main_integrate").action, /Route findings to implementer/);
  assert.doesNotMatch(JSON.stringify(pipeline), /main (?:session|orchestrator) (?:applies|fixes|resolve)/i);
});

test("mergeManagedBlock preserves unmanaged content and replaces the managed block", () => {
  const existing = "# Project rules\n\n<!-- multi-sdd-team: begin -->\nold\n<!-- multi-sdd-team: end -->\n";
  const result = mergeManagedBlock(existing, "new policy\n");
  assert.equal(
    result,
    "# Project rules\n\n<!-- multi-sdd-team: begin -->\nnew policy\n<!-- multi-sdd-team: end -->\n",
  );
});

test("setTomlKey preserves unrelated settings", () => {
  let config = "custom = true\n\n[agents]\nmax_depth = 9\nextra = \"keep\"\n";
  config = setTomlKey(config, "", "service_tier", '"fast"');
  config = setTomlKey(config, "agents", "max_depth", "1");
  assert.match(config, /custom = true/);
  assert.match(config, /service_tier = "fast"/);
  assert.match(config, /max_depth = 1/);
  assert.match(config, /extra = "keep"/);
});

test("installProject is idempotent and preserves project-specific content", async (context) => {
  const project = await temporaryProject();
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.mkdir(path.join(project, ".codex"), { recursive: true });
  await fs.writeFile(path.join(project, "AGENTS.md"), "# Product rules\n", "utf8");
  await fs.writeFile(path.join(project, ".codex", "config.toml"), "custom = true\n", "utf8");

  const first = await installProject(project);
  const second = await installProject(project);
  assert.ok(first.changed.includes("AGENTS.md"));
  assert.deepEqual(second.changed, []);

  const agents = await fs.readFile(path.join(project, "AGENTS.md"), "utf8");
  const architectureReviewer = await fs.readFile(
    path.join(project, ".codex", "agents", "architecture-reviewer.toml"),
    "utf8",
  );
  const agentResultSchema = JSON.parse(await fs.readFile(
    path.join(project, ".codex", "governance", "schemas", "v1", "agent-result.schema.json"),
    "utf8",
  ));
  const catalog = JSON.parse(await fs.readFile(
    path.join(project, ".codex", "governance", "rules", "v1", "catalog.json"),
    "utf8",
  ));
  const registry = JSON.parse(await fs.readFile(
    path.join(project, ".codex", "governance", "checks", "v1", "registry.json"),
    "utf8",
  ));
  const config = await fs.readFile(path.join(project, ".codex", "config.toml"), "utf8");
  const manifest = JSON.parse(await fs.readFile(path.join(project, ".sdd-codegraph.json"), "utf8"));
  assert.match(agents, /^# Product rules/m);
  assert.match(agents, /<!-- multi-sdd-team: begin -->/);
  assert.match(agents, /sdd-codegraph validate-result - --agent <agent_name>/);
  assert.doesNotMatch(agents, /validate-result[^\n]*--runtime/);
  assert.match(architectureReviewer, /name = "architecture_reviewer"/);
  assert.equal(agentResultSchema.title, "Governance Agent Result v1");
  assert.equal(catalog.rules[0].rule_id, "GOV-CATALOG-INTEGRITY-001");
  assert.equal(registry.checks[0].check_id, "governance_catalog_integrity");
  assert.match(config, /custom = true/);
  assert.equal(manifest.package, "@gustavoarielms/sdd-codegraph-cli");
  assert.equal(manifest.version, "0.2.0");
  assert.equal((await checkProjectFiles(project)).drift.length, 0);
});

test("installProject rejects managed directory, file, and broken symlinks", async (context) => {
  const root = await temporaryProject();
  const external = path.join(root, "external");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(external);

  const cases = [
    ["directory", ".codex", external],
    ["file", "AGENTS.md", path.join(external, "agents.md")],
    ["broken", "pipeline.json", path.join(external, "missing.json")],
  ];
  await fs.writeFile(path.join(external, "agents.md"), "sentinel\n", "utf8");
  for (const [name, managedPath, linkTarget] of cases) {
    const project = path.join(root, name);
    await fs.mkdir(project);
    await fs.symlink(linkTarget, path.join(project, managedPath));
    await assert.rejects(installProject(project), /managed path contains a symbolic link/i);
  }

  assert.equal(await fs.readFile(path.join(external, "agents.md"), "utf8"), "sentinel\n");
  assert.deepEqual(await fs.readdir(external), ["agents.md"]);
});

test("shell project and global installers copy equivalent governance contracts", async (context) => {
  const root = await temporaryProject();
  const project = path.join(root, "project");
  const codexHome = path.join(root, "global-codex");
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  execFileSync("bash", [new URL("../setup.sh", import.meta.url).pathname, "--global", "--project", project], {
    env: { ...process.env, CODEX_HOME: codexHome },
  });

  for (const relative of [
    path.join("schemas", "v1", "rule-catalog.schema.json"),
    path.join("schemas", "v1", "governance-check-result.schema.json"),
    path.join("rules", "v1", "catalog.json"),
    path.join("checks", "v1", "registry.json"),
  ]) {
    const globalContent = await fs.readFile(path.join(codexHome, "governance", relative), "utf8");
    const projectContent = await fs.readFile(path.join(project, ".codex", "governance", relative), "utf8");
    assert.equal(projectContent, globalContent, relative);
  }
});

test("shell installers reject managed symlinks without writing outside their roots", async (context) => {
  const root = await temporaryProject();
  const project = path.join(root, "project");
  const codexHome = path.join(root, "global-codex");
  const externalProject = path.join(root, "external-project.md");
  const externalGlobal = path.join(root, "external-global.json");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(project);
  await fs.mkdir(codexHome);
  await fs.writeFile(externalProject, "project sentinel\n", "utf8");
  await fs.writeFile(externalGlobal, "global sentinel\n", "utf8");
  await fs.symlink(externalProject, path.join(project, "AGENTS.md"));
  await fs.symlink(externalGlobal, path.join(codexHome, "pipeline.json"));

  const projectSetup = spawnSync("bash", [
    new URL("../setup.sh", import.meta.url).pathname,
    "--project",
    project,
  ], { encoding: "utf8" });
  const globalSetup = spawnSync("bash", [
    new URL("../setup.sh", import.meta.url).pathname,
    "--global",
  ], { encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome } });

  assert.equal(projectSetup.status, 1);
  assert.match(projectSetup.stderr, /managed path contains a symbolic link/i);
  assert.equal(globalSetup.status, 1);
  assert.match(globalSetup.stderr, /managed path contains a symbolic link/i);
  assert.equal(await fs.readFile(externalProject, "utf8"), "project sentinel\n");
  assert.equal(await fs.readFile(externalGlobal, "utf8"), "global sentinel\n");
});

test("shell setup rejects the removed target selector", () => {
  const execution = spawnSync("bash", [new URL("../setup.sh", import.meta.url).pathname, "codex", "--global"], {
    encoding: "utf8",
  });
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /Unknown setup option/);
});

test("shell setup requires an explicit installation scope", async (context) => {
  const codexHome = await temporaryProject();
  context.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  const execution = spawnSync("bash", [new URL("../setup.sh", import.meta.url).pathname], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /Usage:/);
  assert.deepEqual(await fs.readdir(codexHome), []);
});

test("checkProjectFiles reports managed drift", async (context) => {
  const project = await temporaryProject();
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await installProject(project);
  await fs.writeFile(path.join(project, "pipeline.json"), "{}\n", "utf8");
  assert.deepEqual((await checkProjectFiles(project)).drift, ["pipeline.json"]);
});

test("syncCodeGraph initializes a new project", () => {
  const calls = [];
  const runner = (_command, args) => {
    calls.push(args);
    if (args[0] === "status") {
      return { status: 0, stdout: JSON.stringify({ initialized: false }), stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  assert.equal(syncCodeGraph(".", runner), "initialized");
  assert.equal(calls[1][0], "init");
  assert.equal(calls[1][1], "-i");
});

test("checkCodeGraph rejects pending changes", () => {
  const runner = () => ({
    status: 0,
    stdout: JSON.stringify({
      initialized: true,
      pendingChanges: { added: 1, modified: 1, removed: 0 },
    }),
    stderr: "",
  });

  assert.deepEqual(checkCodeGraph(".", runner), {
    ok: false,
    reason: "CodeGraph has 2 pending change(s).",
  });
});
