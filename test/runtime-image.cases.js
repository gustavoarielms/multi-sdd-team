import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

import test from "./classified-test.js";
import {
  APPROVED_RUNTIME_IMAGE_INPUTS,
  RUNTIME_IMAGE_MANIFEST_SCHEMA,
  RUNTIME_STARTUP_ATTESTATION_SCHEMA,
  approvedImageFromManifest,
  formatRuntimeStartupAttestation,
  loadRuntimeImageManifest,
  parseRuntimeStartupAttestation,
  validateRuntimeImageEvidence,
  validateRuntimeImageManifest,
} from "../src/runtime-image-manifest.js";

const DIGESTS = Object.freeze({
  imageIndex: `sha256:${"1".repeat(64)}`,
  imagePlatform: `sha256:${"2".repeat(64)}`,
  imageConfig: `sha256:${"3".repeat(64)}`,
  entrypoint: `sha256:${"4".repeat(64)}`,
  codexBinary: `sha256:${"5".repeat(64)}`,
  rootfs: `sha256:${"6".repeat(64)}`,
  prompt: `sha256:${"7".repeat(64)}`,
});

function candidateManifest() {
  return {
    schemaVersion: "1.0.0",
    contractVersion: "1",
    platform: { os: "linux", architecture: "arm64" },
    image: {
      repository: "ghcr.io/gustavoarielms/multi-sdd-team-codex-app-server",
      reference: `ghcr.io/gustavoarielms/multi-sdd-team-codex-app-server@${DIGESTS.imagePlatform}`,
      indexDigest: DIGESTS.imageIndex,
      platformDigest: DIGESTS.imagePlatform,
      configDigest: DIGESTS.imageConfig,
    },
    base: {
      distribution: "debian",
      version: "13.6",
      reference: "debian@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132",
      indexDigest: "sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132",
      platformDigest: "sha256:7215f78f35ffe58fe13f244fac9c4f21326d55187271fbb3e1a8aa5cc7e387ab",
      configDigest: "sha256:7e3898f7b011a107d0ef7393d5f604a6e0c0ff05ac4f2476630a8af21059ec9b",
    },
    entrypoint: {
      path: "/usr/local/libexec/sdd-codegraph/runtime-entrypoint",
      sha256: DIGESTS.entrypoint,
    },
    codex: {
      version: "0.154.0",
      source: "https://github.com/openai/codex/releases/download/rust-v0.154.0/codex-app-server-package-aarch64-unknown-linux-musl.tar.gz",
      archiveSha256: "sha256:295bb1b94a8b964b2d2461db9736b9907a9e4daa6ceb8e9bbb820b304fa897ed",
      binaryPath: "/opt/openai/codex-app-server/bin/codex-app-server",
      binarySha256: DIGESTS.codexBinary,
    },
    identity: { uid: 10001, gid: 10001 },
    rootfsInventorySha256: DIGESTS.rootfs,
  };
}

function startupAttestation() {
  return {
    codexArtifactSha256: DIGESTS.codexBinary,
    codexVersion: "0.154.0",
    contractVersion: "1",
    platform: "linux/arm64",
    promptSnapshotSha256: DIGESTS.prompt,
    schemaVersion: "1.0.0",
  };
}

function runtimeEvidence() {
  return {
    authFiles: [],
    capabilities: [],
    codexBinarySha256: DIGESTS.codexBinary,
    codexVersion: "0.154.0",
    configDigest: DIGESTS.imageConfig,
    devices: [],
    entrypoint: ["/usr/local/libexec/sdd-codegraph/runtime-entrypoint"],
    entrypointSha256: DIGESTS.entrypoint,
    indexDigest: DIGESTS.imageIndex,
    platform: { os: "linux", architecture: "arm64" },
    platformDigest: DIGESTS.imagePlatform,
    rootfsInventorySha256: DIGESTS.rootfs,
    unexpectedFiles: [],
    user: "10001:10001",
    command: ["--listen", "stdio://"],
  };
}

