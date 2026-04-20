import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { DEFAULT_SHORT_DESCRIPTIONS, type AgentConfig, type AgentDiscoveryResult, type AgentScope } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageAgentsDir = path.resolve(here, "../../agents");

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let current = cwd;
  while (true) {
    const candidate = path.join(current, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function loadAgentsFromDir(dir: string, source: "package" | "user" | "project"): AgentConfig[] {
  if (!isDirectory(dir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    const name = (frontmatter.name || path.basename(entry.name, ".md")).trim();
    const description = (frontmatter.description || `Agent ${name}`).trim();
    const role = (frontmatter.role || name).trim();

    const parsedTools = frontmatter.tools
      ?.split(",")
      .map((tool) => tool.trim())
      .filter(Boolean);

    const shortDescription = (frontmatter.shortDescription || frontmatter.short || DEFAULT_SHORT_DESCRIPTIONS[name] || description)
      .trim();

    agents.push({
      name,
      role,
      description,
      shortDescription,
      tools: parsedTools && parsedTools.length > 0 ? parsedTools : undefined,
      model: frontmatter.model?.trim(),
      systemPrompt: body.trim(),
      source,
      filePath,
    });
  }

  return agents;
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const userAgentsDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const packageAgents = loadAgentsFromDir(packageAgentsDir, "package");
  const userAgents = scope === "project" || scope === "package" ? [] : loadAgentsFromDir(userAgentsDir, "user");
  const projectAgents = scope === "user" || scope === "package" || !projectAgentsDir
    ? []
    : loadAgentsFromDir(projectAgentsDir, "project");

  const merged = new Map<string, AgentConfig>();

  for (const agent of packageAgents) merged.set(agent.name, agent);
  for (const agent of userAgents) merged.set(agent.name, agent);
  for (const agent of projectAgents) merged.set(agent.name, agent);

  return {
    agents: Array.from(merged.values()),
    projectAgentsDir,
    userAgentsDir,
    packageAgentsDir,
  };
}

export function formatAgentList(agents: AgentConfig[], maxItems = 20): { text: string; remaining: number } {
  if (agents.length === 0) return { text: "none", remaining: 0 };
  const listed = agents.slice(0, maxItems);
  const remaining = agents.length - listed.length;
  const text = listed
    .map((agent) => `${agent.name} [${agent.source}] ${agent.shortDescription}`)
    .join("; ");
  return { text, remaining };
}
