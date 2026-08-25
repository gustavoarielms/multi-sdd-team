# Functional Specification — Issue #11: test suites and coverage gates

## Scope

This change makes the approved Engineering Quality Profile test and coverage
requirements executable for the Node adapter. It reorganizes the existing test
inventory into explicit unit and integration suites, adds deterministic coverage
evaluation, and replaces the single `test_suite` engineering-gate executor with
separate suite and coverage executors.

The scope is limited to the Node 22.14.0 and 24.19.0 supported runtimes. It
does not change the public CLI command names, the aggregate outcomes, or process
exit meanings.

## Objectives

- Preserve every one of the 89 existing tests exactly once: 17 unit tests and
  72 integration tests.
- Make `npm run test:unit` run only the required unit suite, `npm run
  test:integration` run only the required integration suite, and `npm test`
  run both suites sequentially.
- Make a missing, empty, undiscovered, skipped, todo, or irreconcilable suite a
  trustworthy-execution error, not a passing result.
- Measure unit and integration coverage separately, combine their Istanbul
  coverage maps, and evaluate global and changed/new production coverage using
  exact item counts.
- Keep deterministic gate results bounded and machine-readable across source,
  project-local installation, global installation, and packed-consumer use.

## User-visible contract

`sdd-codegraph run-gates [target] --comparison-base <full-sha>` keeps its
current CLI shape. Its canonical JSON and aggregate meanings remain:

| Outcome | Exit code | Meaning |
|---|---:|---|
| `passed` | 0 | Every executed required gate passed. |
| `failed` | 1 | A trustworthy functional rule failure was found. |
| `blocked` | 2 | Execution was incomplete or untrustworthy. |

Executor status remains `pass`, `fail`, `error`, or `not_run`. An `error`
stops later executors, which are reported as `not_run`; a trustworthy `fail`
does not conceal later trustworthy failures.

An executor is not settled merely because its timeout has fired. The runner
propagates cancellation to the executor and the executor propagates it to every
child process it started. Only after those processes have exited and owned
temporary resources have been cleaned may the runner emit that executor's
`error` and mark later executors `not_run`.

The exact ordered executor allowlist becomes:

1. `javascript_syntax`
2. `node_lint_complexity`
3. `unit_tests`
4. `integration_tests`
5. `coverage`
6. `governance`
7. `production_dependency_audit`
8. `npm_package_surface`
9. `forbidden_references`

Target configuration continues to select only this complete package-owned
allowlist. It cannot provide commands, plugins, thresholds, baselines,
exceptions, or coverage configuration.

## Acceptance criteria

- The suite inventory guard proves `17 + 72 = 89`, with no duplicate or
  unclassified test name.
- Unit and integration test roots are explicit, disjoint, present, and
  non-empty. The test runner is invoked once for each suite.
- A unit failure or integration failure produces the corresponding executor
  `fail`; suite discovery, runner, parser, timeout, output-overflow, skipped,
  todo, or inconsistent-result problems produce `error`.
- Coverage is collected with package-owned exact dependencies
  `c8@12.0.0` and `istanbul-lib-coverage@3.2.2`; no runtime download, `npx`,
  shell command, or `PATH` selection is permitted.
- The coverage executor evaluates the union of separate unit and integration
  Istanbul maps with `--all` over the exact production inventory.
- Global thresholds are lines 85, branches 80, functions 85, and statements
  85. Changed/new thresholds are 90, 85, 90, and 90 respectively. Each check
  uses `covered * 100 >= threshold * total`, never a rounded percentage.
- `--comparison-base` is a required full commit SHA. The effective base is its
  deterministic merge base. Changed/new scope contains committed, staged, and
  unstaged changes; complete new files; and non-ignored untracked production
  files. Deleted files are excluded and renames use the final path.
- An untracked production file participates fully in changed/new coverage but
  is excluded from the global denominator until it is tracked.
- `.c8rc*`, `.nycrc*`, `package.json` `c8`/`nyc` configuration, and inline
  `c8`, `istanbul`, or `nyc` ignore directives are rejected fail-closed.
- Evidence contains only normalized statuses, counts, bounded locations,
  reason codes, summaries, and redaction metadata; it does not contain raw
  child output or coverage payloads.
- The contract passes in source, project-local, global, and packed-consumer
  installations on Node 22.14.0 and 24.19.0.
