import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const packagePath = path.join("@gustavoarielms", "sdd-codegraph-cli");
const adapterPath = path.join("src", "node-lint-complexity-adapter.js");
const limits = Object.freeze({ timeoutMs: 60000, maxOutputBytes: 262144 });

async function temporaryDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function runNpm(cwd, cache, args) {
  const result = spawnSync("npm", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NPM_CONFIG_CACHE: cache },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function targetRepository(t) {
  const target = await temporaryDirectory(t, "adapter-distribution-target-");
  await fs.mkdir(path.join(target, "src"));
  await fs.writeFile(path.join(target, "src", "clean.js"), "export function clean(value) { return value ?? 0; }\n");
  for (const args of [["init"], ["add", "--", "src/clean.js"]]) {
    const result = spawnSync("git", ["-C", target, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return target;
}

async function assertAdapterPasses(modulePath, target) {
  const module = await import(pathToFileURL(modulePath));
  const result = await module.runNodeLintComplexity({ target, limits });
  assert.equal(result.status, "pass");
  assert.match(result.summary, /ESLint 10\.8\.1 analyzed 1 tracked JavaScript file\(s\)/);
}

test("source, project-local, global, and packed consumers use the package-owned adapter", async (t) => {
  const target = await targetRepository(t);
  const cache = await temporaryDirectory(t, "adapter-distribution-cache-");
  await assertAdapterPasses(path.join(repositoryRoot, adapterPath), target);

  const localConsumer = await temporaryDirectory(t, "adapter-local-consumer-");
  runNpm(localConsumer, cache, ["install", "--ignore-scripts", "--no-package-lock", repositoryRoot]);
  await assertAdapterPasses(path.join(localConsumer, "node_modules", packagePath, adapterPath), target);

  const globalPrefix = await temporaryDirectory(t, "adapter-global-prefix-");
  runNpm(globalPrefix, cache, ["install", "--global", "--prefix", globalPrefix, "--ignore-scripts", repositoryRoot]);
  await assertAdapterPasses(path.join(globalPrefix, "lib", "node_modules", packagePath, adapterPath), target);

  const packedDirectory = await temporaryDirectory(t, "adapter-packed-artifact-");
  const pack = JSON.parse(runNpm(packedDirectory, cache, ["pack", repositoryRoot, "--json", "--ignore-scripts"]));
  const packedConsumer = await temporaryDirectory(t, "adapter-packed-consumer-");
  runNpm(packedConsumer, cache, [
    "install",
    "--ignore-scripts",
    "--no-package-lock",
    path.join(packedDirectory, pack[0].filename),
  ]);
  await assertAdapterPasses(path.join(packedConsumer, "node_modules", packagePath, adapterPath), target);
});
