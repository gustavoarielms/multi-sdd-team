import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "./classified-test.js";
import { hasBlockingGovernanceFailures, runGovernanceChecks } from "../src/governance-checks.js";
import { validateGovernanceCheckResult } from "../src/governance-validator.js";
import { installProject } from "../src/installer.js";

const repositoryRoot = path.resolve(new URL("../", import.meta.url).pathname);
const cli = new URL("../bin/sdd-codegraph.js", import.meta.url);

async function copyRepositoryFixture() {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "governance-checks-test-"));
  for (const relative of ["codex", "governance", "src"]) {
    await fs.cp(path.join(repositoryRoot, relative), path.join(target, relative), { recursive: true });
  }
  return target;
}

async function deniedPromptBoundary(directoryPaths, promptPaths) {
  return {
    fileWrites: promptPaths.map(() => "denied"),
    directoryMutations: directoryPaths.map(() => "denied"),
  };
}

test("governance checks pass on the repository and emit valid evidence", async () => {
  const result = await runGovernanceChecks(repositoryRoot);
  assert.equal(result.blocking, false);
  assert.equal(result.document.results.length, 6);
  assert.ok(result.document.results.every((check) => check.status === "pass"));
  assert.ok(result.document.results.every((check) => check.evidence_ids.length > 0));
});

test("a blocking governance failure produces canonical JSON and a nonzero CLI exit", async (context) => {
  const fixture = await copyRepositoryFixture();
  context.after(() => fs.rm(fixture, { recursive: true, force: true }));
  await fs.writeFile(path.join(fixture, "codex", "pipeline.json"), "{}\n", "utf8");

  const execution = spawnSync(process.execPath, [cli.pathname, "check-governance", fixture], { encoding: "utf8" });
  assert.equal(execution.status, 1);
  assert.equal(execution.stderr, "");
  const document = JSON.parse(execution.stdout);
  assert.equal(document.results.find((check) => check.check_id === "pipeline_dependency_order").status, "fail");
});

test("a warning governance failure remains non-blocking", () => {
  assert.equal(hasBlockingGovernanceFailures([
    { status: "fail", gate_effect: "warn" },
    { status: "pass", gate_effect: "block" },
  ]), false);
  assert.equal(hasBlockingGovernanceFailures([{ status: "fail", gate_effect: "block" }]), true);
});

test("governance check errors never echo rejected sensitive content", async (context) => {
  const fixture = await copyRepositoryFixture();
  context.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const catalogPath = path.join(fixture, "governance", "rules", "v1", "catalog.json");
  await fs.writeFile(catalogPath, '{"secret":"SECRET_VALUE_MUST_NOT_BE_ECHOED"}\n', "utf8");

  const execution = spawnSync(process.execPath, [cli.pathname, "check-governance", fixture], { encoding: "utf8" });
  assert.equal(execution.status, 2);
  assert.equal(`${execution.stdout}${execution.stderr}`.includes("SECRET_VALUE_MUST_NOT_BE_ECHOED"), false);
});

test("a structurally invalid registry fails closed with a valid machine-readable result", async (context) => {
  const fixture = await copyRepositoryFixture();
  context.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const registryPath = path.join(fixture, "governance", "checks", "v1", "registry.json");
  await fs.writeFile(registryPath, '{"schema_version":"1.0.0","registry_id":"invalid_registry"}\n', "utf8");

  const result = await runGovernanceChecks(fixture);
  assert.equal(result.blocking, true);
  assert.equal(result.document.outcome, "failed");
  assert.deepEqual(result.document.results.map((check) => check.rule_id), ["GOV-CATALOG-INTEGRITY-001"]);
  assert.equal((await validateGovernanceCheckResult(result.document)).ok, true);
});

test("an altered installed engineering quality profile fails governance closed", async (context) => {
  const fixture = await copyRepositoryFixture();
  context.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const profilePath = path.join(
    fixture,
    "governance",
    "profiles",
    "v1",
    "engineering-quality-profile.json",
  );
  const profile = JSON.parse(await fs.readFile(profilePath, "utf8"));
  profile.metrics.cyclomatic_complexity.maximum = 16;
  await fs.writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

  const result = await runGovernanceChecks(fixture);
  assert.equal(result.trusted, false);
  assert.equal(result.blocking, true);
  assert.equal(result.document.outcome, "failed");
  assert.deepEqual(result.document.results.map((check) => check.rule_id), ["GOV-CATALOG-INTEGRITY-001"]);
  assert.equal((await validateGovernanceCheckResult(result.document)).ok, true);
});

