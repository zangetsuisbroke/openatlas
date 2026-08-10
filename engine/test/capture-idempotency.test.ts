import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger, archivePathFor } from "../src/ledger";
import { Capturer } from "../src/capture";

const dir = path.join(os.tmpdir(), "openatlas-idem-test", Math.random().toString(36).slice(2));
const ledger = new Ledger(archivePathFor(dir), { root: dir, label: "idem-test" });
const cap = new Capturer(ledger);

const SID = "session_idem_1";

function ev(id: string, type: string, properties: Record<string, unknown>): Record<string, unknown> {
  return { id, type, properties };
}

describe("capture idempotency (C1)", () => {
  test("replaying an event with the same id applies it only once (tool.called)", () => {
    const callID = "c_idem_1";
    const event = ev("ev_idem_1", "session.next.tool.called", {
      sessionID: SID,
      assistantMessageID: "am1",
      callID,
      tool: "bash",
      input: { command: "bun test" },
    });
    cap.ingest(event);
    cap.ingest(event);
    const tools = ledger.listSteps(SID).filter((s) => s.role === "tool" && s.meta?.callID === callID);
    expect(tools.length).toBe(1);
    expect(tools[0]?.sourceId).toBe("ev_idem_1");
  });

  test("replaying a tool success does not duplicate output payloads", () => {
    const callID = "c_idem_2";
    cap.ingest(ev("ev_idem_2", "session.next.tool.called", { sessionID: SID, assistantMessageID: "am2", callID, tool: "read", input: { filePath: "a.ts" } }));
    const success = ev("ev_idem_3", "session.next.tool.success", { sessionID: SID, assistantMessageID: "am2", callID, content: [{ type: "text", text: "file body" }] });
    cap.ingest(success);
    cap.ingest(success);
    const step = ledger.listSteps(SID).find((s) => s.role === "tool" && s.meta?.callID === callID)!;
    expect(ledger.listPayloads(step.id).filter((p) => p.kind === "output").length).toBe(1);
  });

  test("replaying command.executed with the same id keeps a single action step", () => {
    const event = ev("ev_idem_4", "command.executed", { sessionID: SID, name: "bun", arguments: "run x" });
    cap.ingest(event);
    cap.ingest(event);
    const actions = ledger.listSteps(SID).filter((s) => s.kind === "action" && s.meta?.source === "command.executed");
    expect(actions.length).toBe(1);
  });

  test("replaying session.error with the same id keeps a single error step", () => {
    const event = ev("ev_idem_5", "session.error", { sessionID: SID, error: { message: "boom" } });
    cap.ingest(event);
    cap.ingest(event);
    const errors = ledger.listSteps(SID).filter((s) => s.kind === "error" && s.meta?.source === "session.error");
    expect(errors.length).toBe(1);
  });

  test("message.updated replay with the same message id does not duplicate the task step", () => {
    const mid = "m_idem_1";
    const event = ev("ev_idem_6", "message.updated", {
      sessionID: SID,
      info: { id: mid, role: "user", parts: [{ type: "text", text: "fix the flaky test" }] },
    });
    cap.ingest(event);
    cap.ingest(event);
    const tasks = ledger.listSteps(SID).filter((s) => s.kind === "task" && s.messageId === mid);
    expect(tasks.length).toBe(1);
  });
});
