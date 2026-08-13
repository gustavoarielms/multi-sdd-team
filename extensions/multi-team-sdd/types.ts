export type AgentSource = "package" | "user" | "project";

export type AgentScope = "package" | "user" | "project" | "both";

export type SecurityMode = "passive" | "active";

export interface AgentConfig {
  name: string;
  role: string;
  description: string;
  shortDescription: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  userAgentsDir: string;
  packageAgentsDir: string;
}

export interface RuntimeState {
  securityMode: SecurityMode;
  orchestratorEnabled: boolean;
  updatedAt: string;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: AgentSource | "unknown";
  task: string;
  exitCode: number;
  messages: any[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  governanceResult?: Record<string, unknown>;
  step?: number;
}

export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  results: SingleResult[];
  agentScope: AgentScope;
  securityMode: SecurityMode;
}

export const DEFAULT_SHORT_DESCRIPTIONS: Record<string, string> = {
  orchestrator: "Routing y coordinación",
  explorer: "Recon del codebase",
  documentator: "Specs func + tech",
  planner: "Plan en tareas",
  "architecture-reviewer": "Architecture gate",
  implementer: "TDD: tests + código",
  "tester-reviewer": "Static + E2E",
  hacker: "Security audit/red team",
};

export const AGENT_COLOR: Record<string, "accent" | "warning" | "muted" | "success" | "toolTitle" | "error" | "mdHeading"> = {
  orchestrator: "accent",
  explorer: "warning",
  documentator: "mdHeading",
  planner: "muted",
  "architecture-reviewer": "accent",
  implementer: "success",
  "tester-reviewer": "toolTitle",
  hacker: "error",
};