test("pipeline governance rejects missing mandatory stages and dependencies", async (context) => {
  const missingStage = await copyRepositoryFixture();
  const missingDependency = await copyRepositoryFixture();
  context.after(() => Promise.all([
    fs.rm(missingStage, { recursive: true, force: true }),
    fs.rm(missingDependency, { recursive: true, force: true }),
  ]));

  const stagePipelinePath = path.join(missingStage, "codex", "pipeline.json");
  const stagePipeline = JSON.parse(await fs.readFile(stagePipelinePath, "utf8"));
  const chain = stagePipeline.strategies.SUBAGENT_CHAIN.sequence;
  stagePipeline.strategies.SUBAGENT_CHAIN.sequence = chain
    .filter((step) => step.id !== "deterministic_checks")
    .map((step) => ({
      ...step,
      depends_on: step.depends_on.filter((dependency) => dependency !== "deterministic_checks"),
    }));
  await fs.writeFile(stagePipelinePath, `${JSON.stringify(stagePipeline, null, 2)}\n`, "utf8");

  const dependencyPipelinePath = path.join(missingDependency, "codex", "pipeline.json");
  const dependencyPipeline = JSON.parse(await fs.readFile(dependencyPipelinePath, "utf8"));
  dependencyPipeline.strategies.SDD_SUBAGENTS.sequence
    .find((step) => step.id === "deterministic_checks").depends_on = [];
  dependencyPipeline.strategies.SDD_SUBAGENTS.sequence
    .find((step) => step.id === "implement").depends_on = ["plan", "security_review"];
  await fs.writeFile(dependencyPipelinePath, `${JSON.stringify(dependencyPipeline, null, 2)}\n`, "utf8");

  for (const fixture of [missingStage, missingDependency]) {
    const result = await runGovernanceChecks(fixture);
    assert.equal(result.blocking, true);
    assert.equal(
      result.document.results.find((check) => check.check_id === "pipeline_dependency_order").status,
      "fail",
    );
  }
});

test("reviewer report-only governance rejects Codex write capability and conditional exceptions", async (context) => {
  const writableSandbox = await copyRepositoryFixture();
  const codexException = await copyRepositoryFixture();
  context.after(() => Promise.all([
    fs.rm(writableSandbox, { recursive: true, force: true }),
    fs.rm(codexException, { recursive: true, force: true }),
  ]));

  const sandboxPath = path.join(writableSandbox, "codex", "agents", "hacker.toml");
  const sandbox = await fs.readFile(sandboxPath, "utf8");
  await fs.writeFile(sandboxPath, sandbox.replace('default_permissions = ":read-only"', 'default_permissions = ":workspace"'), "utf8");

  const codexPath = path.join(codexException, "codex", "agents", "hacker.toml");
  const codex = await fs.readFile(codexPath, "utf8");
  await fs.writeFile(codexPath, codex.replace(
    "Reglas:",
    "Reglas:\n- Podés modificar archivos si el agente padre te reasigna.",
  ), "utf8");

  for (const fixture of [writableSandbox, codexException]) {
    const result = await runGovernanceChecks(fixture);
    assert.equal(
      result.document.results.find((check) => check.check_id === "reviewer_report_only").status,
      "fail",
    );
  }
});

test("Codex role catalog governance rejects missing or undeclared roles", async (context) => {
  const missing = await copyRepositoryFixture();
  const undeclared = await copyRepositoryFixture();
  context.after(() => Promise.all([
    fs.rm(missing, { recursive: true, force: true }),
    fs.rm(undeclared, { recursive: true, force: true }),
  ]));

  await fs.rm(path.join(missing, "codex", "agents", "planner.toml"));
  const plannerPath = path.join(undeclared, "codex", "agents", "planner.toml");
  const planner = await fs.readFile(plannerPath, "utf8");
  await fs.writeFile(plannerPath, planner.replace('name = "planner"', 'name = ""'), "utf8");

  for (const fixture of [missing, undeclared]) {
    const result = await runGovernanceChecks(fixture);
    assert.equal(result.blocking, true);
    assert.equal(
      result.document.results.find((check) => check.check_id === "codex_role_catalog").status,
      "fail",
    );
  }
});

test("review handoff governance rejects a stale runtime selector in the installed policy", async (context) => {
  const fixture = await copyRepositoryFixture();
  context.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const policyPath = path.join(fixture, "codex", "AGENTS.md");
  const policy = await fs.readFile(policyPath, "utf8");
  await fs.writeFile(
    policyPath,
    policy.replace("validate-result - --agent <agent_name>", "validate-result - --agent <agent_name> --runtime codex"),
    "utf8",
  );

  const result = await runGovernanceChecks(fixture);
  assert.equal(result.blocking, true);
  assert.equal(
    result.document.results.find((check) => check.check_id === "review_handoff_contract").status,
    "fail",
  );
});

