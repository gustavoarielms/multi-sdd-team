#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_TEMPLATE_DIR="$ROOT_DIR/codex"
GOVERNANCE_SCHEMA_DIR="$ROOT_DIR/governance/schemas/v1"

usage() {
  cat <<'USAGE'
multi-sdd-team setup

Usage:
  ./setup.sh codex --global
  ./setup.sh codex --project /path/to/project
  ./setup.sh codex --global --project /path/to/project

Options:
  codex                 Install Codex agent/pipeline configuration.
  --global              Install globally under ~/.codex.
  --project <path>      Install project-scoped config into <path>.
  -h, --help            Show this help.

Examples:
  ./setup.sh codex --global
  ./setup.sh codex --project "$PWD"
USAGE
}

require_codex_templates() {
  if [[ ! -d "$CODEX_TEMPLATE_DIR/agents" ]]; then
    echo "Missing Codex templates: $CODEX_TEMPLATE_DIR/agents" >&2
    exit 1
  fi
  if [[ ! -f "$CODEX_TEMPLATE_DIR/pipeline.json" ]]; then
    echo "Missing Codex pipeline template: $CODEX_TEMPLATE_DIR/pipeline.json" >&2
    exit 1
  fi
  if [[ ! -f "$CODEX_TEMPLATE_DIR/AGENTS.md" ]]; then
    echo "Missing Codex AGENTS template: $CODEX_TEMPLATE_DIR/AGENTS.md" >&2
    exit 1
  fi
  if [[ ! -f "$GOVERNANCE_SCHEMA_DIR/agent-result.schema.json" ]]; then
    echo "Missing governance schemas: $GOVERNANCE_SCHEMA_DIR" >&2
    exit 1
  fi
}

merge_marked_file() {
  local target_file="$1"
  local source_file="$2"
  local marker="$3"

  TARGET_FILE="$target_file" SOURCE_FILE="$source_file" MARKER="$marker" python3 <<'PY'
from pathlib import Path
import os
import re

target = Path(os.environ["TARGET_FILE"])
source = Path(os.environ["SOURCE_FILE"])
marker = os.environ["MARKER"]
begin = f"<!-- {marker}: begin -->"
end = f"<!-- {marker}: end -->"
block = f"{begin}\n{source.read_text().rstrip()}\n{end}\n"

if target.exists():
    text = target.read_text()
else:
    text = ""

pattern = re.compile(re.escape(begin) + r".*?" + re.escape(end) + r"\n?", re.S)
if pattern.search(text):
    text = pattern.sub(block, text)
else:
    if text and not text.endswith("\n"):
        text += "\n"
    if text:
        text += "\n"
    text += block

target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(text)
PY
}

set_toml_key() {
  local config_file="$1"
  local table="$2"
  local key="$3"
  local value="$4"

  CONFIG_FILE="$config_file" TABLE="$table" KEY="$key" VALUE="$value" python3 <<'PY'
from pathlib import Path
import os
import re

path = Path(os.environ["CONFIG_FILE"])
table = os.environ["TABLE"]
key = os.environ["KEY"]
value = os.environ["VALUE"]

path.parent.mkdir(parents=True, exist_ok=True)
text = path.read_text() if path.exists() else ""
lines = text.splitlines()

def is_table(line: str) -> bool:
    stripped = line.strip()
    return stripped.startswith("[") and stripped.endswith("]")

def key_re(name: str):
    return re.compile(rf"^\s*{re.escape(name)}\s*=")

if table == "":
    first_table = next((i for i, line in enumerate(lines) if is_table(line)), len(lines))
    for i in range(first_table):
        if key_re(key).match(lines[i]):
            lines[i] = f"{key} = {value}"
            break
    else:
        lines.insert(first_table, f"{key} = {value}")
else:
    header = f"[{table}]"
    start = None
    for i, line in enumerate(lines):
        if line.strip() == header:
            start = i
            break
    if start is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(header)
        lines.append(f"{key} = {value}")
    else:
        end = next((i for i in range(start + 1, len(lines)) if is_table(lines[i])), len(lines))
        for i in range(start + 1, end):
            if key_re(key).match(lines[i]):
                lines[i] = f"{key} = {value}"
                break
        else:
            lines.insert(start + 1, f"{key} = {value}")

path.write_text("\n".join(lines).rstrip() + "\n")
PY
}

install_codex_global() {
  require_codex_templates

  local codex_home="${CODEX_HOME:-$HOME/.codex}"
  local agents_dir="$codex_home/agents"

  mkdir -p "$agents_dir"
  mkdir -p "$codex_home/governance/schemas/v1"
  cp "$CODEX_TEMPLATE_DIR"/agents/*.toml "$agents_dir/"
  cp "$GOVERNANCE_SCHEMA_DIR"/*.schema.json "$codex_home/governance/schemas/v1/"
  cp "$CODEX_TEMPLATE_DIR/pipeline.json" "$codex_home/pipeline.json"

  merge_marked_file "$codex_home/AGENTS.md" "$CODEX_TEMPLATE_DIR/AGENTS.md" "multi-sdd-team"

  set_toml_key "$codex_home/config.toml" "" "service_tier" '"fast"'
  set_toml_key "$codex_home/config.toml" "features" "fast_mode" "true"
  set_toml_key "$codex_home/config.toml" "agents" "max_threads" "6"
  set_toml_key "$codex_home/config.toml" "agents" "max_depth" "1"

  echo "Installed Codex global config in $codex_home"
}

install_codex_project() {
  require_codex_templates

  local project_dir="$1"
  local codex_dir="$project_dir/.codex"

  mkdir -p "$codex_dir/agents"
  mkdir -p "$codex_dir/governance/schemas/v1"
  cp "$CODEX_TEMPLATE_DIR"/agents/*.toml "$codex_dir/agents/"
  cp "$GOVERNANCE_SCHEMA_DIR"/*.schema.json "$codex_dir/governance/schemas/v1/"
  cp "$CODEX_TEMPLATE_DIR/pipeline.json" "$project_dir/pipeline.json"

  merge_marked_file "$project_dir/AGENTS.md" "$CODEX_TEMPLATE_DIR/AGENTS.md" "multi-sdd-team"

  set_toml_key "$codex_dir/config.toml" "" "service_tier" '"fast"'
  set_toml_key "$codex_dir/config.toml" "features" "fast_mode" "true"
  set_toml_key "$codex_dir/config.toml" "agents" "max_threads" "6"
  set_toml_key "$codex_dir/config.toml" "agents" "max_depth" "1"

  echo "Installed Codex project config in $project_dir"
}

setup_codex() {
  local do_global=0
  local project_dir=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --global)
        do_global=1
        shift
        ;;
      --project)
        project_dir="${2:-}"
        if [[ -z "$project_dir" ]]; then
          echo "--project requires a path" >&2
          exit 1
        fi
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown option for codex setup: $1" >&2
        usage
        exit 1
        ;;
    esac
  done

  if [[ "$do_global" -eq 0 && -z "$project_dir" ]]; then
    do_global=1
  fi

  if [[ "$do_global" -eq 1 ]]; then
    install_codex_global
  fi

  if [[ -n "$project_dir" ]]; then
    mkdir -p "$project_dir"
    install_codex_project "$(cd "$project_dir" && pwd)"
  fi
}

main() {
  case "${1:-}" in
    codex)
      shift
      setup_codex "$@"
      ;;
    -h|--help|"")
      usage
      ;;
    *)
      echo "Unknown setup target: $1" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