test("runtime image schemas are strict and accept only the approved v1 shape", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validateManifest = ajv.compile(RUNTIME_IMAGE_MANIFEST_SCHEMA);
  const validateAttestation = ajv.compile(RUNTIME_STARTUP_ATTESTATION_SCHEMA);
  assert.equal(validateManifest(candidateManifest()), true, ajv.errorsText(validateManifest.errors));
  assert.equal(validateAttestation(startupAttestation()), true, ajv.errorsText(validateAttestation.errors));

  const extraManifest = candidateManifest();
  extraManifest.codex.auth = { token: "secret" };
  assert.equal(validateManifest(extraManifest), false);
  const extraAttestation = { ...startupAttestation(), authJson: "/run/codex/auth.json" };
  assert.equal(validateAttestation(extraAttestation), false);
});

test("approved runtime inputs bind Debian Codex platform and non-root identity", () => {
  assert.deepEqual(APPROVED_RUNTIME_IMAGE_INPUTS, {
    schemaVersion: "1.0.0",
    contractVersion: "1",
    platform: { os: "linux", architecture: "arm64" },
    builder: {
      repository: "docker.io/library/rust",
      version: "1.98.1-bookworm",
      reference: "docker.io/library/rust@sha256:09e98f39fa15751de9476fefafe4be0e4ef92b292d608410595bbbde9ebdd375",
      indexDigest: "sha256:9a73a5088750b4c95158ab26629c854c3d6fc4b173cb7bc8079ad252d8ed7bfa",
      platformDigest: "sha256:09e98f39fa15751de9476fefafe4be0e4ef92b292d608410595bbbde9ebdd375",
      configDigest: "sha256:690e6fc7bbfdeff8f8d3cd808062a58c0afe5416ca5aaf8e32cb94ad1d995bc7",
      rustc: "rustc 1.98.1 (48a229cea 2026-09-01)",
      llvm: "22.1.8",
    },
    registry: { repository: "ghcr.io/gustavoarielms/multi-sdd-team-codex-app-server" },
    base: candidateManifest().base,
    entrypoint: { path: "/usr/local/libexec/sdd-codegraph/runtime-entrypoint" },
    codex: {
      version: "0.154.0",
      source: candidateManifest().codex.source,
      archiveSha256: candidateManifest().codex.archiveSha256,
      binaryPath: "/opt/openai/codex-app-server/bin/codex-app-server",
    },
    identity: { uid: 10001, gid: 10001 },
  });
  assert.equal(Object.isFrozen(APPROVED_RUNTIME_IMAGE_INPUTS), true);
});

test("runtime image manifest validation rejects mutable or divergent authority", () => {
  assert.deepEqual(validateRuntimeImageManifest(candidateManifest()), candidateManifest());
  const cases = [
    (value) => { value.platform.architecture = "amd64"; },
    (value) => { value.base.version = "13.7"; },
    (value) => { value.base.platformDigest = DIGESTS.imagePlatform; },
    (value) => { value.codex.version = "latest"; },
    (value) => { value.codex.archiveSha256 = DIGESTS.imageIndex; },
    (value) => { value.identity.uid = 0; },
    (value) => { value.image.reference = `${value.image.repository}:latest`; },
    (value) => { value.image.reference = `${value.image.repository}@${value.image.indexDigest}`; },
    (value) => { value.entrypoint.path = "/bin/sh"; },
    (value) => { value.extra = true; },
  ];
  for (const mutate of cases) {
    const value = candidateManifest();
    mutate(value);
    assert.throws(
      () => validateRuntimeImageManifest(value),
      (error) => error?.message === "BROKER_RUNTIME_IMAGE_MANIFEST_INVALID",
    );
  }
});

test("approved Docker input is derived only from a validated image manifest", () => {
  assert.deepEqual(approvedImageFromManifest(candidateManifest()), {
    command: ["--listen", "stdio://"],
    configDigest: DIGESTS.imageConfig,
    digest: DIGESTS.imagePlatform,
    entrypoint: ["/usr/local/libexec/sdd-codegraph/runtime-entrypoint"],
    environment: [
      "PATH=/opt/openai/codex-app-server/codex-path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "HOME=/run/codex",
      "CODEX_HOME=/run/codex",
    ],
    reference: `ghcr.io/gustavoarielms/multi-sdd-team-codex-app-server@${DIGESTS.imagePlatform}`,
    user: "10001:10001",
  });
  const tampered = candidateManifest();
  tampered.entrypoint.sha256 = "sha256:invalid";
  assert.throws(() => approvedImageFromManifest(tampered), /BROKER_RUNTIME_IMAGE_MANIFEST_INVALID/u);
});

