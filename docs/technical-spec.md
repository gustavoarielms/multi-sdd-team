# Technical Specification — Issue #11: Node test and coverage enforcement

## Proposed architecture

The Node adapter gains three package-owned executors: `unit_tests`,
`integration_tests`, and `coverage`. They are registered in the approved
nine-executor order and invoked by the existing `run-gates` orchestration and
canonical-result pipeline. The CLI command shape, aggregate outcomes, and exit
codes are unchanged.

Each suite executor starts the supported Node test runner through fixed argument
arrays and `process.execPath`; it does not use a shell. A package-owned ESM
reporter receives the test-runner event stream and emits one bounded JSON result
for the adapter to validate. The reporter's result is evidence, not target
configuration.

The runner hosts each package-owned executor in its own package-owned process
boundary and owns an `AbortController` inside that boundary. The suite or
coverage adapter passes the same `AbortSignal` to its bounded subprocess
operation. On timeout, the runner first asks the boundary to abort; the adapter
captures the direct child and observable descendants, freezes that owned tree,
revalidates each PID against its start time, session, and process group before
signalling it, awaits verified termination, removes every temporary directory
it created, and resolves only
after cleanup. The runner awaits that resolution before serializing the
executor `error` or marking later executors `not_run`. If the executor does not
cooperate, a second package-owned bound forcibly terminates and verifies the
executor boundary before the runner emits its timeout result. Process-tree
termination is idempotent, including a child that exits before abort, and it
must not affect processes outside that executor.

Every POSIX bounded command first starts a package-owned supervisor that cannot
launch the requested executable until the worker sends its full stable process
identity and receives an explicit acknowledgement from the outer boundary.
The boundary stores the identity before acknowledging it. A lost, delayed, or
rejected registration therefore leaves the executable unstarted; worker IPC
disconnect makes the supervisor terminate any locally retained command before
it exits. Bare PIDs are rejected. An unregister applies only after verified
cleanup and only to the same identity, and stale unregister requests are
negatively acknowledged, so a stale message cannot remove a newer reused PID.
A final-kill budget is reserved before any
`SIGSTOP`; captured descendants are revalidated and receive best-effort
`SIGKILL` on every later failure. Identities whose cleanup cannot be verified
remain registered for the outer boundary to retry. Forced
termination drains that registry, terminates and verifies each still-matching
owned tree, terminates and verifies the worker boundary, drains the registry
once more, disconnects the owned IPC channel, and settles
independently of delayed or missing `close` delivery. Windows invokes the
If the first registry drain during normal worker finalization fails,
`disconnect`, `exit`, and `close` share one idempotent full-termination
sequence: the worker is terminated, retained identities are retried by the
second drain, and no result becomes observable until that sequence completes.
Windows invokes the
package-owned `taskkill.exe /t /f` tree operation only while the direct worker
or command still has a retained live `ChildProcess` handle; transmitted child
registrations never authorize Windows tree termination. A stale or synthetic
PID therefore fails closed without invoking `taskkill`. The operation is
followed by bounded `tasklist.exe` absence verification. One monotonic cleanup
deadline is passed through inventory reads, `ps`/`tasklist`, termination,
polling, and final verification; exhaustion fails closed as
`COMMAND_TERMINATION_FAILED`.

On Windows the supervisor retains the command's live `ChildProcess` handle and
uses `/T` cleanup if the worker IPC channel disconnects. Without a Windows Job
Object, the fallback still cannot recover a tree if both the worker and
supervisor handles have already observed exit before cleanup. That path fails
closed without signalling a reusable PID; it does not claim that descendants
of those exited processes were contained. Kill-on-close coverage for that case
requires a separately approved native Job Object boundary.

Portable Node process APIs do not provide a non-escapable OS containment object
on every supported platform. The POSIX fallback therefore proves cleanup for
descendants still observable through ancestry when inventory starts, including
a direct `detached`/`unref` child. It does not claim containment for a process
that double-forks and is reparented before that first bounded inventory. Closing
that residual adversarial case requires a Linux cgroup, Windows Job Object, and
a separately approved macOS containment mechanism; none is assumed available
or writable by this package.

The coverage executor starts c8 through its installed package asset, also via
`process.execPath` and fixed arguments. `c8@12.0.0` and
`istanbul-lib-coverage@3.2.2` are direct exact package dependencies. There is
no `npx`, network resolution, global tool lookup, or `PATH`-selected binary.

## Components

