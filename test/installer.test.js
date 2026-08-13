import assert from "node:assert/strict";
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
});

test("Pi and Codex expose the same governed agent roles", async () => {
  const root = new URL("../", import.meta.url);
  const piAgentFiles = (await fs.readdir(new URL("agents/", root)))
    .filter((name) => name.endsWith(".md"));
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

  const piNames = await readDeclaredNames("agents", piAgentFiles, /^name:\s*([^\s]+)$/m);
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

  assert.deepEqual(piNames.sort(), expected);
  assert.deepEqual(codexNames.sort(), expected);
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
  const config = await fs.readFile(path.join(project, ".codex", "config.toml"), "utf8");
  const manifest = JSON.parse(await fs.readFile(path.join(project, ".sdd-codegraph.json"), "utf8"));
  assert.match(agents, /^# Product rules/m);
  assert.match(agents, /<!-- multi-sdd-team: begin -->/);
  assert.match(architectureReviewer, /name = "architecture_reviewer"/);
  assert.match(config, /custom = true/);
  assert.equal(manifest.package, "@gustavoarielms/sdd-codegraph-cli");
  assert.equal((await checkProjectFiles(project)).drift.length, 0);
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
