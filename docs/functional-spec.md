# Functional Specification — Issue #12: deterministic Node.js architecture boundaries

## Scope

This change makes the five approved architecture rules in the Engineering
Quality Profile v1 executable for Node.js production modules. It adds one
package-owned `node_architecture` executor to `run-gates`; it does not add a
new CLI command, change aggregate outcomes or exit codes, alter the approved
profile/adapter/schema versions (`1.0.0`), or accept target-owned analyzer
configuration.

The executor analyzes only tracked JavaScript production modules under `bin/`
and `src/`. The package engine contract is exactly
`^22.14.0 || ^24.0.0 || >=26.0.0`; the required validation matrix is Node
22.14.0 and 24.19.0, and Node 25 is explicitly unsupported.

## Objectives

- Enforce the five already-approved rules deterministically, with one ordered
  blocking check per profile architecture condition.
- Use exactly `dependency-cruiser@18.2.0` and its runtime graph packaged with
  this package, through a package-owned content manifest and JSON policy whose
  SHA-256 values are trusted before code is imported.
- Treat unavailable, malformed, incomplete, unsafe, or target-influenced
  analysis as an execution error, never as a pass.
- Keep canonical evidence reproducible, bounded, and free of raw analyzer
  output, graph payloads, command lines, environment values, or target data
  beyond normalized paths and short summaries.

## User-visible contract

`sdd-codegraph run-gates [target] --comparison-base <full-sha>` retains its
shape and result semantics:

| Outcome | Exit code | Meaning |
|---|---:|---|
| `passed` | 0 | Every required executor passed. |
| `failed` | 1 | One or more trustworthy policy violations were found. |
| `blocked` | 2 | Execution was incomplete or untrustworthy. |

Executor statuses remain `pass`, `fail`, `error`, and `not_run`. A
trustworthy architecture violation is `fail`; a precondition, containment,
protocol, analyzer, timeout, output-limit, or execution problem is `error`.
An `error` stops later executors and marks them `not_run`; a `fail` permits
later required executors to run.

The exact package-owned executor allowlist becomes:

1. `javascript_syntax`
2. `node_lint_complexity`
3. `unit_tests`
4. `integration_tests`
5. `coverage`
6. `node_architecture`
7. `governance`
8. `production_dependency_audit`
9. `npm_package_surface`
10. `forbidden_references`

Target configuration may select only this complete allowlist. It cannot
provide a dependency-cruiser configuration, baseline, exception, plugin,
command, executable, version, rule, path, network input, or suppression.

## Approved rule contract

The executor returns five checks in this exact profile order. Each check is
applicable, has `status: pass|fail`, uses `gate_effect: block`, and owns its
evidence. The `check_id` is the existing profile condition.

| Order | Check ID | Rule ID | Requirement |
|---:|---|---|---|
| 1 | `no_production_cycles` | `ARCH-NO-CYCLES-001` | The production graph contains no directed dependency cycle. |
| 2 | `production_must_not_import_tests` | `ARCH-PROD-NO-TEST-001` | A module in `bin/` or `src/` does not depend on a module in `test/`. |
| 3 | `src_must_not_import_bin` | `ARCH-SRC-NO-BIN-001` | A module in `src/` does not depend on a module in `bin/`. |
| 4 | `production_imports_resolve` | `ARCH-IMPORT-RESOLUTION-001` | Every analyzed production import resolves under the pinned analyzer. |
| 5 | `production_must_not_import_dev_dependencies` | `ARCH-PROD-NO-DEV-DEPS-001` | Production code does not import a package declared only in `devDependencies`. |

For the last rule, a package declared in both `dependencies` and
`devDependencies` is not development-only. A target `package.json` is
required and is itself part of the trusted analysis input: missing, malformed,
unsafe, or non-contained manifests block the run rather than changing the
classification.

The executor is `pass` only when all five checks pass, and `fail` when one or
more checks fail. An executor `error` has no `checks` array because a
`pass|fail` check cannot represent an untrustworthy measurement.

## Determinism, containment, and evidence

