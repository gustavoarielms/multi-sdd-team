import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { discoverAgents } from "./agent-registry.js";
import { getRuntimeState } from "./state.js";
import type { AgentConfig, AgentScope, SecurityMode, SingleResult, SubagentDetails, UsageStats } from "./types.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_DEPTH = 2;

const here = path.dirname(fileURLToPath(import.meta.url));
const childGuardrailsExtensionPath = path.resolve(here, "./child-guardrails.ts");

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

function formatUsage(usage: UsageStats): string {
  const parts: string[] = [];
  if (usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input > 0) parts.push(`↑${usage.input}`);
  if (usage.output > 0) parts.push(`↓${usage.output}`);
  if (usage.cacheRead > 0) parts.push(`R${usage.cacheRead}`);
  if (usage.cacheWrite > 0) parts.push(`W${usage.cacheWrite}`);
  if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens > 0) parts.push(`ctx:${usage.contextTokens}`);
  return parts.join(" ");
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");

  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };

  return { command: "pi", args };
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;

  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  securityMode: SecurityMode,
  currentDepth: number,
): Promise<SingleResult> {
  const agent = agents.find((candidate) => candidate.name === agentName);

  if (!agent) {
    const available = agents.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      step,
    };
  }

  const args: string[] = ["--mode", "json", "-p", "--no-session", "-e", childGuardrailsExtensionPath];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: agent.model,
    step,
  };

  const emitUpdate = () => {
    if (!onUpdate) return;
    onUpdate({
      content: [{ type: "text", text: getFinalOutput(currentResult.messages as Message[]) || "(running...)" }],
      details: makeDetails([currentResult]),
    });
  };

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    args.push(`Task: ${task}`);

    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PI_SUBAGENT_CHILD: "1",
          PI_SUBAGENT_ROLE: agent.name,
          PI_SUBAGENT_SECURITY_MODE: securityMode,
          PI_SUBAGENT_DEPTH: String(currentDepth + 1),
        },
      });

      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;

        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          currentResult.messages.push(msg);

          if (msg.role === "assistant") {
            currentResult.usage.turns += 1;
            const usage = msg.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && msg.model) currentResult.model = msg.model;
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
          }

          emitUpdate();
        }

        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message as Message);
          emitUpdate();
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data) => {
        currentResult.stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        resolve(1);
      });

      if (signal) {
        const abort = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 3000);
        };

        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    if (wasAborted) throw new Error("Subagent was aborted");

    return currentResult;
  } finally {
    if (tmpPromptPath) {
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        // ignore
      }
    }

    if (tmpPromptDir) {
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        // ignore
      }
    }
  }
}

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate. Supports {previous} placeholder." }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent" })),
});

const AgentScopeSchema = StringEnum(["package", "user", "project", "both"] as const, {
  description: "Which agent sources to include.",
  default: "package",
});

const SecurityModeSchema = StringEnum(["passive", "active"] as const, {
  description: "Security mode used by child guardrails.",
  default: "passive",
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Single mode: agent name" })),
  task: Type.Optional(Type.String({ description: "Single mode: delegated task" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel mode" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Chain mode" })),
  cwd: Type.Optional(Type.String({ description: "Single mode working directory" })),
  agentScope: Type.Optional(AgentScopeSchema),
  securityMode: Type.Optional(SecurityModeSchema),
});

