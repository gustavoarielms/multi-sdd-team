import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "./classified-test.js";
import { evaluatePackageSurface } from "../src/engineering-gates.js";
import {
  checkCodeGraph,
  checkProjectFiles,
  installProject,
  mergeManagedBlock,
  setTomlKey,
  syncCodeGraph,
} from "../src/installer.js";
import {
  classifyPromptProtection,
  probeManagedPromptBoundary,
} from "../src/prompt-protection.js";

async function temporaryProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), "sdd-codegraph-test-"));
}

async function deniedPromptBoundary(directoryPaths, promptPaths) {
  return {
    fileWrites: promptPaths.map(() => "denied"),
    directoryMutations: directoryPaths.map(() => "denied"),
  };
}

test("package is configured for public MIT publication", async () => {
  const packagePath = new URL("../package.json", import.meta.url);
  const lockPath = new URL("../package-lock.json", import.meta.url);
  const metadata = JSON.parse(await fs.readFile(packagePath, "utf8"));
  const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assert.equal("private" in metadata, false);
  assert.equal(metadata.license, "MIT");
  assert.equal(metadata.publishConfig.access, "public");
  for (const hook of ["prepublish", "prepare", "prepublishOnly", "prepack", "postpack", "publish", "postpublish"]) {
    assert.equal(hook in metadata.scripts, false, `unexpected publication lifecycle hook: ${hook}`);
  }
  assert.equal(metadata.version, "0.3.0");
  assert.equal(lock.version, metadata.version);
  assert.equal(lock.packages[""].version, metadata.version);
  assert.equal(metadata.engines.node, "^22.14.0 || ^24.0.0 || >=26.0.0");
  assert.deepEqual(metadata.dependencies, {
    "@eslint/js": "10.0.1",
    ajv: "8.20.0",
    c8: "12.0.0",
    "dependency-cruiser": "18.2.0",
    eslint: "10.8.1",
    globals: "17.11.0",
    "istanbul-lib-coverage": "3.2.2",
  });
  assert.deepEqual(metadata.files, [
    "README.md",
    "NOTICE.md",
    "bin",
    "docs",
    "codex",
    "governance",
    "scripts",
    "src",
    "setup.sh",
    "vendor",
  ]);
  assert.equal("peerDependencies" in metadata, false);
  assert.equal("peerDependenciesMeta" in metadata, false);
  assert.deepEqual(metadata.keywords, [
    "codex",
    "codegraph",
    "sdd",
    "software-development",
    "multi-agent",
    "subagents",
    "orchestration",
    "governance",
    "cli",
  ]);
  const notice = await fs.readFile(new URL("../NOTICE.md", import.meta.url), "utf8");
  const noticeHeader = await fs.readFile(
    new URL("../governance/adapters/v1/node-architecture-notice-header.md", import.meta.url),
    "utf8",
  );
  assert.equal(notice.startsWith(noticeHeader.trimEnd()), true);
  assert.match(notice, /## Original project/u);
  assert.match(notice, /@gustavoarielms\/sdd-codegraph-cli/u);
  assert.match(notice, /CodeGraph is a separate external tool\. It is not owned, maintained, or bundled/u);
  assert.match(notice, /<!-- BEGIN GENERATED NODE ARCHITECTURE RUNTIME NOTICES -->/u);
  assert.match(notice, /<!-- END GENERATED NODE ARCHITECTURE RUNTIME NOTICES -->/u);
  assert.match(notice, /dependency-cruiser@18\.2\.0/u);
  const inventory = JSON.parse(await fs.readFile(
    new URL("../vendor/node-architecture-runtime/licenses/inventory.json", import.meta.url),
    "utf8",
  ));
  for (const item of inventory) assert.match(notice, new RegExp(`- ${item.package.replaceAll("/", "\\/")}@${item.version} — ${item.license}`, "u"));
});

test("README publication status does not embed a release version", async () => {
  const readme = await fs.readFile(new URL("../README.md", import.meta.url), "utf8");
  const lines = readme.split("\n");
  const statusLine = lines.findIndex((line) => line.includes("Publication status:"));
  assert.notEqual(statusLine, -1);
  const publicationStatus = lines.slice(statusLine, statusLine + 3).join("\n");
  assert.match(publicationStatus, /@gustavoarielms\/sdd-codegraph-cli/);
  assert.doesNotMatch(publicationStatus, /\b\d+\.\d+\.\d+\b/);
});

test("README clearly defines the package purpose and non-goals", async () => {
  const readme = await fs.readFile(new URL("../README.md", import.meta.url), "utf8");
  const purpose = readme.indexOf("## What this package is for");
  const nonGoals = readme.indexOf("## What this package is not");
  const attribution = readme.indexOf("## Origin and attribution");

  assert.notEqual(purpose, -1);
  assert.notEqual(nonGoals, -1);
  assert.ok(purpose < attribution, "purpose should precede attribution");
  assert.ok(nonGoals < attribution, "non-goals should precede attribution");
  assert.match(readme, /Codex-only installer and governance pack/);
  assert.match(readme, /not an AI agent runtime or scheduler/i);
  assert.match(readme, /does not install CodeGraph/i);
  assert.match(readme, /does not provide compatibility layers for earlier\s+non-Codex runtimes/i);
  assert.match(readme, /does not build, test, merge, deploy, or release consuming applications/i);
});

test("publish workflow requires npm 11.5.1 or newer", async () => {
  const workflow = await fs.readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  const guard = workflow.match(/node -e '([^'\n]+)' "\$npm_version"/);
  assert.ok(guard, "missing executable npm version guard");

  for (const version of ["11.5.1", "11.17.0"]) {
    const result = spawnSync(process.execPath, ["-e", guard[1], version]);
    assert.equal(result.status, 0, `expected npm ${version} to be accepted`);
  }

  const belowMinimum = spawnSync(process.execPath, ["-e", guard[1], "11.5.0"]);
  assert.notEqual(belowMinimum.status, 0, "expected npm 11.5.0 to be rejected");
});