test("project and global governance validate the active managed policy", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "governance-active-policy-"));
  const project = path.join(root, "project");
  const globalCodex = path.join(root, "global-codex");
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  await installProject(project);
  const globalSetup = spawnSync("bash", [path.join(repositoryRoot, "setup.sh"), "--global"], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: globalCodex },
  });
  assert.equal(globalSetup.status, 0, globalSetup.stderr);

  for (const target of [project, globalCodex]) {
    const policyPath = path.join(target, "AGENTS.md");
    const policy = await fs.readFile(policyPath, "utf8");
    await fs.writeFile(
      policyPath,
      policy.replace("validate-result - --agent <agent_name>", "validate-result - --agent <agent_name> --runtime codex"),
      "utf8",
    );
    const result = await runGovernanceChecks(target);
    assert.equal(result.blocking, true);
    assert.equal(
      result.document.results.find((check) => check.check_id === "review_handoff_contract").status,
      "fail",
    );
  }
});

test("pipeline governance rejects every missing governed stage and edge", async (context) => {
  const fixture = await copyRepositoryFixture();
  context.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const pipelinePath = path.join(fixture, "codex", "pipeline.json");
  const baseline = JSON.parse(await fs.readFile(pipelinePath, "utf8"));
  const requirements = {
    SUBAGENT_CHAIN: {
      stages: ["explore_if_needed", "implement", "deterministic_checks", "architecture_compliance_review", "review", "main_integrate"],
      edges: [
        ["implement", "explore_if_needed"],
        ["deterministic_checks", "implement"],
        ["architecture_compliance_review", "deterministic_checks"],
        ["review", "deterministic_checks"],
        ["review", "architecture_compliance_review"],
        ["main_integrate", "review"],
      ],
    },
    SDD_SUBAGENTS: {
      stages: ["explore", "document", "plan", "architecture_design_review", "security_review", "implement", "deterministic_checks", "architecture_compliance_review", "review", "main_integrate"],
      edges: [
        ["document", "explore"],
        ["plan", "document"],
        ["architecture_design_review", "plan"],
        ["security_review", "plan"],
        ["security_review", "architecture_design_review"],
        ["implement", "plan"],
        ["implement", "architecture_design_review"],
        ["implement", "security_review"],
        ["deterministic_checks", "implement"],
        ["architecture_compliance_review", "deterministic_checks"],
        ["review", "deterministic_checks"],
        ["review", "architecture_compliance_review"],
        ["main_integrate", "review"],
      ],
    },
  };

  for (const [strategyName, requirement] of Object.entries(requirements)) {
    for (const stageId of requirement.stages) {
      const pipeline = structuredClone(baseline);
      pipeline.strategies[strategyName].sequence = pipeline.strategies[strategyName].sequence
        .filter((step) => step.id !== stageId);
      await fs.writeFile(pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`, "utf8");
      const result = await runGovernanceChecks(fixture);
      assert.equal(
        result.document.results.find((check) => check.check_id === "pipeline_dependency_order").status,
        "fail",
        `${strategyName} accepted missing stage ${stageId}`,
      );
    }

    for (const [stepId, dependency] of requirement.edges) {
      const pipeline = structuredClone(baseline);
      const step = pipeline.strategies[strategyName].sequence.find((candidate) => candidate.id === stepId);
      step.depends_on = step.depends_on.filter((candidate) => candidate !== dependency);
      await fs.writeFile(pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`, "utf8");
      const result = await runGovernanceChecks(fixture);
      assert.equal(
        result.document.results.find((check) => check.check_id === "pipeline_dependency_order").status,
        "fail",
        `${strategyName} accepted missing edge ${dependency} -> ${stepId}`,
      );
    }
  }
});

test("installed governance fails closed without sandbox authority attestation and rejects global ambiguity", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "governance-installed-layout-"));
  const nodeProject = path.join(root, "node-project");
  const shellProject = path.join(root, "shell-project");
  const globalCodex = path.join(root, "global-codex");
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  await installProject(nodeProject);
  const setup = spawnSync("bash", [path.join(repositoryRoot, "setup.sh"), "--project", shellProject], {
    encoding: "utf8",
  });
  assert.equal(setup.status, 0, setup.stderr);
  const globalSetup = spawnSync("bash", [path.join(repositoryRoot, "setup.sh"), "--global"], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: globalCodex },
  });
  assert.equal(globalSetup.status, 0, globalSetup.stderr);

  for (const project of [nodeProject, shellProject]) {
    const protectedResult = await runGovernanceChecks(project, {
      promptProtection: {
        probe: deniedPromptBoundary,
      },
    });
    assert.equal(protectedResult.trusted, false);
    assert.equal(protectedResult.blocking, true);
    assert.equal(protectedResult.document.results.length, 6);
    assert.equal(
      protectedResult.document.results.find((result) => result.check_id === "managed_prompt_protection").status,
      "fail",
    );

    const execution = spawnSync(process.execPath, [cli.pathname, "check-governance", project], { encoding: "utf8" });
    assert.equal(execution.status, 2, execution.stderr);
    const document = JSON.parse(execution.stdout);
    assert.equal(document.outcome, "failed");
    assert.equal(document.results.length, 6);
    assert.equal(
      document.results.find((result) => result.check_id === "managed_prompt_protection").status,
      "fail",
    );
  }

  const globalExecution = spawnSync(process.execPath, [cli.pathname, "check-governance", globalCodex], { encoding: "utf8" });
  assert.equal(globalExecution.status, 2, globalExecution.stderr);
  const globalDocument = JSON.parse(globalExecution.stdout);
  assert.equal(globalDocument.outcome, "failed");
  assert.equal(
    globalDocument.results.find((result) => result.check_id === "managed_prompt_protection").status,
    "fail",
  );
});