export function registerSubagentTool(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") {
    return;
  }

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate tasks to specialized subagents in isolated context windows (single, parallel, chain).",
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const state = getRuntimeState();
      const agentScope = params.agentScope ?? "package";
      const securityMode = params.securityMode ?? state.securityMode;
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;
      const currentDepth = Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0;

      if (currentDepth >= MAX_DEPTH) {
        return {
          content: [{ type: "text", text: `Subagent max depth reached (${MAX_DEPTH}).` }],
          details: {
            mode: "single",
            results: [],
            agentScope,
            securityMode,
          },
          isError: true,
        };
      }

      const hasSingle = Boolean(params.agent && params.task);
      const hasParallel = (params.tasks?.length ?? 0) > 0;
      const hasChain = (params.chain?.length ?? 0) > 0;
      const modeCount = Number(hasSingle) + Number(hasParallel) + Number(hasChain);

      const makeDetails =
        (mode: "single" | "parallel" | "chain") =>
        (results: SingleResult[]): SubagentDetails => ({
          mode,
          results,
          agentScope,
          securityMode,
        });

      if (modeCount !== 1) {
        return {
          content: [{ type: "text", text: "Invalid parameters. Provide exactly one mode: single, tasks, or chain." }],
          details: makeDetails("single")([]),
          isError: true,
        };
      }

      if (hasParallel && (params.tasks?.length ?? 0) > MAX_PARALLEL_TASKS) {
        return {
          content: [{ type: "text", text: `Too many parallel tasks (${params.tasks?.length}). Max: ${MAX_PARALLEL_TASKS}.` }],
          details: makeDetails("parallel")([]),
          isError: true,
        };
      }

      if (hasSingle) {
        const result = await runSingleAgent(
          ctx.cwd,
          agents,
          params.agent!,
          params.task!,
          params.cwd,
          undefined,
          signal,
          onUpdate,
          makeDetails("single"),
          securityMode,
          currentDepth,
        );

        const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
        if (isError) {
          const errorText = result.errorMessage || result.stderr || getFinalOutput(result.messages as Message[]) || "(no output)";
          return {
            content: [{ type: "text", text: `Agent failed (${result.agent}): ${errorText}` }],
            details: makeDetails("single")([result]),
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: getFinalOutput(result.messages as Message[]) || "(no output)" }],
          details: makeDetails("single")([result]),
        };
      }

      if (hasChain) {
        const results: SingleResult[] = [];
        let previous = "";

        for (let index = 0; index < (params.chain?.length ?? 0); index += 1) {
          const step = params.chain![index];
          const task = step.task.replaceAll("{previous}", previous);

          const chainUpdate = onUpdate
            ? (partial: AgentToolResult<SubagentDetails>) => {
                const current = partial.details?.results?.[0];
                if (!current) return;
                onUpdate({
                  content: partial.content,
                  details: makeDetails("chain")([...results, current]),
                });
              }
            : undefined;

          const result = await runSingleAgent(
            ctx.cwd,
            agents,
            step.agent,
            task,
            step.cwd,
            index + 1,
            signal,
            chainUpdate,
            makeDetails("chain"),
            securityMode,
            currentDepth,
          );

          results.push(result);

          const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
          if (isError) {
            const errorText = result.errorMessage || result.stderr || getFinalOutput(result.messages as Message[]) || "(no output)";
            return {
              content: [{ type: "text", text: `Chain stopped at step ${index + 1} (${step.agent}): ${errorText}` }],
              details: makeDetails("chain")(results),
              isError: true,
            };
          }

          previous = getFinalOutput(result.messages as Message[]);
        }

        const lastOutput = results.length > 0 ? getFinalOutput(results[results.length - 1].messages as Message[]) : "";
        return {
          content: [{ type: "text", text: lastOutput || "(no output)" }],
          details: makeDetails("chain")(results),
        };
      }

      const allResults: SingleResult[] = new Array(params.tasks?.length ?? 0).fill(null).map((_, idx) => ({
        agent: params.tasks![idx].agent,
        agentSource: "unknown",
        task: params.tasks![idx].task,
        exitCode: -1,
        messages: [],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      }));

      const emitParallelUpdate = () => {
        if (!onUpdate) return;
        const done = allResults.filter((result) => result.exitCode !== -1).length;
        const running = allResults.length - done;

        onUpdate({
          content: [{ type: "text", text: `Parallel progress: ${done}/${allResults.length} done, ${running} running` }],
          details: makeDetails("parallel")([...allResults]),
        });
      };

      const results = await mapWithConcurrencyLimit(params.tasks ?? [], MAX_CONCURRENCY, async (taskItem, index) => {
        const result = await runSingleAgent(
          ctx.cwd,
          agents,
          taskItem.agent,
          taskItem.task,
          taskItem.cwd,
          undefined,
          signal,
          (partial) => {
            const current = partial.details?.results?.[0];
            if (!current) return;
            allResults[index] = current;
            emitParallelUpdate();
          },
          makeDetails("parallel"),
          securityMode,
          currentDepth,
        );

        allResults[index] = result;
        emitParallelUpdate();
        return result;
      });

      const success = results.filter((result) => result.exitCode === 0).length;
      return {
        content: [{ type: "text", text: `Parallel finished: ${success}/${results.length} succeeded.` }],
        details: makeDetails("parallel")(results),
      };
    },

    renderCall(args, theme) {
      const scope = args.agentScope ?? "package";
      if (args.chain?.length) {
        return new Text(
          `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `chain (${args.chain.length})`)}${theme.fg("muted", ` [${scope}]`)}`,
          0,
          0,
        );
      }

      if (args.tasks?.length) {
        return new Text(
          `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${args.tasks.length})`)}${theme.fg("muted", ` [${scope}]`)}`,
          0,
          0,
        );
      }

      const agent = args.agent || "...";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", agent)}${theme.fg("muted", ` [${scope}]`)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const container = new Container();
      const status = details.mode === "single"
        ? `${details.results.filter((r) => r.exitCode === 0).length}/${details.results.length}`
        : `${details.mode}: ${details.results.filter((r) => r.exitCode === 0).length}/${details.results.length}`;

      container.addChild(new Text(`${theme.fg("accent", theme.bold("Subagents"))} ${theme.fg("muted", `[${status}]`)}`, 0, 0));

      for (const r of details.results) {
        const icon = r.exitCode === 0 ? theme.fg("success", "✓") : r.exitCode === -1 ? theme.fg("warning", "⏳") : theme.fg("error", "✗");
        const line = `${icon} ${theme.fg("toolTitle", r.agent)} ${theme.fg("muted", `(${r.agentSource})`)}`;
        container.addChild(new Text(line, 0, 0));

        const output = getFinalOutput(r.messages as Message[]);
        if (expanded && output) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(output, 0, 0));
        } else if (output) {
          const preview = output.split("\n")[0].slice(0, 120);
          container.addChild(new Text(theme.fg("dim", preview), 0, 0));
        }

        const usage = formatUsage(r.usage);
        if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));

        container.addChild(new Spacer(1));
      }

      return container;
    },
  });
}
