import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { discoverAgents } from "./agent-registry.js";
import { getRuntimeState, persistRuntimeState, setOrchestratorEnabled, setSecurityMode } from "./state.js";
import { renderSubagentWidget } from "./ui-subagents-widget.js";

function formatAgentsTable(ctx: ExtensionCommandContext): string {
  const discovery = discoverAgents(ctx.cwd, "both");
  const agents = discovery.agents.sort((a, b) => a.name.localeCompare(b.name));

  const lines: string[] = [
    "# Subagents",
    "",
    "| Name | Source | Tools | Short Description |",
    "|---|---|---|---|",
  ];

  for (const agent of agents) {
    lines.push(`| ${agent.name} | ${agent.source} | ${(agent.tools ?? ["(default)"]).join(", ")} | ${agent.shortDescription} |`);
  }

  lines.push("", `Total: ${agents.length}`);
  return lines.join("\n");
}

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("subagents", {
    description: "List available specialized subagents",
    handler: async (_args, ctx) => {
      const text = formatAgentsTable(ctx);
      if (ctx.hasUI) {
        await ctx.ui.editor("Subagents", text);
      } else {
        process.stdout.write(`${text}\n`);
        ctx.shutdown();
      }
    },
  });

  pi.registerCommand("orchestrator-status", {
    description: "Show orchestrator and security mode status",
    handler: async (_args, ctx) => {
      const state = getRuntimeState();
      const discovery = discoverAgents(ctx.cwd, "both");
      const lines = [
        "# Multi-Team SDD Status",
        "",
        `- orchestrator: ${state.orchestratorEnabled ? "enabled" : "disabled"}`,
        `- security mode: ${state.securityMode}`,
        `- discovered agents: ${discovery.agents.length}`,
        `- package agents dir: ${discovery.packageAgentsDir}`,
        `- user agents dir: ${discovery.userAgentsDir}`,
        `- project agents dir: ${discovery.projectAgentsDir ?? "(none)"}`,
      ];

      const text = lines.join("\n");
      if (ctx.hasUI) {
        await ctx.ui.editor("Orchestrator status", text);
      } else {
        process.stdout.write(`${text}\n`);
        ctx.shutdown();
      }
    },
  });

  pi.registerCommand("security-mode", {
    description: "Set security mode: /security-mode passive|active",
    handler: async (args, ctx) => {
      const requested = (args ?? "").trim();
      if (requested !== "passive" && requested !== "active") {
        const usage = "Usage: /security-mode passive|active";
        if (ctx.hasUI) {
          ctx.ui.notify(usage, "warning");
        } else {
          process.stdout.write(`${usage}\n`);
        }
        return;
      }

      if (requested === "active" && ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Enable active security mode?",
          "Active mode allows high-risk security commands for the hacker agent. Continue?",
        );
        if (!ok) return;
      }

      setSecurityMode(requested);
      persistRuntimeState(pi);

      const agents = discoverAgents(ctx.cwd, "both").agents;
      renderSubagentWidget(ctx, agents);

      if (ctx.hasUI) {
        ctx.ui.notify(`Security mode set to ${requested}`, "info");
      } else {
        process.stdout.write(`Security mode set to ${requested}\n`);
      }
    },
  });

  pi.registerCommand("orchestrator", {
    description: "Enable/disable orchestrator: /orchestrator on|off",
    handler: async (args, ctx) => {
      const requested = (args ?? "").trim().toLowerCase();
      if (requested !== "on" && requested !== "off") {
        const usage = "Usage: /orchestrator on|off";
        if (ctx.hasUI) ctx.ui.notify(usage, "warning");
        else process.stdout.write(`${usage}\n`);
        return;
      }

      setOrchestratorEnabled(requested === "on");
      persistRuntimeState(pi);

      const label = requested === "on" ? "enabled" : "disabled";
      if (ctx.hasUI) ctx.ui.notify(`Orchestrator ${label}`, "info");
      else process.stdout.write(`Orchestrator ${label}\n`);
    },
  });
}
