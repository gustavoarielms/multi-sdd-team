import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { AGENT_COLOR, DEFAULT_SHORT_DESCRIPTIONS, type AgentConfig } from "./types.js";

const WIDGET_ID = "multi-team-sdd-subagents";
const CARD_WIDTH = 24;
const CARD_HEIGHT = 4;
const GAP = 2;

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value;
  return value + " ".repeat(width - value.length);
}

function cardLines(agent: AgentConfig, theme: ExtensionContext["ui"]["theme"]): string[] {
  const colorKey = AGENT_COLOR[agent.name] ?? "accent";
  const inner = CARD_WIDTH - 2;
  const title = pad(truncate(agent.name.toUpperCase(), inner - 2), inner - 2);
  const short = pad(truncate(agent.shortDescription || DEFAULT_SHORT_DESCRIPTIONS[agent.name] || agent.description, inner - 2), inner - 2);

  const top = theme.fg(colorKey, `┌${"─".repeat(CARD_WIDTH - 2)}┐`);
  const name = `${theme.fg(colorKey, "│")}${theme.fg(colorKey, ` ${title} `)}${theme.fg(colorKey, "│")}`;
  const desc = `${theme.fg(colorKey, "│")}${theme.fg("muted", ` ${short} `)}${theme.fg(colorKey, "│")}`;
  const bottom = theme.fg(colorKey, `└${"─".repeat(CARD_WIDTH - 2)}┘`);

  return [top, name, desc, bottom];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function buildLines(agents: AgentConfig[], width: number, theme: ExtensionContext["ui"]["theme"]): string[] {
  if (agents.length === 0) return [theme.fg("muted", "(sin subagentes)")];

  const cardsPerRow = Math.max(1, Math.floor((width + GAP) / (CARD_WIDTH + GAP)));
  const rows = chunk(agents, cardsPerRow);
  const lines: string[] = [];

  for (const row of rows) {
    const cards = row.map((agent) => cardLines(agent, theme));
    for (let line = 0; line < CARD_HEIGHT; line += 1) {
      lines.push(cards.map((card) => card[line]).join(" ".repeat(GAP)));
    }
    lines.push("");
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

export function renderSubagentWidget(ctx: ExtensionContext, agents: AgentConfig[]): void {
  if (!ctx.hasUI) return;

  ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => ({
    render(width: number): string[] {
      return buildLines(agents, width, theme);
    },
    invalidate() {},
  }));
}

export function clearSubagentWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_ID, undefined);
}
