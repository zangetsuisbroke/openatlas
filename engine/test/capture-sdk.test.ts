import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger, archivePathFor } from "../src/ledger";
import { Capturer } from "../src/capture";

const dir = path.join(os.tmpdir(), "openatlas-sdk-test", Math.random().toString(36).slice(2));
const ledger = new Ledger(archivePathFor(dir), { root: dir, label: "sdk-test" });
const cap = new Capturer(ledger);

const SID = "session_sdk_1";

function propEv(type: string, properties: Record<string, unknown>): Record<string, unknown> {
  return { id: `ev_${Math.random()}`, type, properties };
}

describe("capturer against real SDK event shapes (payload under properties)", () => {
  test("session.created with properties creates a session", () => {
    cap.ingest(propEv("session.created", { sessionID: SID, info: { id: SID, slug: "x", projectID: "p", directory: dir } }));
    const s = ledger.getSession(SID);
    expect(s).toBeDefined();
    expect(s?.projectLabel).toBe("sdk-test");
  });

  test("user text via message.part.updated TextPart becomes one task step (deduped with message.updated)", () => {
    cap.ingest(propEv("message.updated", { sessionID: SID, info: { id: "sm1", role: "user" } }));
    cap.ingest(
      propEv("message.part.updated", {
        sessionID: SID,
        part: { id: "p1", sessionID: SID, messageID: "sm1", type: "text", text: "implement the report in src/report.ts" },
      })
    );
    const tasks = ledger.listSteps(SID).filter((s) => s.kind === "task");
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.content).toContain("report");
    expect(ledger.listFiles(tasks[0]!.id).some((f) => f.path === "src/report.ts")).toBe(true);
  });

  test("assistant text + reasoning attach to a plan step, not a duplicate task", () => {
    cap.ingest(propEv("session.next.text.ended", { sessionID: SID, assistantMessageID: "am1", textID: "t1", text: "i'll add an index page" }));
    cap.ingest(propEv("session.next.reasoning.ended", { sessionID: SID, assistantMessageID: "am1", reasoningID: "r1", text: "maybe reuse the table component" }));
    const plans = ledger.listSteps(SID).filter((s) => s.kind === "plan");
    expect(plans.length).toBe(1);
    expect(plans[0]?.content).toContain("index page");
    const payloads = ledger.listPayloads(plans[0]!.id);
    expect(payloads.some((p) => p.kind === "reasoning" && p.data.includes("table component"))).toBe(true);
  });

  test("ToolPart pending/completed lifecycle records one action step with output", () => {
    cap.ingest(
      propEv("message.part.updated", {
        sessionID: SID,
        part: { id: "tp1", sessionID: SID, messageID: "am2", type: "tool", callID: "sc1", tool: "read", state: { status: "pending", input: { filePath: "src/report.ts" } } },
      })
    );
    const mid = ledger.listSteps(SID).filter((s) => s.role === "tool" && s.meta?.callID === "sc1");
    expect(mid.length).toBe(1);
    cap.ingest(
      propEv("message.part.updated", {
        sessionID: SID,
        part: { id: "tp1", sessionID: SID, messageID: "am2", type: "tool", callID: "sc1", tool: "read", state: { status: "completed", input: {}, output: "contents of src/report.ts" } },
      })
    );
    const step = ledger.listSteps(SID).find((s) => s.role === "tool" && s.meta?.callID === "sc1");
    expect(step?.outcome).toBe("success");
    const out = ledger.listPayloads(step!.id).filter((p) => p.kind === "output");
    expect(out.length).toBe(1);
    expect(out[0]?.data).toContain("src/report.ts");
  });

  test("ToolPart error creates an error step + CAUSED_BY link", () => {
    cap.ingest(
      propEv("message.part.updated", {
        sessionID: SID,
        part: { id: "tp2", sessionID: SID, messageID: "am3", type: "tool", callID: "sc2", tool: "bash", state: { status: "error", input: { command: "bun run broken" }, error: "command failed" } },
      })
    );
    const action = ledger.listSteps(SID).find((s) => s.role === "tool" && s.meta?.callID === "sc2");
    expect(action?.outcome).toBe("failed");
    const error = ledger.listSteps(SID).find((s) => s.kind === "error");
    expect(error).toBeDefined();
    expect(ledger.getLinks(error!.id).some((l) => l.relation === "CAUSED_BY")).toBe(true);
  });

  test("session.next.tool.called and ToolPart pending with same callID record only ONE step", () => {
    const sid = "session_sdk_dedup";
    cap.ingest(propEv("message.updated", { sessionID: sid, info: { id: "m1", role: "user", agent: "x" } }));
    cap.ingest(
      propEv("message.part.updated", {
        sessionID: sid,
        part: { id: "tp9", sessionID: sid, messageID: "m2", type: "tool", callID: "c9", tool: "bash", state: { status: "pending", input: { command: "ls" } } },
      })
    );
    cap.ingest(propEv("session.next.tool.called", { sessionID: sid, assistantMessageID: "m2", callID: "c9", tool: "bash", input: { command: "ls" } }));
    cap.ingest(propEv("session.next.tool.success", { sessionID: sid, assistantMessageID: "m2", callID: "c9", structured: { ok: true } }));
    const tools = ledger.listSteps(sid).filter((s) => s.role === "tool" && s.meta?.callID === "c9");
    expect(tools.length).toBe(1);
    expect(tools[0]?.outcome).toBe("success");
  });

  test("command.executed uses name + arguments", () => {
    const sid = "session_sdk_cmd";
    cap.ingest(propEv("command.executed", { sessionID: sid, name: "ls", arguments: "-la", messageID: "m" }));
    const step = ledger.listSteps(sid).find((s) => s.meta?.source === "command.executed");
    expect(step).toBeDefined();
    expect(step?.content).toContain("ls");
  });

  test("session.diff under properties records diff payload + target file refs", () => {
    const sid = "session_sdk_diff";
    cap.ingest(propEv("message.updated", { sessionID: sid, info: { id: "m1", role: "user", parts: [{ type: "text", text: "fix the bug in src/bug.ts" }] } }));
    cap.ingest(
      propEv("session.diff", {
        sessionID: sid,
        diff: [{ file: "src/bug.ts", patch: "--- a/src/bug.ts\n+++ b/src/bug.ts\n@@ -1 +1 @@\n-x\n+y", additions: 1, deletions: 1, status: "modified" }],
      })
    );
    const steps = ledger.listSteps(sid);
    const last = steps[steps.length - 1]!;
    expect(ledger.listPayloads(last.id).some((p) => p.kind === "diff")).toBe(true);
    expect(ledger.listFiles(last.id).some((f) => f.path === "src/bug.ts" && f.kind === "target")).toBe(true);
  });

  test("lifecycle is caller-driven: session.idle does not finalize; finalizeSession does", () => {
    const sid = "session_sdk_idle";
    cap.ingest(propEv("message.updated", { sessionID: sid, info: { id: "m1", role: "user", parts: [{ type: "text", text: "wrap up the thing" }] } }));
    cap.ingest(propEv("session.idle", { sessionID: sid }));
    let s = ledger.getSession(sid);
    expect(s?.title).toBeNull();
    cap.finalizeSession(sid);
    s = ledger.getSession(sid);
    expect(s?.endedAt).toBeNull();
    expect(s?.title).toContain("wrap up");
  });
});