The production inventory is the package-owned tracked-file inventory matching
`bin/**/*.js` and `src/**/*.js`. An empty inventory is an error. Each listed
path must be a normalized relative path that resolves, after realpath, within
the target root; traversal, absolute paths, backslash variants, missing files,
and symlinks escaping the target are errors. The worker, JSON policy, runtime
content manifest, and complete dependency-cruiser runtime graph are physically
packaged under the installed package root. Before dynamic import, the worker
validates the trusted manifest digest and SHA-256 of every declared runtime
file. It then dynamically imports only the verified contained entry URL. A
consumer's hoisted dependency, override, `cwd`, target, or `PATH` cannot select
the analyzer.

This contract assumes the target and package filesystems are quiescent during a
run. It captures each input's realpath and `dev`, `ino`, `size`, and `mtime_ns`
before use and verifies them again after analysis; any difference is an error.
An attacker able to swap a file and restore the same observable identity and
metadata between checks is a documented residual (swap-back) and is not claimed
as detected.

The worker receives only the target root and this fixed inventory. It invokes
the installed analyzer API through a fixed package-owned entry point, fixed
policy, explicit arguments, and an empty/sanitized environment. It must not
use a shell, `PATH` lookup, `npx`, global installation, target configuration
autodiscovery, target baseline, plugin loading, or network access. The target
is rejected if dependency-cruiser configuration or baseline material could
alter the result. The exact root-only denylist is:

- `.dependency-cruiser.js`, `.dependency-cruiser.cjs`,
  `.dependency-cruiser.json`, `.dependency-cruiser.yaml`,
  `.dependency-cruiser.yml`, `.dependency-cruiser.mjs`;
- `dependency-cruiser.js`, `dependency-cruiser.cjs`,
  `dependency-cruiser.json`, `dependency-cruiser.yaml`,
  `dependency-cruiser.yml`, `dependency-cruiser.mjs`;
- `.dependency-cruiser-known-violations.json` and
  `dependency-cruiser-known-violations.json`; and
- root `package.json` keys `dependency-cruiser` and `dependencyCruiser`.

Every listed filesystem entry is rejected if it exists, including a symlink,
directory, or non-regular file; it is checked before analysis and never read.
No other glob or near-match is denied by this contract (for example,
`dependency-cruiser.local.json` is permitted).

The fixed policy enables analyzer validation and contains exactly five rules:
production `from.path` `^(bin|src)/` for checks 1, 2, 4, and 5; `src`-only
`from.path` `^src/` for check 3; and, respectively, `to.circular: true`,
`to.path: ^test/`, `to.path: ^bin/`, `to.couldNotResolve: true`, and
`to.dependencyTypes: ["npm-dev"]`. Altering any literal, order, or policy
shape blocks the run rather than weakening a rule.

The runtime bundle is committed at `vendor/node-architecture-runtime/`; its
committed manifest is
`governance/adapters/v1/node-dependency-cruiser-runtime-manifest.json`.
`scripts/generate-node-architecture-runtime.js` derives it only from the local
lockfile installation produced by `npm ci --offline --ignore-scripts`, with no
network or lifecycle hook. `scripts/verify-node-architecture-runtime.js`
regenerates in a temporary directory and byte-compares paths, ordering, bytes,
manifest, licenses, and `NOTICE.md`; `npm pack --ignore-scripts` must contain
the same assets. Missing/mismatched third-party license inventory or required
license text is an error.

The executor rejects an analysis before it begins when any approved resource
limit is exceeded: target manifest over 1 MiB; more than 10,000 tracked input
files across production and test inventories; a source file over 2 MiB; more
than 64 MiB across those files; 20,000 graph modules; or 100,000 graph edges.
The worker is started with a 256 MiB heap cap and it does not follow internals
of external dependencies. A limit is an `error`, never a truncated pass/fail.

The worker-to-adapter report is an internal strict JSON protocol. It identifies
the protocol version, analyzer identity/version, fixed policy digest, analyzed
files, full per-rule violation totals, and only normalized bounded findings.
Unknown fields, wrong keys, wrong versions, wrong digest, duplicate or unsafe
paths, count/detail disagreement, unexpected rule/check identity, or invalid
ordering make the result an `error`.

For each rule, the adapter emits one deterministic summary evidence item and
at most 20 normalized detail evidence items, ordered canonically. Full totals
remain in the summary even when details are capped. Details use the existing
evidence schema (`location`, `summary`, and `check_id` linked to the rule); no
schema extension is introduced. Evidence must be sorted before IDs are
assigned. Potentially unsafe text is redacted or replaced with a stable safe
summary.

