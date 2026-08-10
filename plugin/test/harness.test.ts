import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger, archivePathFor } from "openatlas-engine";
import plugin from "../src/index";

const tmp = path.join(os.tmpdir(), "openatlas-harness", Math.random().toString(36).slice(2));
fs.mkdirSync(tmp, { recursive: true });

const fakeHome = path.join(tmp, "home");
fs.mkdirSync(fakeHome, { recursive: true });
const savedProfile = process.env.USERPROFILE;
const savedHome = process.env.HOME;
const savedMemoryDir = process.env.OPENATLAS_MEMORY_DIR;
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
delete process.env.OPENATLAS_MEMORY_DIR;

const SID = "sess_harness_test";

type AnyHooks = Record<string, any>;
let hooks: AnyHooks | null = null;

function ev(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return { type, data };
}

async function ingest(type: string, data: Record<string, unknown>): Promise<void> {
  await hooks!.event({ event: ev(type, data) });
}

const toolCtx: any = {
  sessionID: SID,
  messageID: "m1",
  agent: "build",
  directory: tmp,
  worktree: tmp,
  abort: new AbortController().signal,
};

beforeAll(async () => {
  const server = (plugin as unknown as { server: (input: unknown, options?: unknown) => Promise<AnyHooks> }).server;
  hooks = await server(
    { project: { id: "p", directory: tmp, worktree: tmp }, directory: tmp, worktree: tmp } as any,
    {}
  );
});

afterAll(async () => {
  await hooks?.dispose?.();
  if (savedProfile) process.env.USERPROFILE = savedProfile;
  else delete process.env.USERPROFILE;
  if (savedHome) process.env.HOME = savedHome;
  else delete process.env.HOME;
  if (savedMemoryDir) process.env.OPENATLAS_MEMORY_DIR = savedMemoryDir;
  else delete process.env.OPENATLAS_MEMORY_DIR;
});
describe("openatlas harness", () => {
  test("captures synthetic events into the project archive", async () => {
    await ingest("message.updated", {
      sessionID: SID,
      info: { id: "m1", role: "user", parts: [{ type: "text", text: "fix the login bug in src/auth.ts" }] },
    });
    await ingest("session.next.tool.called", {
      sessionID: SID,
      assistantMessageID: "m2",
      callID: "c1",
      tool: "bash",
      input: { command: "bun test" },
    });
    await ingest("session.next.tool.success", {
      sessionID: SID,
      callID: "c1",
      structured: { ok: true },
      content: [{ type: "text", text: "all tests pass" }],
    });
    await ingest("session.next.tool.called", {
      sessionID: SID,
      assistantMessageID: "m3",
      callID: "c2",
      tool: "bash",
      input: { command: "echo hello" },
    });
    await ingest("session.next.tool.success", {
      sessionID: SID,
      callID: "c2",
      content: [{ type: "text", text: "hello" }],
    });
    await ingest("session.idle", { sessionID: SID });
  });

  test("archive.db exists under tmpdir/.openatlas/", () => {
    expect(fs.existsSync(path.join(tmp, ".openatlas", "archive.db"))).toBe(true);
  });

  test("session row exists with title containing 'login bug' and stays open (endedAt null)", () => {
    const ledger = new Ledger(archivePathFor(tmp), { root: tmp });
    try {
      const session = ledger.getSession(SID);
      expect(session).not.toBeNull();
      expect(session!.title).toContain("login bug");
      expect(session!.endedAt).toBeNull();
    } finally {
      ledger.db.close();
    }
  });

  test("an 'action' step exists for the bash tool", () => {
    const ledger = new Ledger(archivePathFor(tmp), { root: tmp });
    try {
      const steps = ledger.listSteps(SID);
      const action = steps.find((s) => s.kind === "action" && s.content === "bash");
      expect(action).toBeDefined();
      expect(action!.outcome).toBe("success");
      const verification = steps.find((s) => s.kind === "verification" && s.content === "bash");
      expect(verification).toBeDefined();
      expect(verification!.outcome).toBe("success");
    } finally {
      ledger.db.close();
    }
  });

  test("hooks never throw and general memory stays in the fake home", () => {
    expect(hooks).not.toBeNull();
    expect(fs.existsSync(path.join(fakeHome, ".openatlas", "memory", "memory.db"))).toBe(true);
  });

  test("atlas_commit labels the step and links it", async () => {
    const ledger = new Ledger(archivePathFor(tmp), { root: tmp });
    let taskId: string;
    try {
      taskId = ledger.listSteps(SID).find((s) => s.kind === "task")!.id;
    } finally {
      ledger.db.close();
    }
    const res = await hooks!.tool.atlas_commit.execute(
      { kind: "fix", summary: "fixed the login bug", link_to: [taskId], relation: "FIXES" },
      toolCtx
    );
    expect(res).toBeString();
    expect(res).toContain("Committed step");
    expect(res).toContain("1 link(s) created");
  });

  test("atlas_recall returns formatted chains", async () => {
    const res = await hooks!.tool.atlas_recall.execute({ q: "login bug", k: 3, scope: "project" }, toolCtx);
    expect(res).toBeString();
    expect(res.length).toBeGreaterThan(0);
  });

  test("atlas_habits returns pretty JSON", async () => {
    const res = await hooks!.tool.atlas_habits.execute({ scope: "project" }, toolCtx);
    expect(JSON.parse(res as string).scope).toBe("project");
  });

  test("atlas_logs lists the session log", async () => {
    const res = await hooks!.tool.atlas_logs.execute({}, toolCtx);
    expect(res).toBeString();
    expect(res).toContain(SID);
  });

  test("system transform injects an openatlas memory block", async () => {
    const out = { system: [] as string[] };
    await hooks!["experimental.chat.system.transform"]({ sessionID: SID, model: { providerID: "x", modelID: "y" } }, out);
    expect(out.system.some((s) => s.includes("[openatlas memory]"))).toBe(true);
  });

  test("compacting appends a memory note to context", async () => {
    const out = { context: [] as string[] };
    await hooks!["experimental.session.compacting"]({ sessionID: SID }, out);
    expect(out.context.some((c) => c.includes("[openatlas memory]"))).toBe(true);
  });
});
