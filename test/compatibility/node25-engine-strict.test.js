import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Deliberately separate from the supported-runtime suites; never downloads a runtime.
// Run with Node 25.0.0 and SDD_NPM_CLI pointing to npm-cli.js.
test("Node 25.0.0 engine-strict installation rejects the actual package tarball", async (t) => {
  assert.equal(process.version, "v25.0.0", "the compatibility assertion requires the exact unsupported runtime");
  const npmCli = process.env.SDD_NPM_CLI;
  assert.equal(typeof npmCli, "string", "SDD_NPM_CLI must name the npm CLI to run under Node 25.0.0");
  assert.equal(path.isAbsolute(npmCli), true);
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-node25-engine-strict-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const consumer = path.join(temporary, "consumer");
  await fs.mkdir(consumer);
  const runNpm = (args, cwd) => spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  const npmVersion = runNpm(["--version"], consumer);
  assert.equal(npmVersion.status, 0, npmVersion.stderr);
  const packed = runNpm(["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", temporary], repositoryRoot);
  assert.equal(packed.status, 0, packed.stderr);
  const [artifact] = JSON.parse(packed.stdout);
  const tarball = path.join(temporary, artifact.filename);
  const consumerManifest = { name: "engine-rejection-fixture", version: "1.0.0", private: true, dependencies: { [artifact.name]: `file:${tarball}` } };
  const lock = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"));
  const packageEntry = { ...lock.packages[""], resolved: `file:${tarball}`, integrity: artifact.integrity };
  delete lock.packages[""];
  // Keep the package first so another unsupported dependency cannot mask its own engine rejection.
  lock.packages = { "": consumerManifest, [`node_modules/${artifact.name}`]: packageEntry, ...lock.packages };
  lock.name = consumerManifest.name;
  lock.version = consumerManifest.version;
  await fs.writeFile(path.join(consumer, "package.json"), JSON.stringify(consumerManifest));
  await fs.writeFile(path.join(consumer, "package-lock.json"), JSON.stringify(lock));
  const arguments_ = ["ci", "--engine-strict", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--json"];
  const installed = runNpm(arguments_, consumer);
  assert.equal(installed.error, undefined);
  assert.equal(installed.signal, null);
  assert.equal(installed.status, 1, installed.stderr);
  const rejected = JSON.parse(installed.stdout);
  assert.equal(rejected.error.code, "EBADENGINE", JSON.stringify(rejected.error));
  assert.match(rejected.error.summary, /@gustavoarielms\/sdd-codegraph-cli@0\.3\.0/u);
  assert.match(rejected.error.detail, /"node":"v25\.0\.0"/u);
  t.diagnostic(JSON.stringify({ node: process.version, npm: npmVersion.stdout.trim(), tarball, integrity: artifact.integrity, command: [process.execPath, npmCli, ...arguments_], exit: installed.status, rejection: rejected.error }));
});