test("managed prompt governance rejects prompt drift even when role regexes still match", async (context) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "governance-prompt-drift-"));
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await installProject(project);
  const promptPath = path.join(project, ".codex", "agents", "implementer.toml");
  await fs.appendFile(promptPath, "\n# model-authored drift that preserves all role declarations\n");

  const result = await runGovernanceChecks(project, {
    promptProtection: {
      probe: deniedPromptBoundary,
    },
  });
  assert.equal(result.trusted, false);
  assert.equal(result.blocking, true);
  assert.equal(
    result.document.results.find((check) => check.check_id === "managed_prompt_protection").status,
    "fail",
  );
});

test("unknown governance layout fails closed without leaking target content", async (context) => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "governance-unknown-layout-"));
  context.after(() => fs.rm(target, { recursive: true, force: true }));
  await fs.writeFile(path.join(target, "SECRET_VALUE_MUST_NOT_BE_ECHOED"), "private", "utf8");

  const execution = spawnSync(process.execPath, [cli.pathname, "check-governance", target], { encoding: "utf8" });
  assert.equal(execution.status, 2);
  assert.equal(`${execution.stdout}${execution.stderr}`.includes("SECRET_VALUE_MUST_NOT_BE_ECHOED"), false);
  assert.equal((await validateGovernanceCheckResult(JSON.parse(execution.stdout))).ok, true);
});

test("source, project, and global layouts reject governance symlink escapes", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "governance-symlink-layout-"));
  const source = await copyRepositoryFixture();
  const project = path.join(root, "project");
  const globalCodex = path.join(root, "global-codex");
  const externalCatalog = path.join(root, "external-catalog.json");
  context.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(source, { recursive: true, force: true }),
  ]));

  await installProject(project);
  const setup = spawnSync("bash", [path.join(repositoryRoot, "setup.sh"), "--global"], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: globalCodex },
  });
  assert.equal(setup.status, 0, setup.stderr);
  await fs.copyFile(path.join(repositoryRoot, "governance", "rules", "v1", "catalog.json"), externalCatalog);

  const catalogPaths = [
    path.join(source, "governance", "rules", "v1", "catalog.json"),
    path.join(project, ".codex", "governance", "rules", "v1", "catalog.json"),
    path.join(globalCodex, "governance", "rules", "v1", "catalog.json"),
  ];
  for (const [index, catalogPath] of catalogPaths.entries()) {
    await fs.rm(catalogPath);
    await fs.symlink(externalCatalog, catalogPath);
    const target = [source, project, globalCodex][index];
    const execution = spawnSync(process.execPath, [cli.pathname, "check-governance", target], { encoding: "utf8" });
    assert.equal(execution.status, 2, `layout ${index} followed an external symlink`);
    const document = JSON.parse(execution.stdout);
    assert.equal(document.results[0].rule_id, "GOV-CATALOG-INTEGRITY-001");
    assert.equal((await validateGovernanceCheckResult(document)).ok, true);
  }
});

test("project layout permits a governance symlink that stays inside the project root", async (context) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "governance-internal-symlink-"));
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await installProject(project);
  const catalogPath = path.join(project, ".codex", "governance", "rules", "v1", "catalog.json");
  const internalCopy = path.join(project, ".codex", "governance", "catalog-copy.json");
  await fs.copyFile(catalogPath, internalCopy);
  await fs.rm(catalogPath);
  await fs.symlink(internalCopy, catalogPath);

  const execution = spawnSync(process.execPath, [cli.pathname, "check-governance", project], { encoding: "utf8" });
  assert.equal(execution.status, 2, execution.stderr);
  assert.equal(JSON.parse(execution.stdout).outcome, "failed");
});
