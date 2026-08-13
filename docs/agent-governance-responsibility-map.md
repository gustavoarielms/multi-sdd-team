# Agent Governance Responsibility Map

## Status

- Phase: 2 — Responsibility Map
- Status: baseline approved for contract design
- Scope: the existing roles plus the approved architecture reviewer in both Pi and Codex
- Out of scope: prompt rewrites, enforcement implementation, metrics storage, and dashboard design

## Approved decisions

1. Pi and Codex remain supported runtimes.
2. A runtime-neutral governance contract will be the canonical source for both runtimes.
3. The active/main session is the orchestration authority. A separate orchestrator agent is not part of the normal execution path.
4. Review agents remain report-only.
5. Findings that require code changes return to the implementer and must be revalidated by the gate that raised them.
6. Deterministic checks take precedence over agent opinion whenever a rule can be automated.
7. Architecture rules and exceptions require approval by the user or a designated human authority.

## How this document is used

This document is the approved governance design baseline. It is not loaded or
executed automatically by Pi, Codex, the installer, or CI.

It has four concrete consumers:

1. Agent contracts: responsibilities and limits defined here are translated into
   `agents/*.md` and `codex/agents/*.toml`.
2. Pipeline policy: authority, ordering, and remediation rules are translated into
   `codex/pipeline.json`, `codex/AGENTS.md`, and the Pi orchestrator policy.
3. Contract and parity tests: automated checks must verify that both runtimes expose
   the required roles and do not reintroduce prohibited ownership.
4. Future enforcement and metrics: rule, finding, evidence, exception, and gate
   schemas will be derived from this baseline rather than invented independently.

When runtime behavior differs from this document, the runtime behavior is the
current operational fact and the difference is governance drift to be fixed. This
document does not override executable behavior by itself.

## Governance principles

- No agent may approve its own work.
- A prompt assertion is not evidence.
- Every approval, rejection, or block must reference concrete evidence.
- Missing required evidence is not equivalent to passing a gate.
- Agents may interpret evidence, but deterministic tools own objective pass/fail decisions.
- Review findings must be reproducible or explicitly marked as unverified.
- Handoffs must preserve requirement, change, evidence, and finding identity.

## Actors and authority

### Main session / orchestrator

**Purpose**

Classify the request, select the execution strategy, enforce sequencing, route handoffs, and integrate the final result.

**Owns**

- strategy selection;
- pipeline sequencing and dependency enforcement;
- assignment of bounded work to specialist roles;
- confirmation that all required gates completed;
- presentation of unresolved decisions to the user.

**Does not own**

- implementation while an implementer owns the change;
- independent code-quality or security approval;
- invention of missing product requirements;
- overriding a failed deterministic gate without an explicit, recorded exception.

**Expected inputs**

- user request and constraints;
- repository-specific instructions;
- specialist handoffs;
- deterministic gate results;
- explicit user decisions and exceptions.

**Expected outputs**

- selected strategy and rule that triggered it;
- ordered handoff plan;
- current gate status;
- final evidence summary;
- unresolved risks, exceptions, and required user decisions.

**May decide**

- which existing strategy applies;
- which optional gate is required by the risk profile;
- whether a handoff is complete enough for the next stage;
- whether work must return to the previous owner.

**May not decide**

- that failed tests or policy checks can be ignored;
- that a security finding is resolved without hacker revalidation;
- that implementation is correct without an independent gate;
- product or architectural choices that materially exceed the approved scope.

**Blocking conditions**

- a mandatory predecessor has not completed;
- required evidence is missing;
- agents disagree on a material decision that has no declared authority;
- a required gate is failed or unresolved;
- user approval is required for a material or destructive action.

### Explorer

**Purpose**

Produce bounded, read-only repository reconnaissance for downstream decisions.

**Owns**

- relevant files, symbols, dependencies, and entry points;
- current architecture observations;
- explicit uncertainty and missing context;
- a compact start point for the next role.

**Does not own**

- solution design;
- implementation planning;
- code changes;
- approval or rejection of a change.

**Expected inputs**

- scoped question or initiative;
- repository and branch context;
- known constraints.

**Expected outputs**

- inspected paths and ranges;
- relevant symbols and relationships;
- architecture observations supported by source evidence;
- missing or ambiguous context;
- recommended reading order.

**May decide**

