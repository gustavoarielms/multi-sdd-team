import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { discoverAgents } from "./agent-registry.js";
import { registerCommands } from "./commands.js";
import { buildOrchestratorPrompt } from "./orchestrator-context.js";
import { registerSubagentTool } from "./subagent-tool.js";
import { getRuntimeState, restoreRuntimeState } from "./state.js";
import { clearSubagentWidget, renderSubagentWidget } from "./ui-subagents-widget.js";

function refreshUi(ctx: ExtensionContext): void {
  const state = getRuntimeState();
  const discovery = discoverAgents(ctx.cwd, "both");

  renderSubagentWidget(ctx, discovery.agents);

  if (ctx.hasUI) {
    const orchestrator = state.orchestratorEnabled
      ? ctx.ui.theme.fg("success", "orchestrator:on")
      : ctx.ui.theme.fg("warning", "orchestrator:off");
    const security = state.securityMode === "active"
      ? ctx.ui.theme.fg("error", "security:active")
      : ctx.ui.theme.fg("muted", "security:passive");

    ctx.ui.setStatus("multi-team-sdd", `${orchestrator} ${ctx.ui.theme.fg("dim", "|")} ${security}`);
  }
}

export default function multiTeamSdd(pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT_CHILD === "1") {
    return;
  }

  registerSubagentTool(pi);
  registerCommands(pi);

  const restoreAndRefresh = (_event: unknown, ctx: ExtensionContext) => {
    restoreRuntimeState(ctx);
    refreshUi(ctx);
  };

  pi.on("session_start", restoreAndRefresh);
  pi.on("session_tree", restoreAndRefresh);

  pi.on("before_agent_start", async (event, ctx) => {
    const state = getRuntimeState();
    if (!state.orchestratorEnabled) return;

    const orchestratorPrompt = buildOrchestratorPrompt(state);
    return {
      systemPrompt: `${event.systemPrompt}\n\n${orchestratorPrompt}`,
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearSubagentWidget(ctx);
    if (ctx.hasUI) {
      ctx.ui.setStatus("multi-team-sdd", undefined);
    }
  });
}
