# Governance Contract

## Status

- Shared contract version: `1.0.0`; engineering gate runs emit `1.1.0`
- Schema dialect: [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)
- Validator used by this repository: Ajv 8 in strict mode
- Structured emission and handoff validation: implemented for architecture, quality, and security review gates
- Approved rule catalog and deterministic governance checks: implemented
- Persistence, metrics, and dashboard integration: not implemented

## Purpose

These schemas are the shared contract for evidence and governance results
produced by Codex agents, deterministic checks, and human
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
| `rule-catalog.schema.json` | Canonical versioned collection of governance rules |
| `check-registry.schema.json` | Deterministic check-to-rule registry |
| `governance-check-result.schema.json` | Deterministic results with bounded evidence |
| `engineering-gate-config.schema.json` | Strict target-owned executor selection |
| `engineering-gate-registry.schema.json` | Package-owned executor, rule, and safety bindings |
| `engineering-gate-run.schema.json` | Aggregate deterministic engineering run and exit semantics |
| `engineering-quality-profile.schema.json` | Approved generic metrics, thresholds, and node-v1 adapter contract |
| `exception.schema.json` | Human-approved, scoped, time-bounded exception |
| `common.schema.json` | Shared identifiers, actors, locations, and enums |

Schemas live under `governance/schemas/v1/`. Examples live under
`governance/examples/v1/`.