A reported directed cycle is canonicalized by rotating it to the
lexicographically smallest module path without reversing its direction. Equal
cycles are deduplicated and the canonical representations are sorted. A
one-module self-loop is a valid directed cycle, represented by that path once,
and produces the normal cycle-rule `fail`, not an executor `error`. This
makes equivalent analyzer output reproducible across traversal order.

## Acceptance criteria

- `dependency-cruiser@18.2.0` and its complete runtime graph are packaged
  under this package; the trusted content-manifest digest and every runtime
  file SHA-256 are verified before its contained entry is dynamically imported.
- The fixed policy invokes dependency-cruiser with validation enabled and the
  five exact approved literals; trust validation and real semantic fixtures
  reject every changed policy literal, order, or rule shape.
- The committed runtime bundle, manifest, generator, verifier, third-party
  package/version/license inventory, and required license texts are
  deterministically regenerated from the local lockfile installation, then
  byte-compared and included by `npm pack --ignore-scripts`. The future root
  `NOTICE.md` describes these bundled third-party notices and is not a
  CodeGraph artifact.
- The registry, configuration, runtime allowlist, schema validation, trust
  bindings, package surface, and run result require exactly ten executors with
  `node_architecture` sixth and its five exact rule IDs in profile order.
- The architecture executor evaluates only the fixed tracked `bin/` and
  `src/` production inventory and a separately bounded tracked `test/`
  inventory used only to validate test targets; missing target manifest or
  empty production inventory is `error`.
- Each individual approved violation produces a blocking `fail`, with all five
  checks present in fixed order and correctly linked evidence.
- A production cycle, production-to-test dependency, `src`-to-`bin`
  dependency, unresolved production import, and dev-only package import are
  each detected by an independent integration fixture.
- Cycles and all other details remain byte-for-byte stable when the analyzer
  returns equivalent violations in a different order. At most 20 details per
  rule are emitted while the summary retains the true total.
- A target-owned dependency-cruiser configuration or baseline, analyzer
  absence/version mismatch, malformed worker output, unexpected report field,
  wrong policy digest, timeout, output overflow, signal, unsafe inventory
  path, symlink escape, missing manifest, malformed manifest, local resolution
  outside target, or empty production scope returns `error` and blocks later
  executors.
- Each denylisted root entry (the fourteen exact dependency-cruiser names) is
  rejected even when it is a symlink, directory, or other non-regular file;
  only the two listed package keys are rejected, and near-matches remain
  permitted.
- The manifest/input/graph/heap bounds are enforced before or during analysis
  without truncation. Pre/post identity checks detect observable input changes;
  the swap-back filesystem residual is documented rather than treated as proof
  of immutable storage.
- The adapter never records raw subprocess output, unbounded graph data,
  analyzer configuration, arbitrary errors, or secret-bearing target text in
  canonical evidence.
- The result is valid in source, project-local, global, and packed-consumer
  installations, including a packed-consumer fixture proving that a hoisted or
  overridden consumer dependency cannot replace the packaged verified runtime,
  on Node 22.14.0 and 24.19.0. The declared engine accepts Node
  22.14+, Node 24+, and Node 26+ as stated above; Node 25 must be rejected.
  Green CI alone is not proof of these semantic fixtures; the specified
  deterministic tests are required.

## Use cases

### Compliant production graph

Given a target with a contained manifest, non-empty tracked production
inventory, package-owned analyzer policy, and no violations, when `run-gates`
runs, then `node_architecture` passes with the five ordered passing checks and
bounded summary evidence.

### Architectural violation

Given a valid target whose production graph contains one of the five forbidden
relationships, when the executor runs, then that check and the executor fail,
all applicable checks remain reported in their fixed order, and later required
executors continue.

### Untrustworthy analysis input or execution

Given a missing/malformed manifest, empty production scope, unsafe path,
escaping symlink, target-owned analyzer config/baseline, wrong package-owned
asset, analyzer protocol/version/digest mismatch, timeout, signal, or output
overflow, when the executor runs, then it returns `error`, the run becomes
`blocked`, and subsequent executors are `not_run`.

### Large violation set

Given more than 20 violations for one rule, when evidence is emitted, then
the result reports the exact violation total and only the first 20 canonical
details for that rule. Reordering equivalent analyzer output cannot alter the
result.
