import { createHash } from "node:crypto";

export const GOVERNANCE_APPROVAL_AUTHORITY = Object.freeze({
  id: "gustavo",
});

export const CANONICAL_GOVERNANCE_CHECK_BINDINGS = Object.freeze({
  governance_catalog_integrity: Object.freeze({ rule_id: "GOV-CATALOG-INTEGRITY-001", implementation: "governance_catalog_integrity" }),
  codex_role_catalog: Object.freeze({ rule_id: "GOV-CODEX-ROLE-CATALOG-001", implementation: "codex_role_catalog" }),
  reviewer_report_only: Object.freeze({ rule_id: "GOV-REVIEW-REPORTONLY-001", implementation: "reviewer_report_only" }),
  review_handoff_contract: Object.freeze({ rule_id: "GOV-REVIEW-HANDOFF-001", implementation: "review_handoff_contract" }),
  pipeline_dependency_order: Object.freeze({ rule_id: "GOV-PIPELINE-ORDER-001", implementation: "pipeline_dependency_order" }),
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
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function governanceRuleDigest(rule) {
  return `sha256:${createHash("sha256").update(canonicalJson(rule)).digest("hex")}`;
}