test("startup attestation is one bounded canonical line without sensitive fields", () => {
  const value = startupAttestation();
  const line = formatRuntimeStartupAttestation(value);
  assert.equal(line, `${JSON.stringify(value)}\n`);
  assert.ok(Buffer.byteLength(line) <= 512);
  assert.deepEqual(parseRuntimeStartupAttestation(line), value);
  assert.doesNotMatch(line, /auth|token|environment|promptContent|\/workspace/u);

  for (const candidate of [
    JSON.stringify(value),
    ` ${JSON.stringify(value)}\n`,
    `${JSON.stringify({ ...value, token: "secret" })}\n`,
    `${JSON.stringify(value)}\n${JSON.stringify(value)}\n`,
    `${"x".repeat(513)}\n`,
  ]) {
    assert.throws(
      () => parseRuntimeStartupAttestation(candidate),
      (error) => error?.message === "BROKER_RUNTIME_ATTESTATION_INVALID",
    );
  }
});

test("runtime image evidence rejects tampered binaries identities and inventories", () => {
  assert.deepEqual(
    validateRuntimeImageEvidence(candidateManifest(), runtimeEvidence()),
    runtimeEvidence(),
  );
  const cases = [
    (value) => { value.entrypointSha256 = DIGESTS.prompt; },
    (value) => { value.codexBinarySha256 = DIGESTS.prompt; },
    (value) => { value.user = "0:0"; },
    (value) => { value.platform.architecture = "amd64"; },
    (value) => { value.command = ["sh", "-c", "codex"]; },
    (value) => { value.capabilities = ["SYS_ADMIN"]; },
    (value) => { value.devices = ["/dev/kvm"]; },
    (value) => { value.authFiles = ["/run/codex/auth.json"]; },
    (value) => { value.unexpectedFiles = ["/bin/curl"]; },
    (value) => { value.error = "raw build output"; },
  ];
  for (const mutate of cases) {
    const value = runtimeEvidence();
    mutate(value);
    assert.throws(
      () => validateRuntimeImageEvidence(candidateManifest(), value),
      (error) => error?.message === "BROKER_RUNTIME_IMAGE_EVIDENCE_INVALID",
    );
  }
});