- which read-only exploration is necessary inside the assigned scope;
- that reconnaissance is incomplete and needs more context.

**May not decide**

- which material design should be implemented;
- whether the final change passes any gate.

**Blocking conditions**

- required repository state is unavailable;
- the requested symbol, feature, or evidence cannot be located;
- ambiguity would make the handoff misleading.

### Documentator

**Purpose**

Turn approved requirements and repository evidence into functional and technical specifications.

**Owns**

- explicit scope and exclusions;
- acceptance criteria;
- use cases and observable behavior;
- approved technical design, contracts, risks, and verification requirements;
- traceability from requirement to acceptance criterion.

**Does not own**

- inventing requirements;
- selecting among materially different product or architecture alternatives without approval;
- implementation;
- gate execution or final approval.

**Expected inputs**

- user-approved requirements and decisions;
- explorer handoff;
- repository constraints and existing architecture;
- known risks and non-goals.

**Expected outputs**

- initiative-specific functional specification;
- initiative-specific technical specification;
- acceptance criteria with stable identifiers;
- open questions and decisions;
- verification requirements mapped to acceptance criteria.

**May decide**

- document organization and wording;
- whether the available input is sufficient to specify the change faithfully.

**May not decide**

- unresolved product behavior;
- unapproved persistence, API, security, or architecture choices;
- that a specification is approved on behalf of the user or architecture authority.

**Blocking conditions**

- material requirement or design information is missing;
- the requested behavior contradicts repository constraints;
- acceptance criteria cannot be made observable or verifiable.

### Planner

**Purpose**

Convert approved specifications into ordered, bounded, and verifiable implementation tasks.

**Owns**

- task decomposition and dependencies;
- mapping tasks to acceptance criteria;
- expected files and change boundaries;
- per-task verification and risks;
- identification of safely parallelizable work.

**Does not own**

- changing approved requirements or design;
- implementation;
- final quality or security approval.

**Expected inputs**

- approved functional and technical specifications;
- explorer handoff when relevant;
- required quality and security gates.

**Expected outputs**

- stable task identifiers;
- ordered dependencies;
- acceptance-criterion coverage;
- expected files and artifacts;
- verification commands or evidence classes;
- risks and rollback considerations.

**May decide**

- implementation task granularity and safe ordering;
- whether a task can run in parallel;
- whether the plan is executable from the provided specifications.

**May not decide**

- to silently alter the approved design;
- to omit a required gate or acceptance criterion;
- to approve implementation.

**Blocking conditions**

- specifications are contradictory or unapproved;
- a task cannot be mapped to an acceptance criterion;
- material dependencies or verification requirements are unknown.

### Architecture reviewer

**Purpose**

Independently validate material architecture decisions before implementation and
verify implementation compliance afterward without changing code or specifications.

**Owns**

- evidence-based review of module and layer boundaries;
- dependency direction and coupling constraints;
- consistency with approved architecture decisions;
- identification of architecture rules suitable for deterministic enforcement;
- pass, fail, or blocked recommendation for the architecture gate.

**Does not own**

- product requirements or acceptance criteria;
- implementation or remediation;
- general code-quality or security review;
- approval of new architecture policy or exceptions on behalf of a human authority.

**Expected inputs**

- approved functional and technical specifications;
- planner handoff and relevant architecture decisions;
- repository structure and existing architecture constraints;
- implementation diff for post-implementation review;
- approved rules and exceptions.

**Expected outputs**

- review phase: design or implementation compliance;
- architecture baseline and decisions reviewed;
- source and rule evidence;
- findings with severity, location, impact, and remediation constraint;
- candidate deterministic rules clearly separated from enforced rules;
- gate recommendation and required revalidation.

**May decide**

- whether a proposal or implementation conforms to already approved architecture;
- whether evidence supports an architecture finding;
- whether an architecture-sensitive change needs a recorded decision;
- whether remediation requires a repeated architecture review.

**May not decide**

- which product behavior the user wants;
- to introduce a material architecture choice that has not been approved;
- to modify code, specifications, or the rule catalog while reviewing;
- to accept or waive a failed architecture rule.

**When required**

- module or layer boundaries change;
- dependency direction or shared abstractions change;
- a public API, event, schema, persistence model, or integration topology changes;
- an architecture decision is introduced, replaced, or explicitly challenged;
- the user or another gate requests architecture authority.

