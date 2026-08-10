import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger, archivePathFor } from "../src/ledger";
import { buildReport } from "../src/habits";

function sessionWith(ledger: Ledger, events: Array<{ kind: "action" | "error" | "fix"; content: string; file?: string }>): string {
  const s = ledger.createSession({});
  ledger.addStep({ sessionId: s.id, kind: "task", role: "user", content: "the task" });
  for (const e of events) {
    const step = ledger.addStep({ sessionId: s.id, kind: e.kind, role: "tool", content: e.content, meta: { tool: e.kind === "error" ? "bash" : "edit" } });
    if (e.file) ledger.addFileRef(step.id, e.file, "target");
  }
  ledger.finishSession(s.id, { title: "the task" });
  return s.id;
}

describe("habits", () => {
  test("detects rework (file edited 3+ times)", () => {
    const dir = path.join(os.tmpdir(), "openatlas-habits-test", Math.random().toString(36).slice(2));
    const ledger = new Ledger(archivePathFor(dir), { root: dir, label: "habits-test" });
    sessionWith(ledger, [
      { kind: "action", content: "edit src/foo.ts", file: "src/foo.ts" },
      { kind: "action", content: "edit src/foo.ts", file: "src/foo.ts" },
      { kind: "action", content: "edit src/foo.ts", file: "src/foo.ts" },
      { kind: "fix", content: "bun test", file: "src/foo.ts" },
    ]);
    const report = buildReport(ledger, "project");
    expect(report.sessionCount).toBe(1);
    expect(report.aggregate.reworkFiles).toContain("src/foo.ts");
    expect(report.aggregate.flags.some((f) => f.startsWith("rework"))).toBe(true);
  });

  test("detects missing tests", () => {
    const dir = path.join(os.tmpdir(), "openatlas-habits-test2", Math.random().toString(36).slice(2));
    const ledger = new Ledger(archivePathFor(dir), { root: dir, label: "habits-test2" });
    sessionWith(ledger, [{ kind: "action", content: "edit src/foo.ts", file: "src/foo.ts" }]);
    const report = buildReport(ledger, "project");
    expect(report.aggregate.flags.some((f) => f.startsWith("noTests"))).toBe(true);
  });

  test("counts tools and errors", () => {
    const dir = path.join(os.tmpdir(), "openatlas-habits-test3", Math.random().toString(36).slice(2));
    const ledger = new Ledger(archivePathFor(dir), { root: dir, label: "habits-test3" });
    sessionWith(ledger, [
      { kind: "action", content: "read", file: "src/a.ts" },
      { kind: "action", content: "edit", file: "src/a.ts" },
      { kind: "error", content: "bash failed" },
    ]);
    const report = buildReport(ledger, "project");
    const signal = report.signals[0]!;
    expect(signal.toolCount).toBe(3);
    expect(signal.errorCount).toBe(1);
    expect(signal.errorRate).toBeCloseTo(1 / 3);
  });
});
