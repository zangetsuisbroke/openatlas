import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "../src/ledger";

// Steps schema exactly as it existed before the idempotency work: no source_id,
// no data_hash.
const LEGACY_SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  project_label TEXT NOT NULL,
  agent TEXT,
  model TEXT,
  title TEXT,
  summary TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  source TEXT
);
CREATE TABLE steps (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT,
  parent_id TEXT,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  context TEXT,
  outcome TEXT,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE step_payloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);
`;

let dir: string;
let dbPath: string;
let ledger: Ledger | null = null;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-mig-"));
  dbPath = path.join(dir, "legacy.db");
});

afterAll(() => {
  ledger?.close();
  ledger = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

function buildLegacyDb(): void {
  fs.rmSync(dbPath, { force: true });
  const db = new Database(dbPath);
  db.exec(LEGACY_SCHEMA);
  const now = Date.now();
  db.exec("INSERT INTO sessions (id, project_id, project_label, started_at) VALUES (?, ?, ?, ?)", ["ses_legacy", "p1", "legacy", now]);
  db.exec(
    `INSERT INTO steps (id, session_id, message_id, parent_id, seq, kind, role, content, created_at) VALUES
      ('st_task1', 'ses_legacy', 'msg_user1', NULL, 1, 'task', 'user', 'first recording', ?),
      ('st_task2', 'ses_legacy', 'msg_user1', NULL, 2, 'task', 'user', 'first recording', ?),
      ('st_plan1', 'ses_legacy', 'msg_asm1', 'st_task1', 3, 'plan', 'assistant', 'plan text', ?),
      ('st_act1',  'ses_legacy', 'msg_asm1', 'st_plan1', 4, 'action', 'tool', 'bash', ?)`,
    [now, now + 10, now + 20, now + 30]
  );
  db.close();
}

describe("Ledger migration over a legacy database", () => {
  test("collapses duplicate task recordings, keeps plan/action sharing a message_id, and builds the unique indexes", () => {
    buildLegacyDb();
    ledger = new Ledger(dbPath, { root: dir });

    const steps = ledger.db.query("SELECT id, kind, message_id, source_id FROM steps ORDER BY rowid").all() as Array<{ id: string; kind: string; message_id: string | null; source_id: string | null }>;
    expect(steps).toEqual([
      { id: "st_task1", kind: "task", message_id: "msg_user1", source_id: null },
      { id: "st_plan1", kind: "plan", message_id: "msg_asm1", source_id: null },
      { id: "st_act1", kind: "action", message_id: "msg_asm1", source_id: null },
    ]);

    const indexes = (ledger.db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexes).toContain("idx_steps_session_source");
    expect(indexes).toContain("idx_steps_session_message");
    expect(indexes).toContain("idx_payloads_step_kind_hash");

    ledger.close();
    ledger = null;
  });

  test("replays dedupe: task by message_id, plan/action by source_id (never collapsing plan+action that share a message_id)", () => {
    buildLegacyDb();
    ledger = new Ledger(dbPath, { root: dir });

    const taskReplay = ledger.addStep({ sessionId: "ses_legacy", messageId: "msg_user1", kind: "task", role: "user", content: "first recording" });
    expect(taskReplay.id).toBe("st_task1");

    const planWithSource = ledger.addStep({ sessionId: "ses_legacy", messageId: "msg_asm1", kind: "plan", role: "assistant", content: "plan text", sourceId: "ev_plan_1" });
    const planReplay = ledger.addStep({ sessionId: "ses_legacy", messageId: "msg_asm1", kind: "plan", role: "assistant", content: "plan text", sourceId: "ev_plan_1" });
    expect(planReplay.id).toBe(planWithSource.id);

    const action = ledger.addStep({ sessionId: "ses_legacy", messageId: "msg_asm1", kind: "action", role: "tool", content: "bash", sourceId: "ev_tool_1" });
    const actionReplay = ledger.addStep({ sessionId: "ses_legacy", messageId: "msg_asm1", kind: "action", role: "tool", content: "bash", sourceId: "ev_tool_1" });
    expect(actionReplay.id).toBe(action.id);
    expect(action.id).not.toBe(planWithSource.id);
    expect(action.id).not.toBe("st_act1");

    ledger.close();
    ledger = null;
  });
});