test("package manifest loading is bounded exact-path and fail-closed", async (context) => {
  const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-runtime-image-manifest-"));
  context.after(() => fs.rm(packageRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(packageRoot, "governance", "runtime", "v1");
  await fs.mkdir(runtimeRoot, { recursive: true });
  const manifestPath = path.join(runtimeRoot, "codex-app-server-image.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(candidateManifest(), null, 2)}\n`);
  assert.deepEqual(await loadRuntimeImageManifest(packageRoot), candidateManifest());

  await fs.writeFile(manifestPath, `${JSON.stringify({ ...candidateManifest(), secret: "TOKEN" })}\n`);
  await assert.rejects(
    () => loadRuntimeImageManifest(packageRoot),
    (error) => error?.message === "BROKER_RUNTIME_IMAGE_MANIFEST_INVALID",
  );
  await fs.rm(manifestPath);
  await assert.rejects(
    () => loadRuntimeImageManifest(packageRoot),
    (error) => error?.message === "BROKER_RUNTIME_IMAGE_UNAVAILABLE",
  );
});

test("runtime image source is package-owned deterministic and contains no credential material", async () => {
  const root = new URL("../", import.meta.url);
  const [dockerfile, dockerignore, cargo, wrapper, inputs, buildRecordBytes, buildInstructions, notice] = await Promise.all([
    fs.readFile(new URL("container/Dockerfile", root), "utf8"),
    fs.readFile(new URL("container/Dockerfile.dockerignore", root), "utf8"),
    fs.readFile(new URL("container/runtime-entrypoint/Cargo.toml", root), "utf8"),
    fs.readFile(new URL("container/runtime-entrypoint/src/main.rs", root), "utf8"),
    fs.readFile(new URL("container/runtime-image-inputs.json", root)),
    fs.readFile(new URL("container/runtime-image-build-record.json", root)),
    fs.readFile(new URL("container/BUILD.md", root), "utf8"),
    fs.readFile(new URL("container/NOTICE.md", root), "utf8"),
  ]);
  const buildRecord = JSON.parse(buildRecordBytes);
  assert.match(dockerfile, /^FROM debian@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132$/mu);
  assert.match(dockerfile, /^USER 10001:10001$/mu);
  assert.match(dockerfile, /^ENTRYPOINT \["\/usr\/local\/libexec\/sdd-codegraph\/runtime-entrypoint"\]$/mu);
  assert.match(dockerfile, /^CMD \["--listen", "stdio:\/\/"\]$/mu);
  assert.doesNotMatch(dockerfile, /apt-get|apk add|curl|wget|sudo|latest|auth\.json/iu);
  assert.equal(dockerignore, [
    "**",
    "!container/",
    "container/*",
    "!container/Dockerfile",
    "!container/dist/",
    "container/dist/*",
    "!container/dist/codex-app-server-package-aarch64-unknown-linux-musl.tar.gz",
    "!container/dist/runtime-entrypoint-aarch64-unknown-linux-gnu",
    "!container/licenses/",
    "container/licenses/*",
    "!container/licenses/openai-codex-LICENSE",
    "!container/licenses/openai-codex-NOTICE",
    "",
  ].join("\n"));
  assert.doesNotMatch(dockerignore, /auth|\.git|\.codex|secret|token/iu);
  assert.match(cargo, /edition = "2024"/u);
  assert.doesNotMatch(cargo, /^\[dependencies\]/mu);
  assert.match(wrapper, /cli_auth_credentials_store = \\"ephemeral\\"/u);
  assert.match(wrapper, /CommandExt/u);
  assert.doesNotMatch(wrapper, /auth\.json|CODEX_ACCESS_TOKEN|OPENAI_API_KEY|println!\([^)]*prompt/iu);
  assert.deepEqual(JSON.parse(inputs), APPROVED_RUNTIME_IMAGE_INPUTS);
  assert.deepEqual(buildRecord.builder, APPROVED_RUNTIME_IMAGE_INPUTS.builder);
  assert.deepEqual(buildRecord.base, APPROVED_RUNTIME_IMAGE_INPUTS.base);
  assert.equal(buildRecord.status, "candidate-unpublished");
  assert.equal(buildRecord.entrypoint.sha256, "sha256:5c87fc27fef983e3a4a6963cd29debe300a4038db5f806356c72d18642ba0026");
  assert.equal(buildRecord.codex.binarySha256, "sha256:0c2495cedd0e01fd6ba1e9d949b637f55ac283e6019b998024c010788da8c508");
  assert.equal(buildRecord.image.ociArchiveSha256, "sha256:4f227de2c3e9a00c7ad242447d0d310b0d7adc5060be94097908bce5ded370a5");
  assert.equal(buildRecord.image.localIndexDigest, "sha256:32bb6581847ff87b49339da8c089d8796566a0ab96434057ea388bca912b95e7");
  assert.equal(buildRecord.image.platformManifestDigest, "sha256:633fbdd34f7760be8d94dae3a1673694b9ff3e70d3a975ccb1c7e6f497ff286f");
  assert.equal(buildRecord.image.configDigest, "sha256:21020eeec646f4ebb8cf16eb118a7c10a874bf1f9c334c4598008ec44769e2dd");
  assert.equal(buildRecord.image.rootfsInventorySha256, "sha256:cc426d5039659c6cb1ed7a38bd749238aa50038bbdb2d0fc1c21787d2395d4fd");
  assert.deepEqual(buildRecord.image.rootfsInventoryExcludedPaths, [
    "/.dockerenv", "/dev", "/etc/hostname", "/etc/hosts", "/etc/resolv.conf", "/proc", "/sys",
  ]);
  assert.equal(buildRecord.entrypoint.byteIdentical, true);
  assert.equal(buildRecord.image.byteIdentical, true);
  assert.deepEqual(buildRecord.verification.authFiles, []);
  assert.deepEqual(buildRecord.verification.capabilities, []);
  assert.deepEqual(buildRecord.verification.devices, []);
  assert.deepEqual(
    parseRuntimeStartupAttestation(`${JSON.stringify(buildRecord.verification.startupAttestation)}\n`),
    buildRecord.verification.startupAttestation,
  );
  assert.equal(buildRecord.verification.registryPublished, false);
  assert.equal(buildRecord.verification.finalRuntimeManifestWritten, false);
  assert.match(buildInstructions, /rewrite-timestamp=true/u);
  assert.match(buildInstructions, /candidate-unpublished/u);
  assert.match(notice, /OpenAI Codex/u);
  assert.equal(`sha256:${createHash("sha256").update(inputs).digest("hex")}`.startsWith("sha256:"), true);
});
