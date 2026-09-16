import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";

const require = createRequire(import.meta.url);
const manifestSchema = require("../governance/runtime/v1/codex-app-server-image.schema.json");
const attestationSchema = require("../governance/runtime/v1/runtime-startup-attestation.schema.json");
const imageInputs = require("../container/runtime-image-inputs.json");

const MANIFEST_RELATIVE_PATH = "governance/runtime/v1/codex-app-server-image.json";
const MANIFEST_BYTES = 16 * 1024;
const ATTESTATION_BYTES = 512;
const IMAGE_ENVIRONMENT = Object.freeze([
  "PATH=/opt/openai/codex-app-server/codex-path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "HOME=/run/codex",
  "CODEX_HOME=/run/codex",
]);
const MANIFEST_INVALID = "BROKER_RUNTIME_IMAGE_MANIFEST_INVALID";
const MANIFEST_UNAVAILABLE = "BROKER_RUNTIME_IMAGE_UNAVAILABLE";
const EVIDENCE_INVALID = "BROKER_RUNTIME_IMAGE_EVIDENCE_INVALID";
const ATTESTATION_INVALID = "BROKER_RUNTIME_ATTESTATION_INVALID";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const RUNTIME_IMAGE_MANIFEST_SCHEMA = deepFreeze(manifestSchema);
export const RUNTIME_STARTUP_ATTESTATION_SCHEMA = deepFreeze(attestationSchema);
export const APPROVED_RUNTIME_IMAGE_INPUTS = deepFreeze(imageInputs);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateManifestShape = ajv.compile(RUNTIME_IMAGE_MANIFEST_SCHEMA);
const validateAttestationShape = ajv.compile(RUNTIME_STARTUP_ATTESTATION_SCHEMA);

function fail(code) {
  throw new Error(code);
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())) fail(code);
}

function approvedManifestConstants(value) {
  const inputs = APPROVED_RUNTIME_IMAGE_INPUTS;
  return value.schemaVersion === inputs.schemaVersion
    && value.contractVersion === inputs.contractVersion
    && isDeepStrictEqual(value.platform, inputs.platform)
    && isDeepStrictEqual(value.base, inputs.base)
    && value.image.repository === inputs.registry.repository
    && value.image.reference === `${value.image.repository}@${value.image.platformDigest}`
    && value.entrypoint.path === inputs.entrypoint.path
    && value.codex.version === inputs.codex.version
    && value.codex.source === inputs.codex.source
    && value.codex.archiveSha256 === inputs.codex.archiveSha256
    && value.codex.binaryPath === inputs.codex.binaryPath
    && isDeepStrictEqual(value.identity, inputs.identity);
}

export function validateRuntimeImageManifest(value) {
  if (!validateManifestShape(value) || !approvedManifestConstants(value)) fail(MANIFEST_INVALID);
  return value;
}

export function approvedImageFromManifest(value) {
  const manifest = validateRuntimeImageManifest(value);
  return {
    command: ["--listen", "stdio://"],
    configDigest: manifest.image.configDigest,
    digest: manifest.image.platformDigest,
    entrypoint: [manifest.entrypoint.path],
    environment: [...IMAGE_ENVIRONMENT],
    reference: manifest.image.reference,
    user: `${manifest.identity.uid}:${manifest.identity.gid}`,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function formatRuntimeStartupAttestation(value) {
  if (!validateAttestationShape(value)) fail(ATTESTATION_INVALID);
  const line = `${canonicalJson(value)}\n`;
  if (Buffer.byteLength(line) > ATTESTATION_BYTES) fail(ATTESTATION_INVALID);
  return line;
}

export function parseRuntimeStartupAttestation(input) {
  let line;
  try {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
    if (bytes.length === 0 || bytes.length > ATTESTATION_BYTES) fail(ATTESTATION_INVALID);
    line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(ATTESTATION_INVALID);
  }
  if (!line.endsWith("\n") || line.slice(0, -1).includes("\n")) fail(ATTESTATION_INVALID);
  let value;
  try {
    value = JSON.parse(line.slice(0, -1));
  } catch {
    fail(ATTESTATION_INVALID);
  }
  if (!validateAttestationShape(value) || formatRuntimeStartupAttestation(value) !== line) {
    fail(ATTESTATION_INVALID);
  }
  return value;
}

export function validateRuntimeImageEvidence(manifestValue, evidence) {
  const manifest = validateRuntimeImageManifest(manifestValue);
  exactKeys(evidence, [
    "authFiles",
    "capabilities",
    "codexBinarySha256",
    "codexVersion",
    "command",
    "configDigest",
    "devices",
    "entrypoint",
    "entrypointSha256",
    "indexDigest",
    "platform",
    "platformDigest",
    "rootfsInventorySha256",
    "unexpectedFiles",
    "user",
  ], EVIDENCE_INVALID);
  const expected = {
    authFiles: [],
    capabilities: [],
    codexBinarySha256: manifest.codex.binarySha256,
    codexVersion: manifest.codex.version,
    command: ["--listen", "stdio://"],
    configDigest: manifest.image.configDigest,
    devices: [],
    entrypoint: [manifest.entrypoint.path],
    entrypointSha256: manifest.entrypoint.sha256,
    indexDigest: manifest.image.indexDigest,
    platform: manifest.platform,
    platformDigest: manifest.image.platformDigest,
    rootfsInventorySha256: manifest.rootfsInventorySha256,
    unexpectedFiles: [],
    user: `${manifest.identity.uid}:${manifest.identity.gid}`,
  };
  if (!isDeepStrictEqual(evidence, expected)) fail(EVIDENCE_INVALID);
  return evidence;
}

function withinRoot(root, target) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function readManifestFile(packageRoot) {
  let root;
  let manifestPath;
  let handle;
  try {
    root = await fs.realpath(packageRoot);
    manifestPath = path.join(root, ...MANIFEST_RELATIVE_PATH.split("/"));
    const parent = await fs.realpath(path.dirname(manifestPath));
    if (!withinRoot(root, parent)) fail(MANIFEST_INVALID);
    const metadata = await fs.lstat(manifestPath, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > BigInt(MANIFEST_BYTES)) {
      fail(MANIFEST_INVALID);
    }
    const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
    handle = await fs.open(manifestPath, fsConstants.O_RDONLY | noFollow);
    const before = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (bytes.length > MANIFEST_BYTES
      || ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some((field) => before[field] !== after[field])) {
      fail(MANIFEST_INVALID);
    }
    return bytes;
  } catch (error) {
    if ([MANIFEST_INVALID, MANIFEST_UNAVAILABLE].includes(error?.message)) throw error;
    fail(MANIFEST_UNAVAILABLE);
  } finally {
    if (handle) {
      try { await handle.close(); } catch { fail(MANIFEST_UNAVAILABLE); }
    }
  }
}

export async function loadRuntimeImageManifest(packageRoot = new URL("../", import.meta.url)) {
  const bytes = await readManifestFile(packageRoot);
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail(MANIFEST_INVALID);
  }
  return validateRuntimeImageManifest(value);
}