| Component | Responsibility |
|---|---|
| Suite layout and package scripts | Define disjoint `test/unit/` and `test/integration/` roots; expose `test:unit`, `test:integration`, and sequential `test`. |
| Suite adapter | Validates suite discovery and reporter output; classifies assertion failures as `fail` and untrustworthy execution as `error`. |
| Package-owned ESM reporter | Produces a single bounded JSON summary from Node test events, including counts needed to reject skipped, todo, absent, or inconsistent runs. |
| Coverage adapter | Runs unit and integration coverage independently, validates each Istanbul map, combines them, selects the approved production scopes, and evaluates counts. |
| Changed/new selector | Resolves comparison SHA to merge base and derives production paths from committed, staged, unstaged, and non-ignored untracked state. |
| Gate registry, schema, and trust bindings | Replace `test_suite` with the three approved executors; enforce exact order, rule bindings, result shape, bounded evidence, and fail-closed limits. |
| Package, CI, and distribution checks | Ship the reporter and adapter; install exact dependencies; verify source, local, global, and packed execution on both supported Node versions. |

## Contracts

### Test-suite contract

`test/unit/**/*.test.js` and `test/integration/**/*.test.js` are the canonical
suite roots. Each invocation must discover at least one test and complete with
no skipped or todo tests. A test-runner assertion failure with a valid summary
is a functional `fail`. A missing root, zero tests, discovery mismatch,
skipped/todo result, malformed reporter JSON, spawn failure, parser failure,
timeout, output overflow, or impossible counts is an `error`.

The reporter JSON is an internal package contract. It must be strict and
bounded: schema/version marker, suite identity, summary counts, normalized
status, and bounded failure metadata only. It must reject unknown or
inconsistent values and must never serialize raw child output, source text,
environment, trace data, or arbitrary error payloads.

### Coverage contract

Coverage runs once per suite in separate temporary directories and emits two
Istanbul maps. The adapter validates map structure and production-file
containment before combining maps with `istanbul-lib-coverage`. `--all` is
applied to the exact `bin/**/*.js` and `src/**/*.js` production inventory.
Empty production denominators and malformed, missing, unsafe, or irreconcilable
maps are errors.

For lines, branches, functions, and statements, the adapter uses item counts,
including every individual branch alternative. A threshold passes exactly when:

```
covered * 100 >= threshold * total
```

This applies separately to repository-wide `85/80/85/85` and changed/new
`90/85/90/90` checks, in lines/branches/functions/statements order. Evidence
must report those checks separately and include only the necessary normalized
counts and decision.

The effective comparison base is the merge base of the required full SHA and
the current target revision. Selection includes committed, staged, and unstaged
changes; a new file is selected in full; deleted files are excluded; and a
rename is evaluated at its final path. A non-ignored untracked production file
is selected in full for changed/new coverage but remains outside global
coverage until tracked. An unavailable, non-full, invalid, or untrustworthy
base is an `error`.

The coverage executor has exactly two checks in this exact order:

| Order | Check ID | Rule ID | Applicable result | Not-applicable result |
|---:|---|---|---|---|
| 1 | `coverage_global` | `TEST-COVERAGE-GLOBAL-001` | `pass` or `fail`, `gate_effect: block` | Not permitted: global coverage is always applicable. |
| 2 | `coverage_changed` | `TEST-COVERAGE-CHANGED-001` | `pass` or `fail`, `gate_effect: block` | `status: pass`, `gate_effect: none`, with its sole check-owned evidence `outcome: not_applicable`. |

Each check owns distinct evidence IDs; those IDs must reference evidence whose
`check_id` equals that check ID. The executor's `evidence_ids` is the ordered
deduplicated union of its check evidence IDs. The executor status is `fail` if
either applicable check fails, otherwise `pass`. A coverage precondition or
execution error produces executor `error` and no `checks` array, because
`pass|fail` checks cannot represent an untrustworthy measurement. Existing
governance executor checks retain their current IDs, order, ownership, and
outcomes; coverage adds no governance check and does not reorder them.

### Configuration and suppression contract

Target-owned coverage configuration is disabled. Before invoking coverage, the
adapter rejects `.c8rc*`, `.nycrc*`, and `package.json` properties named `c8`
or `nyc`. It also scans the exact production inventory and rejects inline
`c8`, `istanbul`, or `nyc` ignore directives. Rejection is fail-closed:
coverage returns `error` and subsequent executors are `not_run`.

### Gate and CLI contract

The registry accepts precisely these nine executors in this order:
`javascript_syntax`, `node_lint_complexity`, `unit_tests`,
`integration_tests`, `coverage`, `governance`,
`production_dependency_audit`, `npm_package_surface`, and
`forbidden_references`.

The only public result statuses stay `pass|fail|error|not_run`; aggregate
outcomes stay `passed|failed|blocked`; exit codes stay `0|1|2`. `run-gates`
emits one canonical JSON document. `--comparison-base` stays mandatory for
this quality profile and must be a full SHA. No new command is introduced.

Runtime executor overrides are rejected fail-closed. The in-process executor
hook is explicitly test-only and is not part of the runner contract; only the
package-owned executor process boundary carries timeout and forced-termination
guarantees.

