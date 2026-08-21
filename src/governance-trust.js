import { createHash } from "node:crypto";

export const GOVERNANCE_APPROVAL_AUTHORITY = Object.freeze({
  id: "gustavo",
});

export const ENGINEERING_QUALITY_PROFILE_TRUST = Object.freeze({
  profile_id: "engineering-quality-v1",
  profile_version: "1.0.0",
  adapter_id: "node-v1",
  adapter_version: "1.0.0",
  digest: "sha256:a428ece53d85b3af2f5fb0987cb08f45ace2dab43df28da95cbd15f581ff0348",
});

export const CANONICAL_GOVERNANCE_CHECK_BINDINGS = Object.freeze({
  governance_catalog_integrity: Object.freeze({ rule_id: "GOV-CATALOG-INTEGRITY-001", implementation: "governance_catalog_integrity" }),
  codex_role_catalog: Object.freeze({ rule_id: "GOV-CODEX-ROLE-CATALOG-001", implementation: "codex_role_catalog" }),
  reviewer_report_only: Object.freeze({ rule_id: "GOV-REVIEW-REPORTONLY-001", implementation: "reviewer_report_only" }),
  review_handoff_contract: Object.freeze({ rule_id: "GOV-REVIEW-HANDOFF-001", implementation: "review_handoff_contract" }),
  pipeline_dependency_order: Object.freeze({ rule_id: "GOV-PIPELINE-ORDER-001", implementation: "pipeline_dependency_order" }),
});

export const CANONICAL_ENGINEERING_GATE_BINDINGS = Object.freeze({
  javascript_syntax: Object.freeze({
    implementation: "javascript_syntax",
    rule_ids: Object.freeze(["ENG-SOURCE-SYNTAX-001"]),
    timeout_ms: 30000,
    max_output_bytes: 262144,
  }),
  node_lint_complexity: Object.freeze({
    implementation: "node_lint_complexity",
    rule_ids: Object.freeze(["ENG-LINT-ERRORS-001", "ENG-CYCLOMATIC-COMPLEXITY-001"]),
    timeout_ms: 60000,
    max_output_bytes: 262144,
  }),
  test_suite: Object.freeze({
    implementation: "test_suite",
    rule_ids: Object.freeze(["ENG-TEST-SUITE-001"]),
    timeout_ms: 120000,
    max_output_bytes: 262144,
  }),
  governance: Object.freeze({
    implementation: "governance",
    rule_ids: Object.freeze([
      "GOV-CATALOG-INTEGRITY-001",
      "GOV-CODEX-ROLE-CATALOG-001",
      "GOV-REVIEW-REPORTONLY-001",
      "GOV-REVIEW-HANDOFF-001",
      "GOV-PIPELINE-ORDER-001",
    ]),
    timeout_ms: 30000,
    max_output_bytes: 262144,
  }),
  production_dependency_audit: Object.freeze({
    implementation: "production_dependency_audit",
    rule_ids: Object.freeze(["SEC-PRODUCTION-DEPS-001"]),
    timeout_ms: 60000,
    max_output_bytes: 262144,
  }),
  npm_package_surface: Object.freeze({
    implementation: "npm_package_surface",
    rule_ids: Object.freeze(["ENG-PACKAGE-SURFACE-001"]),
    timeout_ms: 60000,
    max_output_bytes: 262144,
  }),
  forbidden_references: Object.freeze({
    implementation: "forbidden_references",
    rule_ids: Object.freeze(["GOV-FORBIDDEN-SURFACE-001"]),
    timeout_ms: 30000,
    max_output_bytes: 262144,
  }),
});