**Blocking conditions**

- the proposal contradicts an approved architecture decision;
- implementation violates an enforced architecture rule;
- a material architecture decision lacks human approval;
- required architecture evidence or a necessary decision record is missing.

### Implementer

**Purpose**

Implement the approved plan using test-driven development and produce change evidence.

**Owns**

- RED, GREEN, and REFACTOR execution for testable behavior;
- surgical code and test changes within assigned scope;
- preservation of unrelated work;
- exact change and test evidence;
- remediation of findings assigned by a review gate.

**Does not own**

- changing requirements or architecture without approval;
- reviewing or approving its own implementation;
- suppressing, downgrading, or closing reviewer findings;
- altering unrelated code.

**Expected inputs**

- approved plan and specifications;
- acceptance criteria and required gates;
- repository state and change ownership;
- assigned findings during remediation.

**Expected outputs**

- acceptance criteria implemented;
- exact files changed;
- RED evidence and observed failure;
- GREEN/refactor evidence and final results;
- limitations, deviations, and unresolved items;
- finding identifiers addressed during remediation.

**May decide**

- minimal implementation details inside the approved design;
- local refactoring necessary to keep the changed code maintainable;
- that the implementation is ready for independent review.

**May not decide**

- that the change has passed review;
- that a required test or gate can be skipped;
- that an assigned finding is resolved without revalidation.

**Blocking conditions**

- the plan is not implementable without a material design change;
- required RED evidence cannot be produced for testable behavior;
- repository state conflicts with assigned ownership;
- mandatory tests or checks cannot execute.

### Tester / reviewer

**Purpose**

Independently evaluate correctness, maintainability, test quality, and observable acceptance criteria without changing code.

**Owns**

- changed-scope static review;
- automated and manual test evidence appropriate to the change;
- acceptance-criterion verification;
- reproducible quality findings;
- pass, fail, or blocked recommendation for its gate.

**Does not own**

- implementation or remediation;
- security authority reserved for the hacker;
- architecture authority where no architecture owner has been declared;
- overriding deterministic test or policy failures.

**Expected inputs**

- approved specifications and plan;
- implementation diff and implementer evidence;
- required checks and acceptance criteria;
- known exceptions.

**Expected outputs**

- reviewed files and acceptance criteria;
- commands/checks executed and outcomes;
- findings with stable identity, evidence, location, severity, and reproduction;
- gate recommendation;
- remediation handoff to the implementer.

**May decide**

- whether the provided evidence satisfies the quality gate;
- whether a finding is reproducible;
- whether another specialist authority is required.

**May not decide**

- how the implementer must redesign beyond stating constraints;
- whether a security or unresolved architecture finding can be accepted;
- that a deterministic failure is non-blocking without an approved exception.

**Blocking conditions**

- a required test or deterministic check fails;
- an acceptance criterion is unmet or unverified;
- a reproducible defect affects required behavior;
- required implementation or test evidence is missing;
- review scope cannot be established from the supplied diff and handoff.

### Hacker / security reviewer

**Purpose**

Independently identify, validate, and prioritize security risks without implementing fixes.

**Owns**

- threat and attack-surface analysis;
- static and explicitly authorized dynamic security validation;
- reproducible security findings;
- mitigation constraints and residual-risk assessment;
- pass, fail, or blocked recommendation for the security gate.

**Does not own**

- implementing remediations;
- enabling active or destructive testing without explicit authorization;
- accepting residual risk on behalf of the user;
- general code-quality review already owned by tester/reviewer.

**Expected inputs**

- approved scope and threat assumptions;
- implementation diff and relevant runtime context;
- security mode and explicit authorization boundaries;
- known exceptions and compensating controls.

**Expected outputs**

- attack surface and threat assumptions;
- findings with stable identity, evidence, affected asset, severity, exploitability, and validation state;
- commands/actions performed and their impact;
- recommended mitigation and residual risk;
- gate recommendation and remediation handoff to the implementer.

**May decide**

- whether evidence supports a security finding;
- finding severity and validation state under the future canonical rules;
- whether active validation is needed, but not whether it is authorized;
- whether remediation requires re-audit.

**May not decide**

- to exceed the authorized test mode or scope;
- to modify code while acting as security reviewer;
- to accept unresolved Critical or High residual risk for the user.

**Blocking conditions**

