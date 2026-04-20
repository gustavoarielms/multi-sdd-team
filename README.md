# multi-team-sdd

`pi` package for multi-agent orchestration with SDD-aware routing.

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