test("publish workflow dogfoods gates and ignores lifecycle scripts for install and publish", async () => {
  const workflow = await fs.readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  const runCommands = [...workflow.matchAll(/^\s+- run: (.+)$/gm)].map((match) => match[1]);

  for (const command of [
    "npm ci --ignore-scripts",
    "env -u C8_CONFIG -u C8_REPORTER -u NODE_OPTIONS -u NODE_PATH -u NODE_V8_COVERAGE -u NYC_CONFIG -u TIMING -u DEBUG -u ESLINT_FLAGS node ./bin/sdd-codegraph.js run-gates . --comparison-base \"$(git rev-parse HEAD^{commit})\"",
    "npm publish --ignore-scripts",
  ]) {
    assert.ok(runCommands.includes(command), `missing fail-closed publish command: ${command}`);
  }
});

test("CI and publish workflows sanitize Node and ESLint control variables", async () => {
  const expectedGateCommands = new Map([
    ["ci.yml", 'env -u C8_CONFIG -u C8_REPORTER -u NODE_OPTIONS -u NODE_PATH -u NODE_V8_COVERAGE -u NYC_CONFIG -u TIMING -u DEBUG -u ESLINT_FLAGS node ./bin/sdd-codegraph.js run-gates . --comparison-base "$COMPARISON_BASE"'],
    ["publish.yml", 'env -u C8_CONFIG -u C8_REPORTER -u NODE_OPTIONS -u NODE_PATH -u NODE_V8_COVERAGE -u NYC_CONFIG -u TIMING -u DEBUG -u ESLINT_FLAGS node ./bin/sdd-codegraph.js run-gates . --comparison-base "$(git rev-parse HEAD^{commit})"'],
  ]);

  for (const [workflow, expectedGateCommand] of expectedGateCommands) {
    const source = await fs.readFile(new URL(`../.github/workflows/${workflow}`, import.meta.url), "utf8");
    const runCommands = [...source.matchAll(/^\s+- run: (.+)$/gm)].map((match) => match[1]);
    for (const variable of ["C8_CONFIG", "C8_REPORTER", "DEBUG", "ESLINT_FLAGS", "NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE", "NYC_CONFIG", "TIMING"]) {
      assert.match(source, new RegExp(`^  ${variable}: ["']{2}$`, "m"), `${workflow} does not sanitize ${variable}`);
    }
    assert.ok(runCommands.includes(expectedGateCommand), `${workflow} does not invoke gates with the sanitized direct launcher`);
    assert.doesNotMatch(source, /^\s+- run: npm run .*gates/m);
  }
  const ci = await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const compatibility = ci.slice(ci.indexOf("  compatibility:"), ci.indexOf("  policy-and-package:"));
  assert.match(compatibility, /fetch-depth: 0/);
  assert.match(compatibility, /if: matrix.node-version == '22\.14\.0'/);
  assert.ok(compatibility.includes(expectedGateCommands.get("ci.yml")));
});

