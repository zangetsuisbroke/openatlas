import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger, archivePathFor } from "../src/ledger";

const dir = path.join(os.tmpdir(), "openatlas-ledger-test", Math.random().toString(36).slice(2));
const ledger = new Ledger(archivePathFor(dir), { root: dir, label: "ledger-test" });

describe("ledger", () => {
  test("creates and finishes a session", () => {
    const s = ledger.createSession({ agent: "opencode" });
    expect(s.projectId).toBe(ledger.projectId);
    ledger.finishSession(s.id, { title: "T", summary: "S" });
    const got = ledger.getSession(s.id);
    expect(got?.title).toBe("T");
    expect(got?.endedAt).not.toBeNull();
  });

  test("adds steps with incrementing seq", () => {
    const s = ledger.createSession({});
    const a = ledger.addStep({ sessionId: s.id, kind: "task", role: "user", content: "fix bug" });
    const b = ledger.addStep({ sessionId: s.id, kind: "action", role: "tool", content: "edit" });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    const steps = ledger.listSteps(s.id);
    expect(steps.map((st) => st.id)).toEqual([a.id, b.id]);
  });

  test("stores and reads back compressed payloads", () => {
    const s = ledger.createSession({});
    const step = ledger.addStep({ sessionId: s.id, kind: "action", role: "tool", content: "bash" });
    const big = "x".repeat(50_000);
    ledger.addPayload(step.id, "output", big);
    const payloads = ledger.listPayloads(step.id);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.data).toBe(big);
  });

  test("links steps and auto-links shared files", () => {
    const s = ledger.createSession({});
    const a = ledger.addStep({ sessionId: s.id, kind: "action", role: "tool", content: "edit" });
    const b = ledger.addStep({ sessionId: s.id, kind: "action", role: "tool", content: "read" });
    const c = ledger.addStep({ sessionId: s.id, kind: "action", role: "tool", content: "edit" });
    ledger.addFileRef(a.id, "src/foo.ts", "target");
    ledger.addFileRef(b.id, "src/foo.ts", "read");
    ledger.addFileRef(c.id, "src/bar.ts", "target");
    const made = ledger.linkSharedFiles(s.id);
    expect(made).toBe(1);
    const links = ledger.listLinks(s.id);
    expect(links).toHaveLength(1);
    expect(links[0]?.relation).toBe("SHARES_FILE");
    expect(links[0]?.origin).toBe("file");
    const pairs = new Set([`${links[0]!.sourceStepId}:${links[0]!.targetStepId}`]);
    expect(pairs.has(`${a.id}:${b.id}`) || pairs.has(`${b.id}:${a.id}`)).toBe(true);
  });

  test("agent link", () => {
    const s = ledger.createSession({});
    const a = ledger.addStep({ sessionId: s.id, kind: "error", role: "assistant", content: "err" });
    const b = ledger.addStep({ sessionId: s.id, kind: "fix", role: "assistant", content: "fixed" });
    ledger.link({ sourceStepId: b.id, targetStepId: a.id, relation: "FIXES", origin: "agent" });
    const links = ledger.getLinks(a.id);
    expect(links.some((l) => l.relation === "FIXES" && l.origin === "agent")).toBe(true);
  });

  test("builds graph with file hub nodes", () => {
    const g = ledger.graph();
    const fileNodes = g.nodes.filter((n) => n.type === "file");
    expect(fileNodes.some((n) => n.label === "src/foo.ts")).toBe(true);
    expect(fileNodes.some((n) => n.label === "src/bar.ts")).toBe(true);
    const fileLinks = g.links.filter((l) => l.relation === "SHARES_FILE");
    expect(fileLinks.length).toBeGreaterThan(0);
  });
});