### Historical test-suite rule lifecycle

`ENG-TEST-SUITE-001` is retained for audit history but is no longer an active
Node v1 policy. Its catalog entry changes to `status: deprecated`, increments
its rule version, and uses `enforcement: { mode: human_review, gate_effect:
none }` with no `automation` member. It is removed from the engineering gate
registry and from `CANONICAL_ENGINEERING_GATE_BINDINGS`; `test_suite` is
removed with it. It is not replaced by an alias or compatibility executor.

`TEST-UNIT-SUITE-001`, `TEST-INTEGRATION-SUITE-001`,
`TEST-COVERAGE-GLOBAL-001`, and `TEST-COVERAGE-CHANGED-001` are the active
approved Node v1 rules, bound respectively to `unit_tests`,
`integration_tests`, `coverage_global`, and `coverage_changed`.

Catalog validation must reject a deprecated rule that has deterministic
automation, a gate effect other than `none`, an engineering-registry binding,
or an entry in the approved-rule trust set. It must also reject any approved
deterministic rule whose automation does not resolve to a current registry or
quality-profile binding. The validator's canonical bindings, the approved-rule
trust map, and their content digests are regenerated from this exact lifecycle:
the legacy rule is removed from active trust, the nine executor bindings are
trusted in order, and every retained or changed approved rule/profile digest is
updated to the shipped content. The profile digest recorded in a run must equal
the trusted digest; a stale installer/global/project copy therefore blocks.

## Implementation matrix guard

The test move must be mechanical and protected by a single explicit inventory
guard. It asserts the 17-unit list in the functional specification, its exact
72-test complement as integration, and a total of 89 unique names.

The 72 integration tests include all test names not in that unit list. This
explicitly includes the following governance-schema integration tests:

- `all governance schemas compile in strict Draft 2020-12 mode`
- `canonical Engineering Quality Profile v1 is strict, approved, and trust-bound`
- `governance examples satisfy their schemas and cross-reference integrity`

The guard must run from the discovered suite files rather than relying solely
on an expected file count. The resulting layout is five unit files and six
integration files (eleven total), with
`node-lint-complexity-distribution.test.js` wholly in integration.

## Risks and controls

| Risk | Control |
|---|---|
| Node 22 and 24 V8 branch accounting differs | Run the same full contract on Node 22.14.0 and 24.19.0; do not weaken thresholds or introduce ignores. |
| A child process survives the existing watchdog | `runExecutorWithTimeout` aborts through an `AbortSignal`; a command supervisor waits for durable ownership acknowledgement before launch and cleans up on worker disconnect; adapters freeze the observable owned tree, revalidate stable identities before signalling, await bounded verification, then settle. Test lost and delayed registration, detached direct descendants, and the outer-timeout race; retain the documented pre-inventory reparenting limit. |
| Target input changes analyzer behavior | Use trusted package assets, empty/sanitized child environment, fixed args without shell, real-path containment, and rejected target configuration/suppressions. |
| Large or sensitive tool output enters canonical JSON | Bound stdout/stderr and normalize only allowed reason codes, counts, locations, summaries, and redaction metadata. |
| Changed/new selection is incomplete | Use full SHA plus merge base and reconcile committed, index, working tree, renames, and eligible untracked production paths. |
| First real measurement misses policy | Add only relevant tests; do not lower thresholds, add a baseline, or add suppression. |

## Verification

Verification must cover all of the following:

- the 17/72/89 classification guard and no skipped, todo, `only`, duplication,
  or loss;
- `npm run test:unit`, `npm run test:integration`, `npm test`, `npm run check`,
  governance validation, and the complete `run-gates` flow;
- unit-pass/integration-fail and global-pass/changed-new-fail fixtures;
- missing/empty suite, malformed reporter or map, invalid/absent base,
  suppression/configuration, unsafe path or symlink, timeout, and overflow
  paths;
- propagated abort from `runExecutorWithTimeout` through suite/coverage
  adapters, child-tree termination, cleanup completion, already-exited child,
  and the race where the outer timeout fires while cleanup is pending;
- exact ordered coverage checks, their rule/evidence ownership, aggregation,
  `coverage_global` failure, `coverage_changed` failure, and the canonical
  changed/new `not_applicable` representation;
- deprecated `ENG-TEST-SUITE-001` lifecycle: no active registry/profile/trust
  binding, validator rejection of an active orphan, and trusted digest parity
  after source, project-local, global, and packed installation;
- global and changed/new count decisions, including new, deleted, renamed, and
  untracked production files;
- source checkout, project-local install, global install, and `npm pack`
  consumer smoke paths;
- Node 22.14.0 and Node 24.19.0 CI execution.

No implementation may claim the coverage thresholds pass until those real
measurements complete in both supported Node versions.