test("npm package contains only the supported Codex distribution", async (context) => {
  const npmCache = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-codegraph-npm-cache-"));
  context.after(() => fs.rm(npmCache, { recursive: true, force: true }));

  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: new URL("../", import.meta.url).pathname,
    encoding: "utf8",
    env: { ...process.env, NPM_CONFIG_CACHE: npmCache },
  });
  const [pack] = JSON.parse(output);
  const paths = pack.files.map((file) => file.path).sort();
  const runtimeManifest = JSON.parse(await fs.readFile(
    new URL("../governance/adapters/v1/node-dependency-cruiser-runtime-manifest.json", import.meta.url),
    "utf8",
  ));
  const expected = [
    "LICENSE",
    "NOTICE.md",
    "README.md",
    "bin/sdd-codegraph.js",
    "codex/AGENTS.md",
    "codex/agents/architecture-reviewer.toml",
    "codex/agents/documentator.toml",
    "codex/agents/explorer.toml",
    "codex/agents/hacker.toml",
    "codex/agents/implementer.toml",
    "codex/agents/orchestrator.toml",
    "codex/agents/planner.toml",
    "codex/agents/tester-reviewer.toml",
    "codex/pipeline.json",
    "docs/agent-governance-responsibility-map.md",
    "docs/functional-spec.md",
    "docs/issue-13-quality-proof.md",
    "docs/technical-spec.md",
    "governance/README.md",
    "governance/adapters/v1/node-architecture-notice-header.md",
    "governance/checks/v1/registry.json",
    "governance/adapters/v1/node-dependency-cruiser.json",
    "governance/adapters/v1/node-dependency-cruiser-runtime-manifest.json",
    "governance/examples/v1/active-rule-exception.json",
    "governance/examples/v1/approved-architecture-rule.json",
    "governance/examples/v1/architecture-review-result.json",
    "governance/examples/v1/governance-check-result.json",
    "governance/gates/v1/registry.json",
    "governance/profiles/v1/engineering-quality-profile.json",
    "governance/rules/v1/catalog.json",
    "governance/schemas/v1/agent-result.schema.json",
    "governance/schemas/v1/check-registry.schema.json",
    "governance/schemas/v1/common.schema.json",
    "governance/schemas/v1/engineering-gate-config.schema.json",
    "governance/schemas/v1/engineering-gate-registry.schema.json",
    "governance/schemas/v1/engineering-gate-run.schema.json",
    "governance/schemas/v1/engineering-quality-profile.schema.json",
    "governance/schemas/v1/evidence.schema.json",
    "governance/schemas/v1/exception.schema.json",
    "governance/schemas/v1/finding.schema.json",
    "governance/schemas/v1/gate-decision.schema.json",
    "governance/schemas/v1/governance-check-result.schema.json",
    "governance/schemas/v1/rule-catalog.schema.json",
    "governance/schemas/v1/rule.schema.json",
    "package.json",
    "scripts/generate-node-architecture-runtime.js",
    "scripts/verify-node-architecture-runtime.js",
    "scripts/quality-proof.js",
    "setup.sh",
    "src/engineering-gate-runtime.js",
    "src/engineering-gates.js",
    "src/git-change-selector.js",
    "src/coverage-map-worker.js",
    "src/governance-checks.js",
    "src/governance-trust.js",
    "src/governance-validator.d.ts",
    "src/governance-validator.js",
    "src/installer.js",
    "src/node-coverage-adapter.js",
    "src/quality-proof.js",
    "src/node-architecture-adapter.js",
    "src/node-architecture-contract.js",
    "src/node-architecture-runtime-topology.js",
    "src/node-architecture-worker.js",
    "src/node-eslint-policy.js",
    "src/node-lint-complexity-adapter.js",
    "src/node-lint-complexity-worker.js",
    "src/node-test-reporter.js",
    "src/node-test-suite-adapter.js",
    "src/prompt-protection.js",
    ...runtimeManifest.files.map((file) => `vendor/node-architecture-runtime/${file.path}`),
  ].sort();

  assert.deepEqual(paths, expected);
  assert.equal(evaluatePackageSurface(paths).status, "pass");
  assert.deepEqual(evaluatePackageSurface(paths.filter((file) => file !== "src/coverage-map-worker.js")), {
    status: "fail",
    reason_code: "PACKAGE_SURFACE_FAILED",
    summary: "The package dry run is missing 1 required runner asset(s).",
  });
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
  const gateRegistry = JSON.parse(await fs.readFile(
    path.join(project, ".codex", "governance", "gates", "v1", "registry.json"),
    "utf8",
  ));
  const qualityProfile = JSON.parse(await fs.readFile(
    path.join(project, ".codex", "governance", "profiles", "v1", "engineering-quality-profile.json"),
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
  assert.equal(gateRegistry.executors[0].executor_id, "javascript_syntax");
  assert.equal(qualityProfile.metrics.cyclomatic_complexity.maximum, 15);
  assert.match(config, /custom = true/);
  assert.match(config, /^default_permissions = "workspace-only"$/m);
  assert.match(config, /^\[permissions\.workspace-only\]$/m);
  assert.match(config, /^extends = ":workspace"$/m);
  assert.match(config, /^\[permissions\.workspace-only\.filesystem\]$/m);
  assert.match(config, /^":root" = "deny"$/m);
  assert.match(config, /^":minimal" = "read"$/m);
  assert.match(config, /^":tmpdir" = "deny"$/m);
  assert.match(config, /^":slash_tmp" = "deny"$/m);
  assert.match(config, /^\[permissions\.workspace-only\.filesystem\.":workspace_roots"\]$/m);
  assert.match(config, /^"\.codex" = "read"$/m);
  assert.match(config, /^\[permissions\.workspace-only\.network\]$/m);
  assert.match(config, /^enabled = false$/m);
  assert.equal(manifest.package, "@gustavoarielms/sdd-codegraph-cli");
  assert.equal(manifest.version, "0.3.0");
  assert.equal(manifest.permissionsProfile, "workspace-only");
  assert.equal((await checkProjectFiles(project)).drift.length, 0);
});