- a validated blocking security finding remains unresolved;
- required authorization for dynamic validation is missing;
- the relevant environment cannot be tested safely;
- security evidence or remediation status is incomplete.

### Deterministic enforcement

This is a system actor, not an LLM agent.

**Purpose**

Evaluate objective rules and produce reproducible results independently of agent opinion.

**Owns**

- compilation, lint, formatting, and test outcomes;
- coverage and configured threshold checks;
- dependency and vulnerability policy checks;
- architecture-boundary checks;
- schema and contract validation;
- governance configuration drift;
- machine-readable evidence for CI and future metrics.

**Authority**

- A failed blocking rule prevents approval unless an explicit exception exists.
- Agents may explain a result but may not rewrite it.
- Exceptions require owner, reason, scope, expiry, and approving authority.

## Engineering-rule authority

- Agents and deterministic tools may propose a rule with supporting evidence.
- The main session may maintain the catalog operationally: identifiers, formatting,
  traceability, and propagation to Pi, Codex, tests, and CI.
- Only the user or a designated human authority may approve, change, deprecate, or
  waive a material architecture or engineering rule.
- An exception must name its approving authority, affected rule, scope, reason,
  creation date, and expiry or review date.
- Until an authority is designated, the user is the approving authority.

## Canonical handoff flow

```text
user/main session
  -> explorer
  -> documentator
  -> planner
  -> architecture design review when required
  -> optional pre-implementation security review
  -> implementer
  -> deterministic enforcement
  -> architecture compliance review when required
  -> tester/reviewer
  -> optional hacker/security gate
  -> main-session integration
```

Every stage begins only after its mandatory predecessors complete. Optional stages must record why they were included or skipped.

## Finding remediation loop

```text
review gate raises finding
  -> main session routes finding to implementer
  -> implementer changes code/tests and cites finding ID
  -> deterministic checks run again
  -> the original review gate revalidates
  -> finding becomes resolved, remains open, or is superseded
```

The main session coordinates this loop but does not replace the implementer or the independent reviewer.

## Approval model

An initiative is eligible for final integration only when:

1. required specifications and decisions are approved;
2. implementation is complete and traceable to acceptance criteria;
3. every mandatory deterministic gate passes or has an approved exception;
4. architecture reviewer has no unresolved blocking findings when its gate is required;
5. tester/reviewer has no unresolved blocking findings;
6. hacker has no unresolved blocking findings when the security gate is required;
7. all required evidence is present;
8. the main session reports residual risk and unresolved non-blocking findings.

No single agent can satisfy all eight conditions alone.

## Current overlaps

1. The Codex main session and the standalone orchestrator agent both claim routing authority.
2. Tester/reviewer, architecture reviewer, and hacker all perform static analysis;
   their authority must remain separated by quality, architecture, and security rule category.
3. Tester/reviewer combines test execution, code review, and acceptance verification.
4. Pi, Codex agent TOMLs, the Codex policy, and the Pi runtime policy duplicate parts of the orchestration contract.

## Current responsibility gaps

1. No machine-readable catalog implements the approved engineering-rule lifecycle yet.
2. No component owns normalized finding identity and status transitions.
3. No component currently persists evidence, trends, or metrics.
4. A named human authority other than the user has not yet been designated for approving architecture rules or accepting residual architecture and security risk.

These gaps must be resolved before assigning architecture or governance approval to an existing agent.

## Known runtime divergences to remove in later phases

1. Pi and Codex prompts do not contain identical responsibilities and limits.
2. Codex `demo_fast` sends reviewer fixes to the main session, while reviewer prompts send them to the implementer.
3. The standalone Codex orchestrator agent has routing rules that differ from the Pi runtime policy.
4. TDD is unconditional in Pi but conditional on testability in Codex.
5. Security active-mode language and enforcement differ between the two runtimes.
6. Output headings and severity vocabularies are not normalized.
7. The architecture reviewer is newly approved and must remain aligned across both runtimes and pipeline policies.

## Next contract-design inputs

The next phase must define:

- stable execution, acceptance-criterion, task, evidence, finding, rule, and exception identifiers;
- a shared machine-readable result schema;
- normalized status, severity, confidence, validation, and blocking fields;
- authority for architecture decisions and engineering-rule lifecycle;
- deterministic rules that can be enforced immediately;
- parity checks that prevent Pi and Codex contracts from drifting.
