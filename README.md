# @gustavoarielms/sdd-codegraph-cli

MIT-licensed derivative package for multi-agent orchestration with SDD-aware
routing and optional integration with the external CodeGraph tool.

> **Publication status:** version `0.1.0` is publicly available as
> [`@gustavoarielms/sdd-codegraph-cli`](https://www.npmjs.com/package/@gustavoarielms/sdd-codegraph-cli).
>
> **Implementation status:** the cross-platform CLI is implemented for Node.js
> 20 or newer. The existing `setup.sh` installer remains available for backward
> compatibility.

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

## CLI

Run from a local checkout:

```bash
node ./bin/sdd-codegraph.js init /absolute/path/to/project
node ./bin/sdd-codegraph.js update /absolute/path/to/project
node ./bin/sdd-codegraph.js check /absolute/path/to/project
```

From npm, the equivalent package commands are:

```bash
npx @gustavoarielms/sdd-codegraph-cli init
npx @gustavoarielms/sdd-codegraph-cli update
npx @gustavoarielms/sdd-codegraph-cli check
```

- `init` installs the managed Codex SDD configuration and initializes or syncs
  CodeGraph.
- `update` refreshes the managed SDD files while preserving project-specific
  `AGENTS.md` content and unrelated `.codex/config.toml` keys.
- `check` is read-only and fails when managed files drift or the CodeGraph index
  is missing or stale.

The target path defaults to the current working directory. CodeGraph must be
installed separately and available in `PATH`.

## Includes

- Orchestrator policy injected into system prompt
- `subagent` tool with `single`, `parallel`, and `chain` modes
- Specialized agents:
  - `orchestrator`
  - `explorer`
  - `documentator`
  - `planner`
  - `architecture-reviewer`
  - `implementer`
  - `tester-reviewer`
  - `hacker`
- Horizontal subagent cards widget on startup (name + short description + color)
- Commands:
  - `/subagents`
  - `/orchestrator-status`
  - `/security-mode passive|active`

## Install (local path)

```bash
pi install /absolute/path/to/multi-team-sdd
```

Temporary run:

```bash
pi -e /absolute/path/to/multi-team-sdd
```

## Setup Codex

This repo also ships Codex-native agent configuration.

Install globally:

```bash
./setup.sh codex --global
```

Install into a specific project:

```bash
./setup.sh codex --project /absolute/path/to/project
```

Install both global and project config:

```bash
./setup.sh codex --global --project /absolute/path/to/project
```

The Codex setup installs:

- `~/.codex/agents/*.toml` or `<project>/.codex/agents/*.toml`
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

- Ask normally; the orchestrator policy is injected automatically.
- Force delegation explicitly with tool usage, for example:
  - single: explorer
  - chain: explorer -> planner -> implementer -> tester-reviewer
- Show active catalog: `/subagents`
- Check mode/status: `/orchestrator-status`
- Change security mode: `/security-mode passive|active`

## Notes

- `documentator` is constrained to `./docs/**` write/edit operations.
- `architecture-reviewer` is report-only and cannot approve new architecture policy or exceptions.
- `tester-reviewer` is report-only in v1.
- `hacker` supports passive and active modes. Active mode allows high-risk commands and requires explicit opt-in (`/security-mode active`).
- Startup UI renders horizontal cards with each specialized subagent (name + short description + role color).

## Governance baseline

[`docs/agent-governance-responsibility-map.md`](docs/agent-governance-responsibility-map.md)
defines the approved responsibility and authority model used to derive agent
prompts, pipeline policy, parity tests, and future enforcement schemas. It is a
design source, not a file automatically loaded by Pi, Codex, or CI.

## License

This derivative package is distributed under the MIT License. See
[LICENSE](LICENSE) for the full terms and [NOTICE.md](NOTICE.md) for original
project attribution. CodeGraph remains a separate external MIT-licensed tool
and is not bundled with this package.