The canonical rule catalog is `governance/rules/v1/catalog.json`; the check
registry is `governance/checks/v1/registry.json`; and the engineering executor
registry is `governance/gates/v1/registry.json`. The canonical quality profile
is `governance/profiles/v1/engineering-quality-profile.json`. An approved rule records its
human approval reference, responsible gate, source references, and evidence
requirements. Session-only recommendations remain `proposed` with a `none`
gate effect until a versioned authority approves them.

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
npm run governance
```

Validate an agent handoff from a file or stdin:

```bash
sdd-codegraph validate-result result.json --agent architecture_reviewer
sdd-codegraph validate-result - --agent tester_reviewer
```

The parser accepts exactly one JSON object. Markdown fences and surrounding
prose fail closed. Validation errors describe only the failed constraint and do
not echo rejected values.

`sdd-codegraph check-governance [path]` writes exactly one canonical JSON
`governance-check-result` document to stdout. It exits `1` when a trustworthy
failed result has approved `block` effect and `2` when the layout or protection
state is untrustworthy; failed `warn` or `none` results stay machine-readable
without failing the process. The checks cover catalog integrity, the Codex role
catalog, reviewer report-only constraints, structured review handoffs, pipeline
dependency ordering, and managed prompt protection.
If the catalog or registry loads as JSON but fails its schema or referential
integrity, execution stops before registry dispatch and emits one bounded,
blocking `GOV-CATALOG-INTEGRITY-001` result. Result validation also requires
the envelope outcome to match all check statuses and every referenced evidence
item to carry the same `check_id` as its result.

The command resolves three layouts: this source checkout, a project installation
under `.codex/`, and a global Codex home containing `governance/`, `agents/`,
and `pipeline.json`. Installed layouts use their installed Codex definitions and
pipeline while validation code comes from the executing package. Unknown or
incomplete layouts fail closed with a bounded machine-readable result.

For a source checkout, `managed_prompt_protection` verifies that canonical
agents use permission profiles rather than legacy sandbox keys and contain the
non-delegable prompt boundary. For a project installation it additionally
requires the exact package-owned prompt file set and bytes, the protected digest inventory, regular
single-link files, a supported configured permission profile, and non-mutating
filesystem capability probes for every prompt, the digest inventory, and both
protected directories. Added, removed, or renamed agent prompts, legacy
configuration, incomplete probe coverage, and writable paths fail closed.
Denied probes remain unproven because the checked process can manufacture and
later revoke discretionary file modes. Child-controlled Codex environment
variables are not security evidence, and the current runtime exposes no trusted
attestation channel. Project checks therefore exit `2` until an external runtime
or broker authority can be verified without trusting the checked process.
Global layouts do not have a
package-proven project boundary and therefore return untrustworthy exit `2`.
This protects the supported AI-mediated workflow; it does not prevent a human
or administrator with direct filesystem access from updating files.

## Deterministic engineering gates

`sdd-codegraph run-gates [target]` reads the target's
`.sdd-codegraph/gates.json`, validates the exact v1 executor allowlist, runs the
package-owned executors in registry order, validates the complete result, and
writes one `engineering-gate-run` JSON document to stdout. The ten executors
cover tracked JavaScript and shell syntax, package-owned Node.js lint and
per-function complexity, explicit unit and integration suites, combined global
and changed/new coverage, five Node.js architecture-boundary checks, the six individual governance checks, production
dependency audit, npm package surface, and approved forbidden references.

Engineering gate runs emit version `1.1.0`, including blocked runs. Completed
coverage results contain, in order, `coverage_global`, `coverage_changed`,
`coverage_unit`, and `coverage_integration` evidence. The latter two retain
exact per-suite lines, branches, functions, and statements counts as `observed`
evidence; they add no checks, thresholds, or gate effects. They are forbidden
when coverage is `error` or `not_run`. Evidence subdocuments remain `1.0.0`.
The validator continues accepting historical `1.0.0` runs with exactly the
original two coverage evidence items. Old validators can reject `1.1.0`; there
is no automatic downgrade. Document validity alone does not establish approval
eligibility, and historical runs cannot close the issue #13 proof.

Executor states are deliberately distinct:

- `pass`: trustworthy execution satisfied the approved rule;
- `fail`: trustworthy execution found a functional rule violation;
- `error`: the executor could not produce a trustworthy result;
- `not_run`: a prior executor error stopped later execution.

The aggregate outcome and process exit code are `passed`/`0`, `failed`/`1`, or
`blocked`/`2`. Functional failures do not hide later functional findings, but
an executor error stops the remaining executors and records each as `not_run`.
Missing or invalid configuration, unsafe paths, unsupported layouts, spawn
failures, timeouts, output overflow, and invalid generated results are blocked
runs.

Gate effects and executor bindings are exact package trust, not project input.
The configuration cannot supply commands, plugins, effects, exceptions,
coverage configuration, suppressions, or baselines, and a reviewer cannot
override a deterministic failure or error.
Child processes use fixed argument arrays without a shell, target paths are
real-path contained, output and time are bounded by the executor registry, and
only normalized reason codes, counts, bounded source locations, summaries, and
redaction metadata enter the canonical document. The npm executors use a
disposable cache so a broken user cache cannot change the gate result.

The runner must start from a trusted launcher, and its checkout must remain
immutable while gates execute. Package-owned analyzer children receive a
sanitized environment, while the shipped CI and publish workflows explicitly
clear Node, ESLint, c8, V8 coverage, and nyc control variables. This prevents
target or ambient `NODE_OPTIONS`, `NODE_PATH`, `NODE_V8_COVERAGE`, `C8_CONFIG`,
`C8_REPORTER`, `NYC_CONFIG`, `TIMING`, `DEBUG`, and `ESLINT_FLAGS` values from
changing analyzer execution or its JSON protocol. Compromise before the parent
Node process starts and concurrent local mutation of the checkout remain
outside the runner's trust boundary.

## Engineering Quality Profile v1

The package-owned `engineering-quality-v1` profile is schema-valid, approved,
and bound by exact profile and adapter versions plus a trusted content digest.
`gates.json` selects `engineering-quality-v1@1.0.0` with
`node-v1@1.0.0`; it cannot redefine thresholds, scopes, tools, suppressions,
effects, baselines, or exceptions.

The generic profile fixes these blocking semantics:

- zero approved lint errors; warnings are informational;
- classic McCabe cyclomatic complexity no greater than `15` per function;
- required, non-overlapping unit and integration suites with no skipped or todo tests;
- repository coverage of `85%` lines, `80%` branches, `85%` functions, and `85%` statements;
- changed/new coverage of `90%` lines, `85%` branches, `90%` functions, and `90%` statements;
- no production cycles, no production-to-test or src-to-bin dependencies,
  reliable import resolution, and no production imports from development-only dependencies.

The embedded `node-v1` adapter contract fixes source and test roots, supported
Node versions, tool identities, disabled target configuration, rejected inline
suppressions, and offline execution. The lint and complexity executor uses the
package dependency ESLint `10.8.1`, the recommended `@eslint/js` rules as
errors, Node built-in globals, ESM source semantics, and classic McCabe maximum
`15` for every function. Warnings remain informational evidence. The built-in
test runner remains bound to the supported Node runtime. Coverage uses exact
direct dependencies `c8@12.0.0` and `istanbul-lib-coverage@3.2.2`, combines
separate unit and integration maps, and uses exact covered/total item
arithmetic. Global coverage contains tracked production files; changed/new
coverage additionally includes complete, non-ignored untracked production
files. Deleted files are excluded and renames use their final path.
Architecture uses exactly `dependency-cruiser@18.2.0` from the package's
content-manifest-verified vendored runtime. It receives separate tracked
production/test inventories, applies the fixed five-rule policy, rejects target
configuration and baselines, and caps detail evidence at 20 per rule while
retaining full totals. Input and runtime identities are checked before and
after analysis under a quiescent-filesystem assumption; active swap-back is an
explicit residual rather than a prevented condition.

Because changed-code coverage is blocking, `run-gates` requires an explicit
full comparison commit and records both the supplied SHA and effective merge
base. Missing or untrustworthy comparison history blocks the run with exit `2`.
Target `.c8rc*`, `.nycrc*`, package `c8`/`nyc` properties, and inline coverage
ignore directives also block the run. Executor timeouts abort owned child
process trees and await termination plus temporary coverage cleanup before the
canonical result settles.

## Runtime enforcement

- Codex agent configuration supplies the JSON-only contract, while the main
  session policy requires the deterministic CLI validator before accepting a
  review handoff.
- Codex reviewer sandboxes are read-only and their prompts prohibit implementation
  ownership or conditional write exceptions.
- Project and global Codex installers copy the v1 schemas, canonical catalog,
  check registry, engineering gate registry, and quality profile under
  `.codex/governance/` or `$CODEX_HOME/governance/`.
- The main session may render a human-readable summary only after validation;
  the validated JSON remains canonical.

## Versioning

- Compatible additions use a new `1.x` contract version while retaining the v1 directory.
- The v1 envelope shape remains stable; agent producers are fixed to the supported Codex runtime.
- Unsupported agent-runtime values fail closed. This narrowing is a breaking package-level change.
- Future breaking field or envelope changes require a new schema directory and an explicit migration decision.

## Deliberate boundary

The checker evaluates the current repository and emits an ephemeral result. It
does not persist runs, calculate trends, publish metrics, or drive a dashboard.
Those capabilities remain separate later phases.

## Local trust boundary

Approval trust is checker-owned code in `src/governance-trust.js`, not a claim
made by the catalog being validated. It fixes the human authority, the exact
governance and engineering executor bindings, and each
approved `rule_id` plus version and canonical SHA-256 content digest. Proposed
rules do not require a trust binding. Each approved rule's digest includes its
approval reference. Changing an approved rule therefore
requires both a newly approved catalog change and an explicit trust-code update.
The approved engineering quality profile is independently bound by exact
profile ID/version, adapter ID/version, approval authority, and canonical
SHA-256 content digest.
Installed projects do not copy a second trust file: validation uses the trust
module shipped with the executing package.