test("project permission profile accepts built-ins and persists the selection", async (context) => {
  const root = await temporaryProject();
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  for (const [profile, expected] of [
    ["read-only", ":read-only"],
    ["workspace", ":workspace"],
    ["danger-full-access", ":danger-full-access"],
  ]) {
    const project = path.join(root, profile);
    await installProject(project, { permissions: profile });
    await installProject(project);
    const config = await fs.readFile(path.join(project, ".codex", "config.toml"), "utf8");
    const manifest = JSON.parse(await fs.readFile(path.join(project, ".sdd-codegraph.json"), "utf8"));
    assert.match(config, new RegExp(`^default_permissions = "${expected}"$`, "m"));
    assert.equal(manifest.permissionsProfile, profile);
    assert.equal((await checkProjectFiles(project)).drift.length, 0);
  }

  await assert.rejects(
    installProject(path.join(root, "invalid"), { permissions: "unknown" }),
    /Unsupported permissions profile: unknown/,
  );
});

test("project update ignores a manifest-only permission escalation", async (context) => {
  const project = await temporaryProject();
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await installProject(project);

  const manifestPath = path.join(project, ".sdd-codegraph.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.permissionsProfile = "danger-full-access";
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await installProject(project);

  const config = await fs.readFile(path.join(project, ".codex", "config.toml"), "utf8");
  const repairedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.match(config, /^default_permissions = "workspace-only"$/m);
  assert.equal(repairedManifest.permissionsProfile, "workspace-only");
});

test("project update adopts a supported legacy config and rejects unknown profiles", async (context) => {
  const project = await temporaryProject();
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await installProject(project, { permissions: "read-only" });

  const manifestPath = path.join(project, ".sdd-codegraph.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  delete manifest.permissionsProfile;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await installProject(project);

  const configPath = path.join(project, ".codex", "config.toml");
  const config = await fs.readFile(configPath, "utf8");
  const migratedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.match(config, /^default_permissions = ":read-only"$/m);
  assert.equal(migratedManifest.permissionsProfile, "read-only");

  await fs.writeFile(configPath, config.replace('default_permissions = ":read-only"', 'default_permissions = "custom"'));
  await assert.rejects(installProject(project), /Explicitly select one with --permissions/);

  await fs.writeFile(
    configPath,
    config.replace(
      'default_permissions = ":read-only"',
      'default_permissions = ":read-only"\ndefault_permissions = ":workspace"',
    ),
  );
  await assert.rejects(installProject(project), /Unsupported or ambiguous default_permissions/);

  await installProject(project, { permissions: "workspace" });
  assert.match(await fs.readFile(configPath, "utf8"), /^default_permissions = ":workspace"$/m);
});

test("project update preserves permission profiles declared with quoted TOML keys", async (context) => {
  const root = await temporaryProject();
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  for (const [name, quotedKey] of [
    ["basic", '"default_permissions"'],
    ["literal", "'default_permissions'"],
  ]) {
    const project = path.join(root, name);
    await installProject(project, { permissions: "read-only" });

    const configPath = path.join(project, ".codex", "config.toml");
    const config = await fs.readFile(configPath, "utf8");
    await fs.writeFile(configPath, config.replace("default_permissions", quotedKey));

    const manifestPath = path.join(project, ".sdd-codegraph.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    delete manifest.permissionsProfile;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await installProject(project);

    const updatedConfig = await fs.readFile(configPath, "utf8");
    const updatedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert.match(updatedConfig, /^default_permissions = ":read-only"$/m);
    assert.equal(updatedConfig.match(/default_permissions/g)?.length, 1);
    assert.equal(updatedManifest.permissionsProfile, "read-only");
  }
});

test("project update requires explicit permissions when the managed config is missing", async (context) => {
  const project = await temporaryProject();
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await installProject(project, { permissions: "read-only" });

  const configPath = path.join(project, ".codex", "config.toml");
  const manifestPath = path.join(project, ".sdd-codegraph.json");
  const originalManifest = await fs.readFile(manifestPath, "utf8");
  await fs.rm(configPath);

  await assert.rejects(installProject(project), /Explicitly select one with --permissions/);
  await assert.rejects(fs.access(configPath));
  assert.equal(await fs.readFile(manifestPath, "utf8"), originalManifest);

  await installProject(project, { permissions: "read-only" });
  assert.match(await fs.readFile(configPath, "utf8"), /^default_permissions = ":read-only"$/m);
});

test("project update never treats a key under a commented TOML table as global", async (context) => {
  const project = await temporaryProject();
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await installProject(project, { permissions: "read-only" });

  const configPath = path.join(project, ".codex", "config.toml");
  const nestedConfig = [
    'service_tier = "fast"',
    "",
    "[unrelated] # valid TOML comment",
    'default_permissions = ":danger-full-access"',
    "",
  ].join("\n");
  await fs.writeFile(configPath, nestedConfig);
  const manifestPath = path.join(project, ".sdd-codegraph.json");
  const originalManifest = await fs.readFile(manifestPath, "utf8");

  await assert.rejects(installProject(project), /Explicitly select one with --permissions/);
  assert.equal(await fs.readFile(configPath, "utf8"), nestedConfig);
  assert.equal(await fs.readFile(manifestPath, "utf8"), originalManifest);

  await installProject(project, { permissions: "read-only" });
  const restoredConfig = await fs.readFile(configPath, "utf8");
  assert.match(restoredConfig, /^default_permissions = ":read-only"$/m);
  assert.match(restoredConfig, /^\[unrelated\] # valid TOML comment$/m);
});

test("explicit permissions ignore table-like text inside multiline TOML strings", async (context) => {
  const project = await temporaryProject();
  context.after(() => fs.rm(project, { recursive: true, force: true }));

  const configPath = path.join(project, ".codex", "config.toml");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const config = [
    'notes = """',
    "[unrelated] # documentation text",
    '"""',
    'default_permissions = ":danger-full-access"',
    "",
    "[features]",
    "fast_mode = true",
    "",
  ].join("\n");
  await fs.writeFile(configPath, config);

  await installProject(project, { permissions: "read-only" });

  const updatedConfig = await fs.readFile(configPath, "utf8");
  assert.match(updatedConfig, /^default_permissions = ":read-only"$/m);
  assert.doesNotMatch(updatedConfig, /^default_permissions = ":danger-full-access"$/m);
  assert.match(updatedConfig, /^notes = """\n\[unrelated\] # documentation text\n"""$/m);
});

test("CLI selects a permission profile and preserves it on update", async (context) => {
  const root = await temporaryProject();
  const project = path.join(root, "project");
  const fakeBin = path.join(root, "bin");
  const codeGraph = path.join(fakeBin, "codegraph");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(fakeBin);
  await fs.writeFile(
    codeGraph,
    '#!/bin/sh\nif [ "$1" = "status" ]; then printf \'{"initialized":true,"pendingChanges":{}}\\n\'; fi\n',
    { mode: 0o755 },
  );

  const cli = new URL("../bin/sdd-codegraph.js", import.meta.url).pathname;
  const env = { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` };
  const init = spawnSync(process.execPath, [cli, "init", project, "--permissions", "read-only"], {
    encoding: "utf8",
    env,
  });
  assert.equal(init.status, 0, init.stderr);

  const update = spawnSync(process.execPath, [cli, "update", project], { encoding: "utf8", env });
  assert.equal(update.status, 0, update.stderr);
  const config = await fs.readFile(path.join(project, ".codex", "config.toml"), "utf8");
  const manifest = JSON.parse(await fs.readFile(path.join(project, ".sdd-codegraph.json"), "utf8"));
  assert.match(config, /^default_permissions = ":read-only"$/m);
  assert.equal(manifest.permissionsProfile, "read-only");
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
    path.join("schemas", "v1", "engineering-gate-run.schema.json"),
    path.join("rules", "v1", "catalog.json"),
    path.join("checks", "v1", "registry.json"),
    path.join("gates", "v1", "registry.json"),
    path.join("profiles", "v1", "engineering-quality-profile.json"),
  ]) {
    const globalContent = await fs.readFile(path.join(codexHome, "governance", relative), "utf8");
    const projectContent = await fs.readFile(path.join(project, ".codex", "governance", relative), "utf8");
    assert.equal(projectContent, globalContent, relative);
  }

  const globalConfig = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  const projectConfig = await fs.readFile(path.join(project, ".codex", "config.toml"), "utf8");
  assert.doesNotMatch(globalConfig, /default_permissions|permissions\.workspace-only/);
  assert.match(projectConfig, /^default_permissions = "workspace-only"$/m);
});

test("shell setup selects and persists a project permission profile", async (context) => {
  const project = await temporaryProject();
  context.after(() => fs.rm(project, { recursive: true, force: true }));

  execFileSync("bash", [
    new URL("../setup.sh", import.meta.url).pathname,
    "--project",
    project,
    "--permissions",
    "read-only",
  ]);
  execFileSync("bash", [new URL("../setup.sh", import.meta.url).pathname, "--project", project]);

  const config = await fs.readFile(path.join(project, ".codex", "config.toml"), "utf8");
  const manifest = JSON.parse(await fs.readFile(path.join(project, ".sdd-codegraph.json"), "utf8"));
  assert.match(config, /^default_permissions = ":read-only"$/m);
  assert.equal(manifest.permissionsProfile, "read-only");
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

test("prompt protection classification fails closed for drift, legacy, elevation, and incomplete capability evidence", () => {
  const protectedState = {
    configuredProfile: "workspace-only",
    promptDrift: [],
    unsafePaths: [],
    legacySettings: [],
    probe: {
      fileWrites: ["denied", "denied"],
      directoryMutations: ["denied", "denied"],
      complete: true,
    },
  };
  assert.deepEqual(classifyPromptProtection(protectedState), {
    state: "unproven",
    trusted: false,
    reason_code: "MANAGED_PROMPT_RUNTIME_UNPROVEN",
  });
  for (const [change, state, reasonCode] of [
    [{ promptDrift: [".codex/agents/implementer.toml"] }, "drifted", "MANAGED_PROMPT_DRIFT"],
    [{ unsafePaths: [".codex/agents/implementer.toml"] }, "unsafe", "MANAGED_PROMPT_UNSAFE_PATH"],
    [{ legacySettings: ["sandbox_mode"] }, "legacy", "MANAGED_PROMPT_LEGACY_RUNTIME"],
    [{ configuredProfile: "danger-full-access" }, "elevated", "MANAGED_PROMPT_ELEVATED_PROFILE"],
    [{ probe: { fileWrites: ["denied", "writable"], directoryMutations: ["denied"], complete: true } }, "elevated", "MANAGED_PROMPT_BOUNDARY_WRITABLE"],
    [{ probe: { fileWrites: ["denied", "unknown"], directoryMutations: ["denied"], complete: true } }, "unproven", "MANAGED_PROMPT_RUNTIME_UNPROVEN"],
    [{ probe: { fileWrites: [], directoryMutations: ["denied"], complete: false } }, "unproven", "MANAGED_PROMPT_RUNTIME_UNPROVEN"],
    [{ probe: { fileWrites: ["denied"], directoryMutations: [], complete: false } }, "unproven", "MANAGED_PROMPT_RUNTIME_UNPROVEN"],
  ]) {
    assert.deepEqual(classifyPromptProtection({ ...protectedState, ...change }), {
      state,
      trusted: false,
      reason_code: reasonCode,
    });
  }
});

test("prompt boundary probe distinguishes denied access from writable and ambiguous paths", async () => {
  const denied = Object.assign(new Error("denied"), { code: "EPERM" });
  const unknown = Object.assign(new Error("unknown"), { code: "EIO" });
  const dependencies = (openError, accessError) => ({
    open: async () => {
      if (openError) throw openError;
      return { close: async () => {} };
    },
    access: async () => {
      if (accessError) throw accessError;
    },
  });

  const directories = ["/root/.codex", "/root/.codex/agents"];
  const prompts = ["/root/.codex/agents/a.toml", "/root/.codex/agents/b.toml"];
  assert.deepEqual(await probeManagedPromptBoundary(directories, prompts, {
    fs: dependencies(denied, denied),
  }), { fileWrites: ["denied", "denied"], directoryMutations: ["denied", "denied"] });
  assert.deepEqual(await probeManagedPromptBoundary(directories, prompts, {
    fs: dependencies(),
  }), { fileWrites: ["writable", "writable"], directoryMutations: ["writable", "writable"] });
  assert.deepEqual(await probeManagedPromptBoundary(directories, prompts, {
    fs: dependencies(unknown, unknown),
  }), { fileWrites: ["unknown", "unknown"], directoryMutations: ["unknown", "unknown"] });
});

test("project installation records prompt digests but local capability denial remains unproven", async (context) => {
  const root = await temporaryProject();
  const project = path.join(root, "project");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await installProject(project);

  const baseline = JSON.parse(await fs.readFile(
    path.join(project, ".codex", "managed-prompts.json"),
    "utf8",
  ));
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.prompts.length, 8);
  assert.ok(baseline.prompts.every((prompt) => /^agents\/.+\.toml$/.test(prompt.path)));
  assert.ok(baseline.prompts.every((prompt) => /^sha256:[a-f0-9]{64}$/.test(prompt.sha256)));

  const protectedResult = await checkProjectFiles(project, {
    environment: { CODEX_PERMISSION_PROFILE: ":danger-full-access", CODEX_SANDBOX: "forged" },
    probe: deniedPromptBoundary,
  });
  assert.equal(protectedResult.protection.state, "unproven");
  assert.equal(protectedResult.protection.trusted, false);
  assert.equal("runtime_profile" in protectedResult.protection, false);

  const unrestricted = await checkProjectFiles(project, {
    probe: async (directoryPaths, promptPaths) => ({
      fileWrites: promptPaths.map(() => "writable"),
      directoryMutations: directoryPaths.map(() => "writable"),
    }),
  });
  assert.equal(unrestricted.protection.state, "elevated");
  assert.equal(unrestricted.protection.trusted, false);

  const prompt = path.join(project, ".codex", "agents", "implementer.toml");
  const alias = path.join(project, "implementer-alias.toml");
  await fs.link(prompt, alias);
  const unsafe = await checkProjectFiles(project, {
    probe: deniedPromptBoundary,
  });
  assert.equal(unsafe.protection.state, "unsafe");
  assert.equal(unsafe.protection.reason_code, "MANAGED_PROMPT_UNSAFE_PATH");
});

test("project protection probes every managed prompt and rejects one writable peer", async (context) => {
  const project = await temporaryProject();
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await installProject(project);

  let probedPrompts = [];
  const result = await checkProjectFiles(project, {
    probe: async (directoryPaths, promptPaths) => {
      probedPrompts = promptPaths;
      return {
        fileWrites: promptPaths.map((promptPath) => (
          promptPath.endsWith(`${path.sep}implementer.toml`) ? "writable" : "denied"
        )),
        directoryMutations: directoryPaths.map(() => "denied"),
      };
    },
  });

  assert.equal(probedPrompts.length, 9);
  assert.ok(probedPrompts.some((promptPath) => promptPath.endsWith(`${path.sep}implementer.toml`)));
  assert.ok(probedPrompts.some((promptPath) => promptPath.endsWith(`${path.sep}managed-prompts.json`)));
  assert.equal(result.protection.state, "elevated");
  assert.equal(result.protection.reason_code, "MANAGED_PROMPT_BOUNDARY_WRITABLE");
});

test("DAC mode changes cannot manufacture trusted managed prompt protection", async (context) => {
  const project = await temporaryProject();
  const codexRoot = path.join(project, ".codex");
  const agentsRoot = path.join(codexRoot, "agents");
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await installProject(project);
  const promptPaths = (await fs.readdir(agentsRoot)).map((name) => path.join(agentsRoot, name));
  const protectedFiles = [...promptPaths, path.join(codexRoot, "managed-prompts.json")];

  for (const filePath of protectedFiles) await fs.chmod(filePath, 0o444);
  await fs.chmod(agentsRoot, 0o555);
  await fs.chmod(codexRoot, 0o555);
  try {
    const checked = await checkProjectFiles(project);
    assert.equal(checked.protection.state, "unproven");
    assert.equal(checked.protection.trusted, false);
    assert.equal(checked.protection.reason_code, "MANAGED_PROMPT_RUNTIME_UNPROVEN");
  } finally {
    await fs.chmod(codexRoot, 0o755);
    await fs.chmod(agentsRoot, 0o755);
    for (const filePath of protectedFiles) await fs.chmod(filePath, 0o644);
  }

  const implementer = path.join(agentsRoot, "implementer.toml");
  await fs.appendFile(implementer, "\n# writable after attacker-controlled DAC restoration\n");
  assert.match(await fs.readFile(implementer, "utf8"), /attacker-controlled DAC restoration/);
});

test("project check fails closed when the managed prompt inventory is not exact", async (context) => {
  const root = await temporaryProject();
  const project = path.join(root, "project");
  const agentsRoot = path.join(project, ".codex", "agents");
  const runtime = {
    probe: deniedPromptBoundary,
  };
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await installProject(project);

  const extraRelativePath = path.join(".codex", "agents", "extra.toml");
  const extraPrompt = path.join(project, extraRelativePath);
  await fs.writeFile(extraPrompt, 'name = "extra"\n', "utf8");
  const added = await checkProjectFiles(project, runtime);
  assert.ok(added.drift.includes(extraRelativePath));
  assert.equal(added.protection.state, "drifted");
  assert.equal(added.protection.reason_code, "MANAGED_PROMPT_DRIFT");
  assert.equal(added.protection.managed_prompt_count, 9);

  const execution = spawnSync(process.execPath, [
    new URL("../bin/sdd-codegraph.js", import.meta.url).pathname,
    "check",
    project,
  ], {
    encoding: "utf8",
    env: { ...process.env, ...runtime.environment },
  });
  assert.equal(execution.status, 2);
  assert.match(execution.stderr, /MANAGED_PROMPT_DRIFT/);

  await fs.rm(extraPrompt);
  await fs.symlink(path.join(agentsRoot, "implementer.toml"), extraPrompt);
  const linked = await checkProjectFiles(project, runtime);
  assert.equal(linked.protection.state, "unsafe");
  assert.equal(linked.protection.reason_code, "MANAGED_PROMPT_UNSAFE_PATH");

  await fs.rm(extraPrompt);
  const implementerRelativePath = path.join(".codex", "agents", "implementer.toml");
  const renamedRelativePath = path.join(".codex", "agents", "renamed.toml");
  await fs.rename(
    path.join(project, implementerRelativePath),
    path.join(project, renamedRelativePath),
  );
  const renamed = await checkProjectFiles(project, runtime);
  assert.ok(renamed.drift.includes(implementerRelativePath));
  assert.ok(renamed.drift.includes(renamedRelativePath));
  assert.equal(renamed.protection.state, "drifted");
});

test("project check classifies legacy configuration and the CLI exits blocked", async (context) => {
  const root = await temporaryProject();
  const project = path.join(root, "project");
  const fakeBin = path.join(root, "bin");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await installProject(project);
  const configPath = path.join(project, ".codex", "config.toml");
  const config = await fs.readFile(configPath, "utf8");
  await fs.writeFile(
    configPath,
    config.replace('default_permissions = "workspace-only"', 'sandbox_mode = "workspace-write"'),
  );

  const checked = await checkProjectFiles(project, {
    probe: deniedPromptBoundary,
  });
  assert.equal(checked.protection.state, "legacy");
  assert.equal(checked.protection.reason_code, "MANAGED_PROMPT_LEGACY_RUNTIME");

  await fs.mkdir(fakeBin);
  await fs.writeFile(
    path.join(fakeBin, "codegraph"),
    '#!/bin/sh\nprintf \'{"initialized":true,"pendingChanges":{}}\\n\'\n',
    { mode: 0o755 },
  );
  const execution = spawnSync(process.execPath, [
    new URL("../bin/sdd-codegraph.js", import.meta.url).pathname,
    "check",
    project,
  ], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  assert.equal(execution.status, 2);
  assert.match(execution.stderr, /MANAGED_PROMPT_LEGACY_RUNTIME/);
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