- A runner timeout must cancel the suite or coverage adapter, terminate its
  child process tree, await process exit and temporary-directory cleanup, and
  only then emit the terminal executor result. This outer-timeout race is a
  required test case.
- `ENG-TEST-SUITE-001` remains in the catalog only as a deprecated historical
  rule with no active automation or gate effect. It is not bound by `node-v1`,
  not present in the engineering executor registry, and not treated as an
  approved rule by governance validation or trust bindings.
- The coverage executor contains exactly two ordered checks: `coverage_global`
  for `TEST-COVERAGE-GLOBAL-001`, then `coverage_changed` for
  `TEST-COVERAGE-CHANGED-001`. Each applicable check is `pass` or `fail` with
  blocking effect. With no applicable changed/new production items,
  `coverage_changed` is canonically `pass` with gate effect `none` and owned
  evidence outcome `not_applicable`; `coverage_global` is always applicable.

## Use cases

### Successful suite and coverage run

Given a target with the exact gate configuration, two populated suites, a
valid full comparison SHA, and coverage satisfying both threshold groups, when
the user runs `run-gates`, then unit, integration, and coverage executors pass
and the command emits one canonical `passed` document with exit 0.

### A trustworthy test assertion failure

Given a valid unit or integration invocation whose test runner reports an
assertion failure, when its executor runs, then it reports `fail`, preserves
the stable aggregate semantics, and the final exit is 1 unless a later executor
error blocks the run.

### New code misses coverage

Given global coverage that passes but changed/new coverage below an approved
threshold, when coverage is evaluated, then the coverage executor fails and
its bounded evidence distinguishes the global and changed/new checks.

### Untrustworthy analysis input

Given a missing or invalid comparison base, forbidden coverage configuration or
suppression, unsafe path, timeout, overflow, malformed map, or irreconcilable
test result, when the relevant executor runs, then it returns `error`, the run
is `blocked` with exit 2, and remaining executors are `not_run`.

### No changed production items

Given a valid comparison base and no changed/new production coverage items,
when coverage is evaluated, then `coverage_global` is evaluated normally and
`coverage_changed` is recorded as `pass` with gate effect `none`; its only
applicability evidence has outcome `not_applicable`. The coverage executor
passes if, and only if, the global check passes.

## Test classification matrix and cardinality guard

The following are the only unit tests (17). The implementation must assert this
set and classify every other current inventory test as integration (72).

| Source inventory | Unit test name |
|---|---|
| `engineering-gates.test.js` | engineering gate configuration is strict and requires the exact executor allowlist |
| `governance-checks.test.js` | a warning governance failure remains non-blocking |
| `governance-schema.test.js` | candidate, unverified, or unreproduced findings cannot recommend a blocking gate effect |
| `governance-schema.test.js` | a passing gate cannot retain blocking findings |
| `governance-schema.test.js` | a gate cannot pass by omitting an eligible blocking finding |
| `governance-schema.test.js` | approved rules and exceptions require human authority |
| `governance-schema.test.js` | evidence rejects raw output fields and inconsistent redaction metadata |
| `governance-schema.test.js` | pure JSON parser rejects markdown fences and surrounding prose |
| `governance-schema.test.js` | review validation rejects role, non-Codex runtime, gate count, and reference mismatches |
| `governance-schema.test.js` | validation errors do not echo rejected payload values |
| `governance-schema.test.js` | catalog integrity rejects invalid documents, duplicate rules, proposed blocks, missing human approval, and orphan checks |
| `governance-schema.test.js` | deterministic check results require bounded evidence linked to rule and check |
| `installer.test.js` | mergeManagedBlock preserves unmanaged content and replaces the managed block |
| `installer.test.js` | setTomlKey preserves unrelated settings |
| `installer.test.js` | syncCodeGraph initializes a new project |
| `installer.test.js` | checkCodeGraph rejects pending changes |
| `node-lint-complexity-adapter.test.js` | the package-owned policy fixes exact recommended errors and classic complexity |

In particular, these three `governance-schema` tests are integration tests,
not unit tests: `all governance schemas compile in strict Draft 2020-12 mode`,
`canonical Engineering Quality Profile v1 is strict, approved, and
trust-bound`, and `governance examples satisfy their schemas and
cross-reference integrity`.

The cardinality guard must verify the approved 17-name set, that its complement
contains 72 tests, and that the two sets are disjoint with a combined total of
89. It must fail when a test is lost, duplicated, renamed without the matrix
being updated, or left unclassified.
