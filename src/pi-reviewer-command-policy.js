const reviewerRoles = new Set(["architecture-reviewer", "architecture_reviewer", "tester-reviewer", "tester_reviewer", "hacker"]);
const reviewerInspectionTools = new Set(["read", "grep", "find", "ls"]);

export function isPiReviewerRole(role) {
  return reviewerRoles.has(String(role ?? "").trim());
}

export function evaluatePiReviewerToolCall(role, toolName) {
  if (!isPiReviewerRole(role)) return { allowed: true };
  return reviewerInspectionTools.has(String(toolName ?? "").trim())
    ? { allowed: true }
    : { allowed: false, reason: "review agents may only inspect provided evidence" };
}