export const APPROVED_GOVERNANCE_RULES = Object.freeze({
  "GOV-CATALOG-INTEGRITY-001": Object.freeze({ version: 1, digest: "sha256:88d7119b6b2ad954bf5d9036818e5445391c3f3d63c8f956d5dfded9d7a0e78b" }),
  "GOV-CODEX-ROLE-CATALOG-001": Object.freeze({ version: 1, digest: "sha256:039673dc096c71ca43dc05bda04fcd340dcb1f942c118450aeac03a3b253b498" }),
  "GOV-REVIEW-REPORTONLY-001": Object.freeze({ version: 2, digest: "sha256:7efb55a76a38e7f59d4d468f544d7ab3b88576b67604b74b21c1c013c79e1c5a" }),
  "GOV-REVIEW-HANDOFF-001": Object.freeze({ version: 2, digest: "sha256:6d09129b6fe33ee9e1d1da43f1fc16ce9a3dc1c68d8b699223c3f3f40ba674d5" }),
  "GOV-PIPELINE-ORDER-001": Object.freeze({ version: 1, digest: "sha256:72491722fedff21829e355a77ba271e63bbebdaa97ebfc85c5769f71ab85af8c" }),
  "GOV-REMEDIATION-LOOP-001": Object.freeze({ version: 1, digest: "sha256:aa0a1290b8464e656ff3c7df33c46397452074f00cc0e6f288790c2ea12cdac6" }),
  "GOV-ORCHESTRATOR-AUTHORITY-001": Object.freeze({ version: 1, digest: "sha256:04236ecb671e0cd140de6ec4def89881f8ffc3328536dfe0bce7365c7eca591c" }),
  "GOV-ROLE-CAPABILITY-001": Object.freeze({ version: 2, digest: "sha256:781a466e5b13b94802b53b9dfd95a0df85939a0d1287d0fe4dc28781356f911e" }),
  "GOV-ARCH-REVIEW-SCOPE-001": Object.freeze({ version: 1, digest: "sha256:f3013c3a419d8e01c946952039c8c195bac98ec390141c5f9ec105e160c5a6bf" }),
  "GOV-SECURITY-ACTIVE-001": Object.freeze({ version: 2, digest: "sha256:bc39065d97e90f8152f751418b0fe1711fea2f7924bb97fcdf2cb1a7ea041dfb" }),
  "ENG-IMPLEMENTER-TDD-001": Object.freeze({ version: 2, digest: "sha256:ca97a046bb1edd9117864f96bc10165a0e37878e78c2e844b3e024ae5a269f89" }),
  "GOV-FAILED-GATE-001": Object.freeze({ version: 1, digest: "sha256:70b895f80eb48fac9faeabf117e108629fce568e5d548d7d2df4e33280675627" }),
  "GOV-DETERMINISTIC-PRECEDENCE-001": Object.freeze({ version: 1, digest: "sha256:3801c857d30193c4603087977a1c7060669c269fe8d8312ef03caa0905d7fd37" }),
  "GOV-EVIDENCE-SAFE-001": Object.freeze({ version: 1, digest: "sha256:e5514e884237ea40df52a50e1af3cfa9d9749bc3f1cc7238d3480a71f7884ec3" }),
  "GOV-CANDIDATE-NONBLOCKING-001": Object.freeze({ version: 1, digest: "sha256:70c314f67fa614b6188887fdf6abb9e0ab6be438c30a7b10c3f5845ac2b28d78" }),
  "GOV-HUMAN-AUTHORITY-001": Object.freeze({ version: 1, digest: "sha256:fc557e55215ae29e03026607fbb2b708af22ee1e150a9bcff8de31aee210b391" }),
  "GOV-EXCEPTION-LIFECYCLE-001": Object.freeze({ version: 1, digest: "sha256:f8fb06483439037756d286b167fdc76f1b62b1319728c56045f8115b104554ad" }),
  "GOV-CHECK-RULE-LINK-001": Object.freeze({ version: 1, digest: "sha256:0785674aed190cf0ba15f1d20b89319bc927e7df54c5e1281b9fe83f5dab7840" }),
  "GOV-INSTALL-PARITY-001": Object.freeze({ version: 1, digest: "sha256:17bc4f0dd08816fe383e33f0f5c4f08c8596eac3e5218db43c378f3086d764e1" }),
  "ENG-SOURCE-SYNTAX-001": Object.freeze({ version: 1, digest: "sha256:586ffe9490946152c076e51ce90423230d9f9c419c7c298d73eeed31df2645a8" }),
  "ENG-TEST-SUITE-001": Object.freeze({ version: 1, digest: "sha256:46e742c80817c1be42d473edcc1b6b49d3fe432365e07919c02dab4707caad00" }),
  "SEC-PRODUCTION-DEPS-001": Object.freeze({ version: 1, digest: "sha256:eb56caf5a8bd47484bc4d8aae34cb43d6dceed98916383b4f9754413210bfdf3" }),
  "ENG-PACKAGE-SURFACE-001": Object.freeze({ version: 1, digest: "sha256:ede1a3abf05773c749d0fbdf730140c9230aad79bad50bab48826c811eee4e22" }),
  "GOV-FORBIDDEN-SURFACE-001": Object.freeze({ version: 1, digest: "sha256:d6298d8376b6a031e9f99d4dc5ac14183eef2f017a915985c1ff6715e2e7a387" }),
  "ENG-LINT-ERRORS-001": Object.freeze({ version: 1, digest: "sha256:5d2d2f9f0187cfd634d1ef9290d38f7a847b87b52d5be9699080df6a9a6231af" }),
  "ENG-CYCLOMATIC-COMPLEXITY-001": Object.freeze({ version: 1, digest: "sha256:2e0dd9b3a0a6be512624ea68a310b9832866b5619f4a2cc52038bf55d74b5775" }),
  "TEST-UNIT-SUITE-001": Object.freeze({ version: 1, digest: "sha256:a0dba6a470acceade7feea7834509176e34c83ee09335da2c6e631cbe1cb6209" }),
  "TEST-INTEGRATION-SUITE-001": Object.freeze({ version: 1, digest: "sha256:8ca8c8a910c1c6f9751d37aead941c1300c8fa6e036135c776f7e22008ef6286" }),
  "TEST-COVERAGE-GLOBAL-001": Object.freeze({ version: 1, digest: "sha256:563a816f4b3a7c2858198028a843d8c50d0b0eee7522be18f0faf27ed2c8eaaf" }),
  "TEST-COVERAGE-CHANGED-001": Object.freeze({ version: 1, digest: "sha256:a0150bda02029fcecc67a1c8758bab074d564c579c0a5b8604375d91292840d6" }),
  "ARCH-NO-CYCLES-001": Object.freeze({ version: 1, digest: "sha256:0ba8d6c6e3bb4c70e3954f3dc0865add753d2867d42a192d705dd994e6f371e9" }),
  "ARCH-PROD-NO-TEST-001": Object.freeze({ version: 1, digest: "sha256:a2d4459763ee37823e54a4d882d0c18757db90f113d533925517f64be02c9577" }),
  "ARCH-SRC-NO-BIN-001": Object.freeze({ version: 1, digest: "sha256:9affe0e27f3dd5138ff6ec3d923e72914138ffddf4bd897d2e5fa697ac1edf58" }),
  "ARCH-IMPORT-RESOLUTION-001": Object.freeze({ version: 1, digest: "sha256:b8cbc58b264cfb5fe7443040829f6daa3af3a82349cd5415783fb610502492a0" }),
  "ARCH-PROD-NO-DEV-DEPS-001": Object.freeze({ version: 1, digest: "sha256:26ae27bfe498002d2565d528cc1cef236c4d5bd014beb414c7217b633969fb27" }),
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function governanceRuleDigest(rule) {
  return governanceDocumentDigest(rule);
}

export function governanceDocumentDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
