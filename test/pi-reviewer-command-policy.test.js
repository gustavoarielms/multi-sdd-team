import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePiReviewerToolCall } from "../src/pi-reviewer-command-policy.js";

const reviewers = ["architecture-reviewer", "tester-reviewer", "hacker"];

for (const role of reviewers) {
  test(`${role} Pi tool policy permits only non-mutating direct inspection tools`, () => {
    assert.deepEqual(evaluatePiReviewerToolCall(role, "read"), { allowed: true });
    assert.deepEqual(evaluatePiReviewerToolCall(role, "grep"), { allowed: true });
  });

  test(`${role} Pi tool policy rejects shell and mutation tools fail closed`, () => {
    for (const command of [
      "sed -i backup source.js",
      "find . -fprint output.txt",
      "node --test",
      "npm run check",
      "rg --pre helper pattern",
      "git diff --textconv",
    ]) {
      assert.equal(evaluatePiReviewerToolCall(role, "bash", { command }).allowed, false, command);
    }
    assert.equal(evaluatePiReviewerToolCall(role, "write").allowed, false);
    assert.equal(evaluatePiReviewerToolCall(role, "edit").allowed, false);
    assert.equal(evaluatePiReviewerToolCall(role, "unknown-tool").allowed, false);
  });
}
