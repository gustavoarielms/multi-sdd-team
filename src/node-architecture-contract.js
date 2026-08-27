import path from "node:path";
import { NODE_ARCHITECTURE_ADAPTER_TRUST } from "./governance-trust.js";

export const NODE_ARCHITECTURE_PROTOCOL_VERSION = "1.0.0";
export const NODE_ARCHITECTURE_ANALYZER = Object.freeze({
  id: NODE_ARCHITECTURE_ADAPTER_TRUST.analyzer_id,
  version: NODE_ARCHITECTURE_ADAPTER_TRUST.analyzer_version,
});
export const NODE_ARCHITECTURE_POLICY_DIGEST = NODE_ARCHITECTURE_ADAPTER_TRUST.policy_digest;
export const NODE_ARCHITECTURE_RUNTIME_MANIFEST_DIGEST = NODE_ARCHITECTURE_ADAPTER_TRUST.runtime_manifest_digest;
export const NODE_ARCHITECTURE_PATHS = Object.freeze({
  policy: NODE_ARCHITECTURE_ADAPTER_TRUST.policy_path,
  runtimeManifest: NODE_ARCHITECTURE_ADAPTER_TRUST.runtime_manifest_path,
  runtimeRoot: NODE_ARCHITECTURE_ADAPTER_TRUST.runtime_root_path,
  runtimeEntry: NODE_ARCHITECTURE_ADAPTER_TRUST.runtime_entry,
});
export const NODE_ARCHITECTURE_LIMITS = Object.freeze({
  manifestBytes: 1024 * 1024,
  fileCount: 10000,
  fileBytes: 2 * 1024 * 1024,
  aggregateBytes: 64 * 1024 * 1024,
  moduleCount: 20000,
  edgeCount: 100000,
  detailCount: 20,
});

export const ARCHITECTURE_RULES = Object.freeze([
  Object.freeze({ check_id: "no_production_cycles", rule_id: "ARCH-NO-CYCLES-001" }),
  Object.freeze({ check_id: "production_must_not_import_tests", rule_id: "ARCH-PROD-NO-TEST-001" }),
  Object.freeze({ check_id: "src_must_not_import_bin", rule_id: "ARCH-SRC-NO-BIN-001" }),
  Object.freeze({ check_id: "production_imports_resolve", rule_id: "ARCH-IMPORT-RESOLUTION-001" }),
  Object.freeze({ check_id: "production_must_not_import_dev_dependencies", rule_id: "ARCH-PROD-NO-DEV-DEPS-001" }),
]);

export function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function graphWithinLimits(moduleCount, edgeCount) {
  return Number.isSafeInteger(moduleCount) && moduleCount >= 0 && moduleCount <= NODE_ARCHITECTURE_LIMITS.moduleCount
    && Number.isSafeInteger(edgeCount) && edgeCount >= 0 && edgeCount <= NODE_ARCHITECTURE_LIMITS.edgeCount;
}

const EXPECTED_POLICY = Object.freeze({
  forbidden: Object.freeze([
    Object.freeze({ name: "no_production_cycles", severity: "error", from: Object.freeze({ path: "^(bin|src)/" }), to: Object.freeze({ circular: true }) }),
    Object.freeze({ name: "production_must_not_import_tests", severity: "error", from: Object.freeze({ path: "^(bin|src)/" }), to: Object.freeze({ path: "^test/" }) }),
    Object.freeze({ name: "src_must_not_import_bin", severity: "error", from: Object.freeze({ path: "^src/" }), to: Object.freeze({ path: "^bin/" }) }),
    Object.freeze({ name: "production_imports_resolve", severity: "error", from: Object.freeze({ path: "^(bin|src)/" }), to: Object.freeze({ couldNotResolve: true }) }),
    Object.freeze({ name: "production_must_not_import_dev_dependencies", severity: "error", from: Object.freeze({ path: "^(bin|src)/" }), to: Object.freeze({ dependencyTypes: Object.freeze(["npm-dev"]) }) }),
  ]),
  options: Object.freeze({ doNotFollow: Object.freeze({ path: "(^|/)node_modules(/|$)" }) }),
});

export function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(compareCodeUnits);
  const sortedExpected = [...expected].sort(compareCodeUnits);
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

export function validateArchitecturePolicy(value) {
  return JSON.stringify(value) === JSON.stringify(EXPECTED_POLICY);
}

export function safeText(value, maximum = 1024) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && Buffer.byteLength(value, "utf8") <= maximum
    && [...value].every((character) => {
      const code = character.codePointAt(0);
      return code > 31 && code !== 127;
    });
}

export function safeRelativePath(value) {
  return safeText(value) && !path.isAbsolute(value) && !value.includes("\\")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function safeJavaScriptPath(value) {
  return safeRelativePath(value) && value.endsWith(".js")
    && (value.startsWith("src/") || value.startsWith("bin/") || value.startsWith("test/"));
}

export function canonicalizeCycle(members) {
  if (!Array.isArray(members) || members.length < 1 || members.some((member) => !safeJavaScriptPath(member))) {
    throw new Error("invalid directed cycle");
  }
  const normalized = members.length > 1 && members.at(-1) === members[0] ? members.slice(0, -1) : [...members];
  if (new Set(normalized).size !== normalized.length) throw new Error("invalid directed cycle");
  let smallest = 0;
  for (let index = 1; index < normalized.length; index += 1) {
    if (compareCodeUnits(normalized[index], normalized[smallest]) < 0) smallest = index;
  }
  return [...normalized.slice(smallest), ...normalized.slice(0, smallest)];
}

export function detailKey(detail) {
  if (detail.kind === "cycle") return detail.members.join("\u0000");
  if (detail.kind === "edge") return `${detail.source}\u0000${detail.target}`;
  if (detail.kind === "unresolved") return `${detail.source}\u0000${detail.specifier}`;
  if (detail.kind === "package") return `${detail.source}\u0000${detail.package}`;
  throw new Error("invalid architecture detail");
}
