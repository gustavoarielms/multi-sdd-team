# Governance Contract

## Status

- Contract version: `1.0.0`
- Schema dialect: [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)
- Validator used by this repository: Ajv 8 in strict mode
- Structured emission and handoff validation: implemented for architecture, quality, and security review gates
- Persistence, rule catalog, metrics, and dashboard integration: not implemented yet

## Purpose

These schemas are the runtime-neutral contract for evidence and governance
results produced by Pi agents, Codex agents, deterministic checks, and human
approvals. They translate the responsibility model in
`docs/agent-governance-responsibility-map.md` into machine-validatable data.

The contract is modular:

| Schema | Responsibility |
|---|---|
| `agent-result.schema.json` | Execution envelope and handoff |
| `finding.schema.json` | One evidenced rule violation or candidate finding |
| `evidence.schema.json` | Bounded, redacted evidence metadata |
| `gate-decision.schema.json` | Effective pass/fail/blocked/not-run decision |
| `rule.schema.json` | Versioned engineering or architecture rule |
| `exception.schema.json` | Human-approved, scoped, time-bounded exception |
| `common.schema.json` | Shared identifiers, actors, locations, and enums |

Schemas live under `governance/schemas/v1/`. Examples live under
`governance/examples/v1/`.

## Authority and blocking semantics

Severity and blocking are deliberately separate:

- `severity` describes potential impact.
- `recommended_gate_effect` is the reporting agent's recommendation.
- `rule.enforcement.gate_effect` is approved policy.
- `gate_decision` records the effective result after rules and exceptions are evaluated.

A finding is eligible to block only when all of the following are true:

1. its rule is approved;
2. its validation status is `verified`;
3. its status is `open`;
4. the approved rule has a blocking gate effect;
5. no applicable active exception neutralizes that effect;
6. the responsible gate includes it in `blocking_finding_ids`.

Candidate, unverified, or unreproduced findings cannot recommend `block`. An
agent cannot approve a rule or an exception; those records require a human producer.

## Confidence and evidence

`confidence` is an ordinal value (`low`, `medium`, or `high`) rather than a
numeric score. The evidence `level` communicates how the conclusion was
obtained: deterministic, reproduced, observed, static inference, or heuristic.

Evidence stores bounded summaries and references, not arbitrary raw output.
Unknown properties are rejected. Redaction metadata is mandatory and explicitly
tracks secrets, credentials, PII, payloads, and trace identifiers.

## Identity and trends

- Entity IDs identify individual runs, findings, evidence, gates, and exceptions.
- `rule_id` is a stable human-readable policy identifier such as `ARCH-BOUNDARY-001`.
- `fingerprint` is a stable SHA-256 identity for tracking the same logical finding across runs.

The fingerprint algorithm itself will be defined with the future persistence
model. Contract v1 validates its representation but does not prescribe inputs
that could leak sensitive data.

## Referential integrity

JSON Schema validates individual document structure. The runtime validator adds
the cross-document rules that JSON Schema alone cannot express conveniently:

- every referenced evidence and finding exists in the execution envelope;
- blocking findings belong to the gate's finding set;
- blocking findings are approved, verified, and open;
- handoff findings exist and remain open;
- gate decisions reference the same run.

Run:

```bash
npm run check:governance
```

Validate an agent handoff from a file or stdin:

```bash
sdd-codegraph validate-result result.json --agent architecture_reviewer --runtime codex
sdd-codegraph validate-result - --agent tester_reviewer --runtime codex
```

The parser accepts exactly one JSON object. Markdown fences and surrounding
prose fail closed. Validation errors describe only the failed constraint and do
not echo rejected values.

## Runtime enforcement

- Pi automatically validates the final output of `architecture-reviewer`,
  `tester-reviewer`, and `hacker` before the subagent tool accepts the handoff.
- Codex agent configuration supplies the JSON-only contract, while the main
  session policy requires the deterministic CLI validator before accepting a
  review handoff.
- Project and global Codex installers copy the v1 schemas under
  `.codex/governance/schemas/v1/` or `$CODEX_HOME/governance/schemas/v1/`.
- The main session may render a human-readable summary only after validation;
  the validated JSON remains canonical.

## Versioning

- Compatible additions use a new `1.x` contract version while retaining the v1 directory.
- Breaking field or semantic changes require `schemas/v2/` and parallel migration support.
- Existing stored documents retain the schema version they were validated against.
- Prompts and runtimes must not emit a new contract version until parity tests cover both Pi and Codex.

## Next integration step

The next phase will define the approved rule catalog and connect deterministic
checks to stable rule IDs. Persistence, trend metrics, and the dashboard remain
separate later phases.
