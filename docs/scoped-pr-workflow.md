# Scoped implementation, PR review, and human merge

## Approval and status

On 2026-10-14, the repository owner approved defining this workflow, adapting
repository policy, and verifying the review mechanism while retaining explicit
human approval for integration. The supplied approval evidence is retained in
the private task dossier. Its original message time was not independently
verified.

This local package-policy adaptation defines the intended workflow. It does not
implement a scheduler, enable a launcher, install managed prompts, or attest a
review runtime. The present task permits local policy/documentation preparation
only: no commit, push, PR, comments, merge, or auto-merge. The proposed exception
authorizing those assistant delivery actions was not recorded as granted for
this task. Approval of the framework is distinct from authorization to execute
it on a particular change.

## MVP decision — 2026-10-15

On 2026-10-15, the repository owner explicitly deferred technical reviewer-
permission separation for this MVP. Available tools may permit modifications
while reviewer instructions prohibit them, with deviations examined afterwards.
Approval evidence is retained in the private task dossier under project decision
`instruction-review-mvp-2026-10-15`. It was recorded at
`2026-10-15T15:30:45Z`; that is not asserted as the original message time.
This decision identifier is a project reference, not a public approval record.

This supersedes the earlier requirement to establish technical reviewer
separation before a source-repository MVP review. It is a product-policy choice,
not a platform permission override or an attestation. It covers native Codex
review of this source repository without installed managed prompts. Managed
consumer workflows, installed-prompt immutability, the disabled launcher and
its fail-closed checks remain unchanged. Independent review remains automatic
agent work; it is not reassigned to the human who approves merge.

`GOV-REVIEW-REPORTONLY-001` version 3 and
`GOV-MANAGED-PROMPT-PROTECTION-001` version 2 record that distinction with new
approval references and trust digests. Their schema version, IDs, check bindings
and blocking effects stay unchanged. The v1 result schemas and all other rule
content remain unchanged. A successful source governance check verifies static
declarations, not a reviewer runtime or its observed behavior.

## Intended workflow

| Step | Required input and allowed action | Exit evidence |
|---|---|---|
| Authorize scope | Record repository, target branch, included work, acceptance criteria, applicable gates, and permission for commit, push, PR, review requests, and corrections. Record existing local work to preserve. | Human decision and explicit exclusions; no implied merge permission. |
| Verify review route | Identify independent ownership, frozen input, available capabilities and output contract. For this source MVP, use the instruction-based procedure below; managed-runtime reviews still require containment/protected prompts. | Explicit mode and before-state evidence; no isolation claim for the MVP. |
| Implement | Complete the approved scope with applicable design review first and TDD where required. | Scoped diff and test evidence; unrelated work preserved. |
| Check | Run applicable deterministic controls on the identified snapshot, preserving actual outcomes and full comparison base. | Passing required checks for the snapshot; failed, invalid, unresolved, or unrun gates remain blocking. |
| Prepare PR | When explicitly covered by the task authorization, commit only owned approved changes on a topic branch, push, and open/update a draft PR carrying the checked SHA and evidence. | PR URL, base/head SHAs, check results, remaining reviews, and scope. This transports work for review; it does not complete the task. |
| Review | Invoke the selected permitted mode on the frozen version; compare before/after state before accepting the report. Preserve required architecture, quality, and security gates and validate their original JSON handoffs. | Valid envelopes with passing decisions and no unresolved blocking findings. A GitHub comment or approval alone cannot replace them. |
| Correct and revalidate | Return findings to the implementation owner; correct within scope, rerun affected checks, commit/push the authorized corrections, and have the originating reviewer revalidate the new SHA. | Trace from each finding to correction and fresh review. If the reviewer is unavailable, the gate stays pending. |
| Hand off | After all applicable gates and current PR checks pass, present the final SHA, diff, findings, evidence, and limitations for human integration. | Ready for human merge; no claim of merge, deployment, release, or acceptance. |
| Merge | Require explicit human approval of the identified PR and final SHA. Recheck SHA and gates immediately before any separately authorized merge. | Human decision plus actual merge evidence, or remain pending. Never enable auto-merge. |

The approved delivery cycle needs no repeated permission requests for its routine
steps. Pause for scope changes, new credentials, expanded access, costs,
infrastructure, or material decisions. An existing failure cannot be relabeled
as a pass to reach PR publication. Publishing a blocked diagnostic snapshot
requires distinct authorization and must describe its failed/pending gates.

The v3 pipeline retains its stage identifiers, actors, conditions, and dependency
edges. PR transport is described here rather than added as a falsely implemented
executor. `main_integrate` assembles a handoff after applicable gates; it is not
a Git merge. Its static validator does not enforce remote permissions, schedule
reviews, or prove that a human approved a merge.

## Capabilities checked on 2026-10-14

