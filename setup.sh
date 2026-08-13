#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_TEMPLATE_DIR="$ROOT_DIR/codex"
GOVERNANCE_SCHEMA_DIR="$ROOT_DIR/governance/schemas/v1"
GOVERNANCE_RULE_DIR="$ROOT_DIR/governance/rules/v1"
GOVERNANCE_CHECK_DIR="$ROOT_DIR/governance/checks/v1"

usage() {
  cat <<'USAGE'
multi-sdd-team setup

Usage:
  ./setup.sh --global
  ./setup.sh --project /path/to/project
  ./setup.sh --global --project /path/to/project

Options:
  --global              Install globally under ~/.codex.
  --project <path>      Install project-scoped config into <path>.
  -h, --help            Show this help.

Examples:
  ./setup.sh --global
  ./setup.sh --project "$PWD"
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
  if [[ ! -f "$GOVERNANCE_RULE_DIR/catalog.json" || ! -f "$GOVERNANCE_CHECK_DIR/registry.json" ]]; then
    echo "Missing governance catalog or check registry" >&2
    exit 1
  fi
}

run_node_installer() {
  local scope="$1"
  local target="$2"

  node --input-type=module - "$scope" "$target" "$ROOT_DIR" <<'JS'
import path from "node:path";
import { pathToFileURL } from "node:url";

const [scope, target, packageRoot] = process.argv.slice(2);
const installer = await import(pathToFileURL(path.join(packageRoot, "src", "installer.js")));
if (scope === "global") await installer.installGlobal(target);
else await installer.installProject(target);
JS
}

install_codex_global() {
  require_codex_templates

  local codex_home="${CODEX_HOME:-$HOME/.codex}"
  run_node_installer "global" "$codex_home"

  echo "Installed Codex global config in $codex_home"
}

install_codex_project() {
  require_codex_templates

  local project_dir="$1"
  run_node_installer "project" "$project_dir"

  echo "Installed Codex project config in $project_dir"
}

setup() {
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
        echo "Unknown setup option: $1" >&2
        usage
        exit 1
        ;;
    esac
  done

  if [[ "$do_global" -eq 0 && -z "$project_dir" ]]; then
    usage >&2
    exit 1
  fi

  if [[ "$do_global" -eq 1 ]]; then
    install_codex_global
  fi

  if [[ -n "$project_dir" ]]; then
    install_codex_project "$project_dir"
  fi
}

setup "$@"
