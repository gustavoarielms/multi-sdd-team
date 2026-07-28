# @gustavoarielms/sdd-codegraph-cli

Unpublished derivative package for multi-agent orchestration with SDD-aware
routing and optional integration with the external CodeGraph tool.

> **Publication status:** this fork is not published to npm or NuGet.
> `package.json` intentionally contains `"private": true` until the upstream
> licensing notice is explicit and registry publication is separately approved.
>
> **Implementation status:** the future cross-platform CLI is not implemented
> yet. The currently supported Codex installer is `setup.sh`.

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

See [NOTICE.md](NOTICE.md) for the detailed attribution and current licensing
status.

## Includes

- Orchestrator policy injected into system prompt
- `subagent` tool with `single`, `parallel`, and `chain` modes
- Specialized agents:
  - `orchestrator`
  - `explorer`
  - `documentator`
  - `planner`
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
- `SDD_SUBAGENTS` runs sequentially: `explorer -> documentator -> planner -> implementer -> tester-reviewer -> main integration`
- `hacker` is skipped unless explicitly requested or security-sensitive
- if `tester-reviewer` asks for small demo-blocking fixes, the main session applies them directly instead of calling `implementer` again

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
- `tester-reviewer` is report-only in v1.
- `hacker` supports passive and active modes. Active mode allows high-risk commands and requires explicit opt-in (`/security-mode active`).
- Startup UI renders horizontal cards with each specialized subagent (name + short description + role color).
