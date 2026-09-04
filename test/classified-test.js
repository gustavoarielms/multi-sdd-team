import test from "node:test";

export const UNIT_TEST_NAMES = Object.freeze(new Set([
  "engineering gate configuration is strict and requires the exact executor allowlist",
  "a warning governance failure remains non-blocking",
  "candidate, unverified, or unreproduced findings cannot recommend a blocking gate effect",
  "a passing gate cannot retain blocking findings",
  "a gate cannot pass by omitting an eligible blocking finding",
  "approved rules and exceptions require human authority",
  "evidence rejects raw output fields and inconsistent redaction metadata",
  "pure JSON parser rejects markdown fences and surrounding prose",
  "review validation rejects role, non-Codex runtime, gate count, and reference mismatches",
  "validation errors do not echo rejected payload values",
  "catalog integrity rejects invalid documents, duplicate rules, proposed blocks, missing human approval, and orphan checks",
  "deterministic check results require bounded evidence linked to rule and check",
  "mergeManagedBlock preserves unmanaged content and replaces the managed block",
  "setTomlKey preserves unrelated settings",
  "syncCodeGraph initializes a new project",
  "checkCodeGraph rejects pending changes",
  "the package-owned policy fixes exact recommended errors and classic complexity",
  "the architecture policy and cycle normalization are exact and deterministic",
  "runtime attestation accepts only supported Node release lines",
  "broker does not expose run-gates while execution isolation is unavailable",
  "JSONL RPC bounds input, request lifetime, and concurrent server requests",
]));

export function classifyTestName(name) {
  return UNIT_TEST_NAMES.has(name) ? "unit" : "integration";
}

export default function classifiedTest(name, ...arguments_) {
  const suite = process.env.SDD_TEST_SUITE;
  if (suite !== "unit" && suite !== "integration") {
    throw new Error("SDD_TEST_SUITE must identify one explicit test suite.");
  }
  if (classifyTestName(name) === suite) test(name, ...arguments_);
}
