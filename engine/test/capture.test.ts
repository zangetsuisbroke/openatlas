import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger, archivePathFor } from "../src/ledger";
import { Capturer } from "../src/capture";

const dir = path.join(os.tmpdir(), "openatlas-capture-test", Math.random().toString(36).slice(2));
const ledger = new Ledger(archivePathFor(dir), { root: dir, label: "capture-test" });
const cap = new Capturer(ledger);

const SID = "session_1";

function ev(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return { id: `ev_${Math.random()}`, type, data };
}

describe("capturer", () => {
  test("captures user task", () => {
    cap.ingest(
      ev("message.updated", {
        sessionID: SID,
        info: { id: "m1", role: "user", parts: [{ type: "text", text: "fix the login bug in src/auth.ts" }] },
      })
    );
    const steps = ledger.listSteps(SID);
    const task = steps.find((s) => s.kind === "task");
    expect(task).toBeDefined();
    expect(task?.content).toContain("login bug");
    expect(ledger.listFiles(task!.id).some((f) => f.path === "src/auth.ts")).toBe(true);
  });

  test("captures tool call + success pair as one action step", () => {
    cap.ingest(
      ev("session.next.tool.called", {
        sessionID: SID,
        assistantMessageID: "m2",
        callID: "c1",
        tool: "read",
        input: { filePath: "src/auth.ts" },
      })
    );
    cap.ingest(
      ev("session.next.tool.success", {
        sessionID: SID,
        callID: "c1",
        structured: { ok: true },
        content: [{ type: "text", text: "file contents here src/auth.ts" }],
      })
    );
    const steps = ledger.listSteps(SID);
    const action = steps.find((s) => s.role === "tool");
    expect(action).toBeDefined();
    expect(action?.outcome).toBe("success");
    const outputs = ledger.listPayloads(action!.id).filter((p) => p.kind === "output");
    expect(outputs.length).toBe(1);
    expect(outputs[0]?.data).toContain("file contents");
  });

  test("captures a failed tool as error step + CAUSED_BY link", () => {
    cap.ingest(
      ev("session.next.tool.called", {
        sessionID: SID,
        assistantMessageID: "m3",
        callID: "c2",
        tool: "bash",
        input: { command: "bun test" },
      })
    );
    cap.ingest(
      ev("session.next.tool.failed", {
        sessionID: SID,
        callID: "c2",
        error: { message: "exit code 1" },
      })
    );
    const steps = ledger.listSteps(SID);
    const error = steps.find((s) => s.kind === "error");
    expect(error).toBeDefined();
    const links = ledger.getLinks(error!.id);
    expect(links.some((l) => l.relation === "CAUSED_BY" && l.origin === "auto")).toBe(true);
  });

  test("test-running bash becomes a verification step", () => {
    cap.ingest(
      ev("session.next.tool.called", {
        sessionID: SID,
        assistantMessageID: "m4",
        callID: "c3",
        tool: "bash",
        input: { command: "bun test engine/test" },
      })
    );
    const steps = ledger.listSteps(SID);
    const verification = steps.find((s) => s.meta?.callID === "c3");
    expect(verification?.kind).toBe("verification");
  });

  test("captures diff as payload + target file refs", () => {
    cap.ingest(
      ev("message.updated", {
        sessionID: SID,
        info: { id: "m5", role: "assistant", parts: [{ type: "text", text: "i'll patch auth" }] },
      })
    );
    cap.ingest(
      ev("session.diff", {
        sessionID: SID,
        diff: [
          {
            file: "src/auth.ts",
            patch: "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new",
            additions: 1,
            deletions: 1,
            status: "modified",
          },
        ],
      })
    );
    const steps = ledger.listSteps(SID);
    const last = steps[steps.length - 1]!;
    expect(last.kind).toBe("plan");
    const diffPayloads = ledger.listPayloads(last.id).filter((p) => p.kind === "diff");
    expect(diffPayloads.length).toBe(1);
    expect(ledger.listFiles(last.id).some((f) => f.path === "src/auth.ts" && f.kind === "target")).toBe(true);
  });

  test("finalize sets title/summary but leaves ended_at null (session.idle fires between turns)", () => {
    cap.finalizeSession(SID);
    const s = ledger.getSession(SID);
    expect(s?.endedAt).toBeNull();
    expect(s?.title).toContain("login bug");
    expect(ledger.listLinks(SID).length).toBeGreaterThan(0);
  });
});
