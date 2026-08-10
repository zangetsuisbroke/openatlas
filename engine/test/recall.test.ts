import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger, archivePathFor } from "../src/ledger";
import { Recall } from "../src/recall";

function setup(): { recall: Recall; ledger: Ledger; sid: string } {
  const dir = path.join(os.tmpdir(), "openatlas-recall-test", Math.random().toString(36).slice(2));
  const ledger = new Ledger(archivePathFor(dir), { root: dir, label: "recall-test" });
  const recall = new Recall(ledger);
  const s = ledger.createSession({});
  const task = ledger.addStep({ sessionId: s.id, kind: "task", role: "user", content: "make login page handle wrong password" });
  const plan = ledger.addStep({ sessionId: s.id, kind: "plan", role: "assistant", content: "check auth flow in src/auth.ts", parentId: task.id });
  const err = ledger.addStep({ sessionId: s.id, kind: "error", role: "tool", content: "password check always returns true", parentId: plan.id });
  const root = ledger.addStep({ sessionId: s.id, kind: "root_cause", role: "assistant", content: "missing length check", parentId: plan.id });
  const fix = ledger.addStep({ sessionId: s.id, kind: "fix", role: "tool", content: "added check to src/auth.ts", parentId: plan.id });
  const verify = ledger.addStep({ sessionId: s.id, kind: "verification", role: "tool", content: "bun test passes", parentId: fix.id });
  const lesson = ledger.addStep({ sessionId: s.id, kind: "lesson", role: "assistant", content: "always validate length", parentId: root.id });
  ledger.addFileRef(task.id, "src/auth.ts", "mention");
  ledger.addFileRef(plan.id, "src/auth.ts", "read");
  ledger.addFileRef(fix.id, "src/auth.ts", "target");
  ledger.link({ sourceStepId: err.id, targetStepId: plan.id, relation: "CAUSED_BY", origin: "auto" });
  ledger.link({ sourceStepId: fix.id, targetStepId: err.id, relation: "FIXES", origin: "auto" });
  ledger.link({ sourceStepId: verify.id, targetStepId: fix.id, relation: "REFINES", origin: "auto" });
  ledger.link({ sourceStepId: lesson.id, targetStepId: root.id, relation: "BASED_ON", origin: "agent" });
  ledger.finishSession(s.id);
  void task;
  return { recall, ledger, sid: s.id };
}

describe("recall", () => {
  test("word-overlap recall returns a chain with root cause and lesson", () => {
    const { recall } = setup();
    const chains = recall.query({ q: "password login check", k: 3 });
    expect(chains.length).toBeGreaterThan(0);
    const chain = chains[0]!;
    expect(chain.steps.length).toBeGreaterThanOrEqual(4);
    expect(chain.rootCauses.length).toBe(1);
    expect(chain.lessons.length).toBe(1);
    expect(chain.files).toContain("src/auth.ts");
  });

  test("file-scoped recall finds everything touching a file", () => {
    const { recall } = setup();
    const chains = recall.query({ file: "src/auth.ts", k: 3 });
    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) expect(chain.files).toContain("src/auth.ts");
  });

  test("recall returns nothing for unrelated query", () => {
    const { recall } = setup();
    const chains = recall.query({ q: "quantum entanglement theory", k: 3 });
    expect(chains.length).toBe(0);
  });
});
