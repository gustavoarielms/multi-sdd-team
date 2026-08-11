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
  const config = await fs.readFile(path.join(project, ".codex", "config.toml"), "utf8");
  const manifest = JSON.parse(await fs.readFile(path.join(project, ".sdd-codegraph.json"), "utf8"));
  assert.match(agents, /^# Product rules/m);
  assert.match(agents, /<!-- multi-sdd-team: begin -->/);
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