| Surface | Observed evidence | Limit |
|---|---|---|
| Local copy | The verified source checkout exists; `origin` is `https://github.com/gustavoarielms/multi-sdd-team.git`; branch `main`, HEAD `5680a53b152f9d66b507bf88a8447b400cbc6d27`; existing modified and untracked files. | Separate checkout is not runtime containment. No project `.codex` installation exists here. No reset, checkout replacement, or installation was performed. |
| Package reviewer | `codex/agents/tester-reviewer.toml` declares `:read-only`, report-only behavior, and a Codex v1 quality JSON handoff. Architecture/security reviewers use the corresponding governed contracts. | Declarations are not proof of effective filesystem, process, tool, or credential restrictions. No reviewer was launched. |
| Launcher | `src/app-server-broker.js:launchBrokerTurn` returns disabled/untrusted with `BROKER_PROCESS_CONTAINMENT_UNAVAILABLE` in production. The only positive branch requires test hooks. Issue #18 documents Task 4 as pending. | No production review route is established. Test hooks must not be used to obtain a review. Docker executable presence is not a verified runtime. |
| Codex private review | The exposed private-review operation can save a pinned review report in a dedicated PR review chat; it does not itself post to GitHub. | No runtime attestation or effective permission evidence was supplied. It was not invoked here and cannot be treated as the governed review gate. |
| GitHub connector and CLI | Read-only identity queries both return `gustavoarielms`; repository metadata reports pull/push/admin/maintain/triage and collaborator permission `admin`. Review submission/request tools are exposed. | These are account permissions and API surfaces, not verified successful writes, isolated reviewer authority, or task authorization. No write was attempted. |
| Plugin action policy | GitHub inherits the default “Allow low-risk actions”. | A platform action policy does not reduce the account to read-only or grant task-specific publication authority. |
| Remote controls | Active ruleset `20870381`, “Protect main with Codex-only CI”, targets the default branch, has no bypass actors, prohibits deletion/non-fast-forward changes, requires PR and strict checks `Node 22.14.0`, `Node 24.19.0`, `Policy and package`. | Required approving review count is 0; last-push approval and thread resolution are false; stale reviews are not dismissed on push. Classic branch-protection endpoint returns “Branch not protected”, but the ruleset is active. |
| CI and merge | Actions enabled; checked-in CI uses `contents: read` and checkout with `persist-credentials: false`; repository `allow_auto_merge` is false. | CI runs deterministic checks, not an independent agent review. This configuration alone does not enforce explicit human merge approval. No configuration was changed. |

The capability table above records the 2026-10-14 inspection, before the MVP
decision. The managed launcher is still blocked; the earlier prerequisite of
technical separation no longer applies to the explicitly scoped source MVP.
Inherited tools or account authority do not authorize the reviewer to mutate.
No new credentials, access changes, costs, infrastructure, or remote protection
changes are approved. The native tool route below is a procedural review route,
not a replacement attestation for the disabled managed runtime.

## Concrete MVP execution route

After this preparation is delivered and a review is explicitly requested, the
main session can invoke one native Codex reviewer task through the available
subagent mechanism, as `tester_reviewer` by assignment. Supply the full
`developer_instructions` from [the source prompt](../codex/agents/tester-reviewer.toml)
as task instructions with the handoff below. The native spawn surface is not
assumed to select that TOML, model or permission profile automatically. Capture
the actual reviewer identity and available tool behavior. Do not fork an
implementer's reasoning history as review evidence; provide the scoped inputs.

Use the current platform's permissions without escalation or tool-based bypass.
Do not invoke `sdd-codegraph launch`, `init`, `update`, a CLI workaround or a
test-hook launch. Do not change installed `.codex/agents`. If the native task
surface is unavailable or platform permission is denied, report that concrete
blocker. Deferring isolation is not a reason to defeat a platform restriction.

The reviewer returns the original v1 quality JSON. The main session captures
the after-state, checks stability, then runs
`node bin/sdd-codegraph.js validate-result <report-path> --agent tester_reviewer`
from the source repository. Keep the report outside the target. An invalid
envelope returns to its producer; no main-session repair or invented review.
A quality review can examine relevant architecture/security risks but cannot
replace a separately required architecture or security gate. Record such a
gate as pending and do not add agents without authorization.

### Mandatory task handoff

Supply concrete values, not unresolved placeholders:

- Task ID, mode `instruction-based-source-review`, repository/canonical path,
  reviewer role, implementation owner and approved acceptance criteria.
- Base/head SHA and PR URL/number if available; otherwise explicitly local-only.
  Include all local staged/unstaged changes and new non-ignored files in the
  identified manifest. State which previous local changes are context only.
- Included/excluded paths, allowed context, approved rules/catalog version,
  applicable gate decisions and schema location with relative references.
