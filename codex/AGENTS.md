# Project Execution Policy

## Direct execution by default

The main session owns completion of the requested task: inspect relevant code,
implement changes, run required checks, fix failures, and verify the result.

For questions or planning requests, do not implement code changes. Produce
requested planning artifacts only within the authorized scope.

When implementation is requested and expected behavior is defined, continue
until the requested scope is complete or a concrete blocker prevents progress.
Do not stop after a diagnosis or another plan.

Completion remains bounded by the user's authorized scope. Preserve explicit
read-only, review-only, and approval gates. Preserve unrelated work.

## Proportional planning

Reuse approved specifications and architectural decisions. Create or update a
specification only when functional requirements are ambiguous, significant
design decisions remain unresolved, or the user explicitly requests one.
Ask about material unresolved choices before implementing dependent changes;
continue independent authorized work when possible.

Adding tests, exceeding a line-count threshold, or touching multiple files does
not, by itself, require SDD or delegation. For substantial work, state a brief
plan with observable acceptance criteria and the required validation.

## Selective delegation

There is no mandatory chain of explorer, documentator, planner, implementer,
and tester_reviewer. Use specialists for bounded investigation, independent
implementation, or required review. Do not spawn an orchestrator solely to
classify work unless the user requests it.

Define each delegated task's scope, ownership, dependencies, and expected
handoff. The main session may advance independent tasks while specialists
work. It must not duplicate delegated work, edit the same files concurrently,
or change the revision or shared environment being reviewed or validated.
Use isolated worktrees or immutable snapshots when separation is needed.
Dependent work must wait for its required inputs and passing gates.

The main session may implement and remediate changes it owns. The separate
orchestrator specialist remains read-only. Independent reviewers remain
report-only and must not review their own implementation as independent work.

## Validation and independent review

Preserve all project safety, test, coverage, architecture, permission, and
validation restrictions. Apply existing TDD requirements to testable code and
contract changes regardless of whether the main session or implementer writes
the change. Do not add meaningless tests for cosmetic changes.

Require independent review for changes that materially affect monetary
calculations, payments, fiscal operations, durable persistence, security, or
native interoperability, and whenever project rules or the user require it.
Determine applicability from changed behavior and risk, not filenames alone.

Preserve architecture design and compliance review for material changes to
boundaries, dependency direction, public contracts, persistence, integration
topology, shared abstractions, or architecture decisions. Use the appropriate
quality, architecture, or security specialist for each required gate. Sensitive
work does not automatically require every specialist or a new specification.
Speed or demo preferences never waive required review.

Run affected checks after remediation and obtain revalidation from the
originating reviewer on the updated revision. If that reviewer is unavailable,
report the unresolved review prerequisite; do not silently accept self-review.
A required gate that failed, is invalid, remains unresolved, or was not run
blocks dependent work and completion. Continue independent authorized work.

Never claim validation of an environment or scenario that was not executed.
Distinguish static checks, simulated tests, real execution, and user acceptance.

## Structured review gates

architecture_reviewer, tester_reviewer, and hacker must return exactly one JSON
object conforming to .codex/governance/schemas/v1/agent-result.schema.json.
Their handoffs contain no Markdown or surrounding prose.

Before accepting one of these handoffs, validate the unchanged result with:

`sdd-codegraph validate-result - --agent <agent_name>`

An invalid document, mismatched role/runtime, missing gate decision, or broken
reference is a failed handoff. Ask the originating reviewer for a corrected
envelope. Successful schema validation alone does not mean the gate passed:
honor its decision and unresolved blocking findings. Summarize for the user
only after validation; JSON remains the canonical handoff.

## Managed Prompt Boundary

Project-installed `.codex/agents/**` files are managed security policy, not an
agent-editable project surface. No main session or subagent may modify, remove,
replace, rename over, symlink-redirect, regenerate, or patch those files. Agents
must not invoke `sdd-codegraph init` or `sdd-codegraph update`, request elevated
permissions for that purpose, or delegate the attempt to another agent.

Prompt changes require a separately approved package change followed by an
explicit update initiated directly by a person outside the AI-mediated workflow.
A conversational request to an agent is not update authority. Before delegated
or automatic work begins, `sdd-codegraph check` and governance must establish a
protected runtime; drift, legacy sandbox configuration, an elevated profile, or
an unproven effective state blocks the workflow.

## Blockers, completion, and policy conflicts

When blocked, report the observed failure, confirmed facts, remaining
uncertainty, affected scenario, and the prerequisite or diagnostic step needed
to continue. Avoid identical retries without new evidence or changed conditions.

At completion, report changes, checks actually executed, behavior completed,
and remaining validation limits. Distinguish implementation, review, PR
publication, merge, release, deployment, and external acceptance.

The package's pipeline and specialist instructions must implement this policy
without reintroducing file-count routing or mandatory specialist chains.
Use the project pipeline when present; otherwise use the installed global
pipeline. Preserve higher-priority instructions and applicable project safety
and validation rules. If a skill or pipeline conflicts, identify its file and
exact instruction, explain the applicable precedence, and do not silently
restore an obsolete workflow or bypass a required gate. Ask only when a
material choice or authorization remains unresolved.

Do not modify global configuration without authorization.
