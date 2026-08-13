import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { evaluatePiReviewerToolCall } from "../../src/pi-reviewer-command-policy.js";

const role = process.env.PI_SUBAGENT_ROLE?.trim();
const securityMode = process.env.PI_SUBAGENT_SECURITY_MODE === "active" ? "active" : "passive";

const highRiskPatterns = [
  /\brm\s+-rf\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-fd\b/,
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /:\(\)\s*\{\s*:\|:\s*&\s*\};:/,
];

function normalizePath(p: string): string {
  return p.startsWith("@") ? p.slice(1) : p;
}

function isInsideDocs(targetPath: string, cwd: string): boolean {
  const absoluteTarget = path.resolve(cwd, normalizePath(targetPath));
  const docsRoot = path.resolve(cwd, "docs");
  return absoluteTarget === docsRoot || absoluteTarget.startsWith(`${docsRoot}${path.sep}`);
}

export default function childGuardrails(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const reviewerPolicy = evaluatePiReviewerToolCall(role, event.toolName);
    if (!reviewerPolicy.allowed) {
      return { block: true, reason: reviewerPolicy.reason ?? "reviewer tool rejected" };
    }

    if (role === "documentator" && (event.toolName === "write" || event.toolName === "edit")) {
      const pathValue = (event.input as Record<string, unknown>).path;
      if (typeof pathValue !== "string") return;

      if (!isInsideDocs(pathValue, ctx.cwd)) {
        return { block: true, reason: `documentator can only write under ./docs (got: ${pathValue})` };
      }
    }

    if (event.toolName === "bash" && typeof (event.input as Record<string, unknown>).command === "string") {
      const command = (event.input as { command: string }).command;

      const isHighRisk = highRiskPatterns.some((pattern) => pattern.test(command));
      if (isHighRisk && securityMode === "passive") {
        return { block: true, reason: `blocked high-risk command in passive mode: ${command}` };
      }

      if (isHighRisk && securityMode === "active" && role !== "hacker") {
        return { block: true, reason: `high-risk commands in active mode are restricted to hacker role (role=${role ?? "unknown"})` };
      }
    }
  });
}
