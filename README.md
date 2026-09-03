# @gustavoarielms/sdd-codegraph-cli

A Codex-only installer and governance pack for teams that want an opinionated,
sequential Software Design and Development workflow with specialized agents,
machine-validated review handoffs, and optional CodeGraph integration.

It installs managed Codex configuration into a project or global Codex home:
agent definitions, orchestration policy, pipeline strategies, governance
schemas, deterministic checks, and review contracts.

> **Publication status:** the package is publicly available as
> [`@gustavoarielms/sdd-codegraph-cli`](https://www.npmjs.com/package/@gustavoarielms/sdd-codegraph-cli).
>
> **Runtime requirement:** the cross-platform Node.js CLI requires Node.js
> 22.14.0 through 22.x, 24.x, or 26.0.0 or newer; Node.js 25 is unsupported. The repository checkout also provides a Bash setup script
> for explicit Codex-only global or project installation.

## What this package is for

- Bootstrapping a consistent Codex multi-agent workflow in a repository.
- Routing substantial work through sequential exploration, specification,
  planning, implementation, and report-only review stages.
- Keeping architecture, quality, and security reviewer handoffs
  machine-validatable.
- Updating managed Codex files without overwriting unrelated project content.
- Optionally initializing and checking an external CodeGraph index.

## What this package is not

- It is not an AI agent runtime or scheduler; Codex executes the agents.
- It is not a generic or configurable SDD framework; it ships one opinionated
  workflow and governance model.
- It is not CodeGraph and does not install CodeGraph.
- It is not a project or application code generator.
- It does not build, test, merge, deploy, or release consuming applications.
- It does not replace human approval for architecture rules, exceptions,
  destructive operations, merges, or releases.
- It is Codex-only and does not provide compatibility layers for earlier
  non-Codex runtimes.

## Requirements and installation paths

- Node.js 22.14.0 through 22.x, Node.js 24.x, or Node.js 26.0.0 or newer is required; Node.js 25 is unsupported.
- Codex is the runtime that reads the installed agent and orchestration
  configuration.
- CodeGraph is external and optional for the setup script and governance-only
  commands. It must be installed separately and available in `PATH` when using
  `init`, `update`, or `check`, because those commands initialize, sync, or
  inspect its index.

There are two installation surfaces:

- The npm CLI installs or updates project-scoped managed configuration and can
  coordinate the external CodeGraph CLI.
- `setup.sh`, run from a repository checkout, installs project-scoped, global,
  or both Codex configurations without installing CodeGraph.

## CLI

From npm:

```bash
npx @gustavoarielms/sdd-codegraph-cli init /absolute/path/to/project
npx @gustavoarielms/sdd-codegraph-cli init /absolute/path/to/project --permissions read-only
npx @gustavoarielms/sdd-codegraph-cli update /absolute/path/to/project
npx @gustavoarielms/sdd-codegraph-cli check /absolute/path/to/project
npx @gustavoarielms/sdd-codegraph-cli check-governance /absolute/path/to/repository
npx @gustavoarielms/sdd-codegraph-cli run-gates /absolute/path/to/repository
```

From a local checkout, the equivalent commands are:

```bash
node ./bin/sdd-codegraph.js init /absolute/path/to/project
node ./bin/sdd-codegraph.js init /absolute/path/to/project --permissions read-only
node ./bin/sdd-codegraph.js update /absolute/path/to/project
node ./bin/sdd-codegraph.js check /absolute/path/to/project
node ./bin/sdd-codegraph.js check-governance /absolute/path/to/repository
node ./bin/sdd-codegraph.js run-gates /absolute/path/to/repository
```

- `init` installs the managed Codex SDD configuration and initializes or syncs
  CodeGraph.
- `update` refreshes the managed SDD files while preserving project-specific
  `AGENTS.md` content and unrelated `.codex/config.toml` keys.
- `check` is non-mutating and fails when managed files drift, the effective
  prompt boundary is not provably read-only, or the CodeGraph index is missing
  or stale.
- `check-governance` emits canonical JSON. It exits `1` for a trustworthy
  blocking policy failure and `2` when the governance state is untrustworthy.
- `run-gates` runs the ten approved deterministic engineering executors and
  emits exactly one canonical JSON document. It exits `0` for `passed`, `1`
  for a completed blocking `failed` run, and `2` for a `blocked`, incomplete,
  or untrustworthy run.

The target path defaults to the current working directory.

Project installs select `workspace-only` by default. Later human-controlled
`update` commands use the protected `default_permissions` value in
`.codex/config.toml` as their selected profile; `.sdd-codegraph.json` only
records that selection. If that
config value is missing from an existing installation, restore it by explicitly
passing `--permissions workspace-only`, `--permissions read-only`,
`--permissions workspace`, or the escape hatch
`--permissions danger-full-access`. The repository `setup.sh` accepts the same
option when used with `--project`.

`workspace-only` is a custom beta Codex permission profile. It extends the
built-in workspace profile, explicitly keeps `.codex/` read-only, then denies
filesystem access outside the active workspace except for minimal runtime reads,
disables command network access,
and denies system temporary directories. `read-only` prevents local command
writes; `workspace` permits writes in workspace roots and system temporary
directories; `danger-full-access` removes local sandbox restrictions.

Permission profiles are ignored when any loaded Codex configuration still uses
the legacy `sandbox_mode` or `[sandbox_workspace_write]` settings. Remove those
legacy settings before relying on this boundary. Codex also loads project-local
configuration only after the project is trusted. Global installs do not select
or define a permission profile.

These constraints follow the official Codex documentation for
[permission profiles](https://developers.openai.com/codex/permissions),
[agent approvals and sandbox security](https://learn.chatgpt.com/docs/agent-approvals-security),
and [administrator-enforced requirements](https://learn.chatgpt.com/docs/enterprise/managed-configuration).

### Managed prompt protection

Project-installed `.codex/agents/*.toml` files are AI-immutable policy in the
supported Codex workflow. The agent templates use permission profiles rather
than legacy `sandbox_mode`: writing roles select `:workspace`, read-only roles
select `:read-only`, and both inherit the built-in recursive read-only boundary
for `.codex/**`. Every prompt also forbids self-modification, escalation,
installer shortcuts, and delegation of a bypass as defense in depth; those
instructions are not the enforcement mechanism.

Installation writes `.codex/managed-prompts.json`, containing the package
identity, selected project profile, and SHA-256 of every managed prompt.
`check` requires the actual agent directory to contain exactly the package-owned
prompt set, verifies exact bytes, rejects symlink or hardlink identities, classifies
legacy and elevated profiles, and performs non-mutating diagnostic probes against
every managed prompt, the protected digest inventory, `.codex/`, and
`.codex/agents/`. Each file is opened for write without truncation and each
directory is checked for `W_OK` access. Writable, incomplete, or ambiguous
results fail closed. A denial alone is not proof of the active sandbox authority:
the same process may control discretionary file modes and later restore them.
Child-controlled environment variables such as `CODEX_PERMISSION_PROFILE` and
`CODEX_SANDBOX` are never accepted as security evidence.

The current Codex child-process contract exposes no non-spoofable sandbox
attestation. Therefore an otherwise clean project installation remains
`unproven` with `MANAGED_PROMPT_RUNTIME_UNPROVEN`; `check`, governance, and
`run-gates` exit `2` before automatic or delegated work. A future positive
`protected` result requires a trusted runtime or broker attestation that the
checked process cannot manufacture or revoke. Run the package itself from a
trusted immutable launcher because a package copy already controlled by an
attacker cannot trustworthily verify itself.

`init` and `update` intentionally remain able to replace prompts when a person
runs them outside the AI-mediated session. Agents must never invoke those
commands or request an escalation for them. A conversational request is not
update authority, and a new Codex session is required after an update so the
new configuration and prompts are loaded together.

The guarantee is project-scoped. Global `$CODEX_HOME/agents` installations are
always reported as unproven by this package. An external
administrator-controlled boundary may protect them, but this package cannot
attest that boundary. Direct human, administrator, root, compromised-runtime,
MCP, connector, browser, Computer Use, and cloud writes remain outside this
package's filesystem guarantee and require their own controls. This package
does not claim absolute immutability against direct machine access.

`run-gates` requires this target-owned configuration:

```json
{
  "schema_version": "1.0.0",
  "quality_profile": {
    "profile_id": "engineering-quality-v1",
    "profile_version": "1.0.0",
    "adapter_id": "node-v1",
    "adapter_version": "1.0.0"
  },
  "executors": [
    "javascript_syntax",
    "node_lint_complexity",
    "unit_tests",
    "integration_tests",
    "coverage",
    "node_architecture",
    "governance",
    "production_dependency_audit",
    "npm_package_surface",
    "forbidden_references"
  ]
}
```

Store it at `.sdd-codegraph/gates.json`. The quality profile, adapter, order,
and complete executor allowlist are fixed in v1. Unknown properties, omitted
or additional executors, threshold overrides, arbitrary commands, baselines,
exceptions, and plugins are rejected. The installer does not create this
target-owned file.

The selected profile has blocking changed-code coverage, so its comparison
base is required and must be a full lowercase commit SHA:

```bash
sdd-codegraph run-gates /absolute/path/to/repository \
  --comparison-base 0123456789abcdef0123456789abcdef01234567
```

The runner resolves source, project-local package, and global package
invocations against the same target contract. It uses fixed package executors,
no shell, real-path containment, per-executor timeouts, bounded child output,
and redaction-safe summaries. Approved gate effects come only from the shipped
human-approved governance catalog; target configuration and report-only
reviewers cannot weaken deterministic results. See
[`governance/README.md`](governance/README.md) for the result contract.

Run gates from a trusted launcher and keep the checkout immutable for the
duration of the run. The package empties the analyzer child's environment, and
the shipped CI workflows also clear Node, ESLint, c8, V8 coverage, and nyc
control variables. For a
sanitized local POSIX invocation, use:

```bash
env -u C8_CONFIG -u C8_REPORTER -u NODE_OPTIONS -u NODE_PATH \
  -u NODE_V8_COVERAGE -u NYC_CONFIG -u TIMING -u DEBUG -u ESLINT_FLAGS \
  sdd-codegraph run-gates /absolute/path/to/repository \
  --comparison-base 0123456789abcdef0123456789abcdef01234567
```

A process already compromised before the CLI starts, or a concurrently mutable
checkout, is outside the runner's trust boundary.

The package also ships the approved `engineering-quality-v1` profile and its
explicit `node-v1` adapter contract. Its package-owned ESLint `10.8.1` executor
analyzes only tracked JavaScript under `bin/`, `src/`, and `test/`, rejects
inline directives, ignores target ESLint configuration, allows classic McCabe
complexity `15`, and blocks each function measured at `16` or more. The profile
also fixes global
coverage `85/80/85/85`, changed-code coverage `90/85/90/90`, required unit and
integration semantics, and five architecture boundaries. Unit, integration,
and combined exact-count coverage are enforced with package-owned `c8@12.0.0`
and `istanbul-lib-coverage@3.2.2` executors. The sixth executor uses the
content-verified vendored `dependency-cruiser@18.2.0` runtime and fixed policy
to enforce all five architecture boundaries with bounded evidence. Its
filesystem identity checks assume a quiescent checkout; they detect observable
changes before/after analysis but do not claim to prevent an active swap-back.

## Codex runtime

- Managed orchestrator policy in `AGENTS.md`
- Native Codex multi-agent strategies declared in `pipeline.json`
- Specialized Codex agents:
  - `orchestrator`
  - `explorer`
  - `documentator`
  - `planner`
  - `architecture-reviewer`
  - `implementer`
  - `tester-reviewer`
  - `hacker`

## Setup from a repository checkout

This repository supports Codex-native agent configuration only.

Install globally:

```bash
./setup.sh --global
```

Install into a specific project:

```bash
./setup.sh --project /absolute/path/to/project
./setup.sh --project /absolute/path/to/project --permissions workspace
```

Install both global and project config:

```bash
./setup.sh --global --project /absolute/path/to/project
```

The Codex setup installs:

- `~/.codex/agents/*.toml` or `<project>/.codex/agents/*.toml`
- `<project>/.codex/managed-prompts.json` with the protected prompt baseline
- governance v1 schemas, rule catalog, check registry, engineering gate
  registry, and quality profile under the matching `.codex/governance/`
  directory
- `pipeline.json`
- `AGENTS.md` instructions with a managed `multi-sdd-team` block
- `service_tier = "fast"` and `[features].fast_mode = true`
- `[agents].max_threads = 6` and `[agents].max_depth = 1`

Codex demo-fast behavior:

- the main session acts as orchestrator
- `SDD_SUBAGENTS` runs sequentially: `explorer -> documentator -> planner -> architecture-reviewer (when required) -> implementer -> architecture-reviewer (when required) -> tester-reviewer -> main integration`
- `hacker` is skipped unless explicitly requested or security-sensitive
- review findings return to `implementer`, then deterministic checks and the originating review gate run again

## Quick usage

After installation, open the target project in Codex and describe the outcome
and delivery boundaries. For example:

> Add rate limiting to the public API. Use the full sequential SDD flow,
> include passive security review, and stop before merge or deployment.

The main Codex session reads the managed orchestrator policy and selects an
inline, single-agent, chained, or full SDD strategy. You can also request a
specific native Codex delegation sequence, for example
`explorer -> planner -> implementer -> tester-reviewer`.

## Notes

- `documentator` is constrained to `./docs/**` write/edit operations.
- `architecture-reviewer` is report-only and cannot approve new architecture policy or exceptions.
- `tester-reviewer` is report-only in v1.
- `hacker` is passive by default. Intrusive or high-risk validation requires explicit human authorization.

## Governance baseline

[`docs/agent-governance-responsibility-map.md`](docs/agent-governance-responsibility-map.md)
defines the approved responsibility and authority model used to derive agent
prompts, pipeline policy, catalog tests, and enforcement contracts. It is a
design source, not a file automatically loaded by Codex or CI.

The versioned machine-readable contract is documented in
[`governance/README.md`](governance/README.md). Validate its modular JSON Schemas,
examples, negative cases, and referential integrity with:

```bash
npm run check:governance
npm run governance
```

Architecture, quality, and security reviewers emit pure JSON. Validate every
handoff before using it:

```bash
sdd-codegraph validate-result result.json --agent architecture_reviewer
```

## Origin and attribution

This repository is a fork of
[`ram4-dev/multi-sdd-team`](https://github.com/ram4-dev/multi-sdd-team), whose
package metadata identifies `rcarnicer` as the original author.

- The fork maintainer does not claim ownership of SDD as a methodology.
- The fork maintainer does not claim ownership of CodeGraph.
- CodeGraph is an external tool and is not bundled with this package.
- References to CodeGraph describe optional configuration and bootstrap
  integration only.
- The package name distinguishes this derivative distribution from the original
  project; it does not imply authorship of the underlying concepts or tools.

See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for licensing and detailed
attribution.

## License

This derivative package is distributed under the MIT License. See
[LICENSE](LICENSE) for the full terms and [NOTICE.md](NOTICE.md) for original
project attribution. CodeGraph remains a separate external MIT-licensed tool
and is not bundled with this package.