- Before-state artifact locations/digests, capture timestamps, known ignored
  output areas, evidence of tests/checks with their actual snapshots and limits,
  and prior finding IDs for revalidation.
- Exact non-mutating commands allowed, if any. Default to existing evidence and
  reading source. Ask the implementation owner to run tests that could write
  files, update snapshots, build outputs, invoke hooks or contact services.
- Confirmation that implementation writes are paused until after-state capture,
  who captures it, and where the raw report/action record will be retained.
- No publishing authority. The reviewer may have capable tools but must not use
  them to modify anything. No credentials are supplied as review inputs.

### Before/after observations and attribution

The implementation owner records the baseline immediately before the review,
outside the target repository. Include canonical root, base/head, symbolic HEAD,
all local refs, sanitized remote identity, staged and unstaged diffs, index entry
paths/modes/blob IDs/stages, and porcelain status including all untracked files.
Inventory tracked and Git-unignored new files; record relative path, type,
executable mode, symlink target without following it, and SHA-256 for regular
files. Existing modifications belong to this baseline, not automatically to the
reviewer. Do not `git add` merely to include a new file in the review.

Read-only capture commands include `git --no-optional-locks status --porcelain=v1
-z --untracked-files=all`, `git rev-parse HEAD`, `git symbolic-ref -q HEAD`,
`git for-each-ref`, `git ls-files --stage -z`, and
`git ls-files --cached --others --exclude-standard -z`. Capture diffs with
`git --no-pager diff --no-ext-diff --no-textconv --binary` and its `--cached`
variant so external diff helpers are not executed. Store outputs externally,
with timestamps; inventory each path safely without following symlinks out of
the target. Do not read credential stores or include raw secrets in evidence.

After the reviewer finishes, and before implementation resumes, repeat the same
captures and compare path sets, bytes/hashes, modes, links, refs, HEAD and index
entries. Inspect available reviewer action records as well as the final report.
Record ignored/generated areas omitted from capture as unobserved; never claim
that a non-ignored-file manifest covers the whole filesystem. If a remote PR
was supplied, reread its head/base and relevant PR activity using existing
read-only access; record any unavailable remote audit coverage explicitly.

An unexpected delta invalidates the assumption that this run reviewed one
stable version. Preserve both captures, report the delta, stop acceptance and
do not automatically reset or revert it. Correlate timestamps, action records
and any concurrent processes before attributing authorship. A hash difference
alone does not prove the reviewer caused it; a reviewer-written claim alone
does not prove it did not. If another actor wrote concurrently, record origin
as unresolved and repeat the review after the owner establishes a new baseline.

After corrections, the owner records a new implementation snapshot before
resuming the originating reviewer. A previous pass does not cover new bytes.
Equal before/after states show no observed net change within captured coverage;
they do not prove no transient writes, external side effects, secret access or
unlogged actions. This is the accepted MVP limitation, not technical isolation.

### Report and optional comment

The reviewer emits only the v1 JSON defined in the complete source prompt.
After validation and state comparison, the main session may summarize it as:
reviewed PR/SHA or local manifest; quality decision; findings ordered by severity
with location, trigger, impact, evidence and recommendation; checks actually
observed; pending gates; capture coverage and limits. Keep the original JSON
canonical. Publication of that summary is a separate authorized action; neither
this preparation nor the reviewer assignment authorizes comments or PR writes.

## Before a first PR

- Use the approved source MVP with its complete prompt and observations, or
  retain the managed-runtime blocker if that is the selected mode. Obtain the
  actual required reviews; preparing a prompt does not constitute review.
- Record task-specific authorization for branch/commit/push/PR/review requests
  and in-scope corrections. The current local-only instruction still applies.
- Select only the approved diff, preserving the existing supervised-task
  template, v2 quality configuration, tests, lockfile, and other local changes.
- Run applicable checks on the final snapshot; obtain any prerequisite design
  review before dependent implementation. Attach current evidence to the PR.
- Keep merge and auto-merge out of the delivery authorization. Require a separate
  explicit human decision for integration of the final PR SHA.

The pending selector expansion is not implemented by this policy change. Its
approved intent is to include new Git-unignored files in syntax, lint, and
architecture within the existing folders and exclusions. The eight affected
rules remain `ENG-SOURCE-SYNTAX-001`, `ENG-LINT-ERRORS-001`,
`ENG-CYCLOMATIC-COMPLEXITY-001`, `ARCH-NO-CYCLES-001`,
`ARCH-PROD-NO-TEST-001`, `ARCH-SRC-NO-BIN-001`,
`ARCH-IMPORT-RESOLUTION-001`, and `ARCH-PROD-NO-DEV-DEPS-001`.
Their versions/digests, trust bindings, adapters, and selectors are unchanged.
Report this policy-stage result before resuming that separate work.
