import { Database } from "bun:sqlite";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import type {
  SessionRow,
  NewStep,
  Step,
  StepPayload,
  StepFile,
  StepLink,
  NewStepLink,
  GraphData,
  GraphNode,
  GraphLink,
  Relation,
} from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
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
CREATE TABLE IF NOT EXISTS steps (
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
  source_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_steps_session ON steps(session_id);
CREATE INDEX IF NOT EXISTS idx_steps_kind ON steps(kind);
CREATE TABLE IF NOT EXISTS step_payloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  data_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_payloads_step ON step_payloads(step_id);
CREATE TABLE IF NOT EXISTS step_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_step_files_unique ON step_files(step_id, path);
CREATE INDEX IF NOT EXISTS idx_step_files_path ON step_files(path);
CREATE TABLE IF NOT EXISTS step_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_step_id TEXT NOT NULL,
  target_step_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  origin TEXT NOT NULL,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_links_unique ON step_links(source_step_id, target_step_id, relation, origin);
CREATE INDEX IF NOT EXISTS idx_links_source ON step_links(source_step_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON step_links(target_step_id);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

// Partial unique indexes over columns added by migrateSchema() (source_id,
// data_hash). These must run AFTER the ALTERs because old DBs lack the columns.
// The message_id index is scoped to kind='task': an assistant message legitimately
// produces multiple steps that share its message_id (a plan step plus one action
// step per tool call), so a whole-table unique index would silently collapse them.
const SCHEMA_IDX = `

CREATE UNIQUE INDEX IF NOT EXISTS idx_steps_session_source ON steps(session_id, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_steps_session_message ON steps(session_id, message_id) WHERE message_id IS NOT NULL AND kind = 'task';
CREATE UNIQUE INDEX IF NOT EXISTS idx_payloads_step_kind_hash ON step_payloads(step_id, kind, data_hash) WHERE data_hash IS NOT NULL;
`;

const LINK_RELATIONS: Relation[] = [
  "CAUSED_BY",
  "FIXES",
  "BASED_ON",
  "SIMILAR_TO",
  "CONTRADICTS",
  "EXTENDS",
  "REFINES",
  "SHARES_FILE",
];

export function projectId(dir: string): string {
  return crypto.createHash("sha1").update(path.resolve(dir)).digest("hex").slice(0, 16);
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

export function archivePathFor(projectDir: string): string {
  return path.join(projectDir, ".openatlas", "archive.db");
}

export function generalMemoryPath(): string {
  return process.env.OPENATLAS_MEMORY_DIR ? path.join(process.env.OPENATLAS_MEMORY_DIR, "memory.db") : path.join(os.homedir(), ".openatlas", "memory", "memory.db");
}

export function logsDir(): string {
  return process.env.OPENATLAS_MEMORY_DIR ? path.join(process.env.OPENATLAS_MEMORY_DIR, "logs") : path.join(os.homedir(), ".openatlas", "logs");
}

export class Ledger {
  readonly db: Database;
  readonly root: string;
  readonly projectId: string;
  readonly projectLabel: string;

  constructor(dbPath: string, opts: { root?: string; label?: string } = {}) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.migrateSchema();
    this.db.exec(SCHEMA_IDX);
    this.root = opts.root ? path.resolve(opts.root) : "";
    this.projectLabel = opts.label ?? path.basename(this.root || dbPath);
    this.projectId = this.root ? projectId(this.root) : "general";
  }

  close(): void {
    this.db.close();
  }

  // Add columns added after the initial schema for databases created before
  // the idempotency work. CREATE TABLE IF NOT EXISTS does nothing for existing
  // tables, so ALTER is required and is guarded by a PRAGMA check.
  private migrateSchema(): void {
    const hasColumn = (table: string, column: string): boolean =>
      (this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
    if (!hasColumn("steps", "source_id")) this.db.exec("ALTER TABLE steps ADD COLUMN source_id TEXT");
    if (!hasColumn("step_payloads", "data_hash")) this.db.exec("ALTER TABLE step_payloads ADD COLUMN data_hash TEXT");
    // Legacy databases may hold duplicate task recordings for the same user
    // message (event replays written before idempotent ingest). Collapse them
    // to the earliest recording so the partial unique index in SCHEMA_IDX can
    // be created; deduping only kind='task' leaves plan/action steps (which
    // legitimately share an assistant message_id) untouched.
    this.db.exec(`DELETE FROM steps
      WHERE kind = 'task' AND message_id IS NOT NULL
        AND rowid NOT IN (SELECT MIN(rowid) FROM steps WHERE kind = 'task' AND message_id IS NOT NULL GROUP BY session_id, message_id)`);
  }

  createSession(opts: { id?: string | null; agent?: string | null; model?: string | null; title?: string | null; source?: string | null } = {}): SessionRow {
    const id = opts.id ?? newId("s");
    const now = Date.now();
    this.db
      .query(
        `INSERT OR IGNORE INTO sessions (id, project_id, project_label, agent, model, title, summary, started_at, source)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(id, this.projectId, this.projectLabel, opts.agent ?? null, opts.model ?? null, opts.title ?? null, now, opts.source ?? "opencode");
    const row = this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as unknown;
    return rowToSession(row);
  }

  getSession(sessionId: string): SessionRow | null {
    const row = this.db.query("SELECT * FROM sessions WHERE id = ?").get(sessionId) as unknown;
    return row ? rowToSession(row) : null;
  }

  // markEnded defaults to true so existing callers keep stamping ended_at;
  // pass markEnded:false to update title/summary while leaving ended_at as-is.
  finishSession(sessionId: string, opts: { title?: string | null; summary?: string | null; markEnded?: boolean } = {}): void {
    const cur = this.getSession(sessionId);
    if (!cur) return;
    const markEnded = opts.markEnded !== false;
    const endedAt = markEnded ? Date.now() : cur.endedAt;
    this.db
      .query("UPDATE sessions SET ended_at = ?, title = ?, summary = ? WHERE id = ?")
      .run(endedAt, opts.title ?? cur.title, opts.summary ?? cur.summary, sessionId);
  }

  listSessions(projectIdFilter?: string): SessionRow[] {
    const rows = projectIdFilter
      ? this.db.query("SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC").all(projectIdFilter)
      : this.db.query("SELECT * FROM sessions ORDER BY started_at DESC").all();
    return (rows as unknown[]).map(rowToSession);
  }

  addStep(input: NewStep): Step {
    const id = newId("st");
    const now = Date.now();
    const seqRow = this.db.query("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM steps WHERE session_id = ?").get(input.sessionId) as { n: number };
    const sourceId = input.sourceId ?? null;
    const res = this.db
      .query(
        `INSERT OR IGNORE INTO steps (id, session_id, message_id, parent_id, seq, kind, role, content, context, outcome, meta, source_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.sessionId,
        input.messageId ?? null,
        input.parentId ?? null,
        seqRow.n,
        input.kind,
        input.role,
        input.content ?? null,
        input.context ?? null,
        input.outcome ?? null,
        input.meta ? JSON.stringify(input.meta) : null,
        sourceId,
        now
      );
    let row: unknown = null;
    if ((res as { changes: number }).changes === 0) {
      // Hit a unique (session_id, source_id) or (session_id, message_id)
      // conflict from an event replay — return the already-existing step so
      // downstream handlers don't double-apply.
      if (sourceId) {
        row = this.db.query("SELECT * FROM steps WHERE session_id = ? AND source_id = ?").get(input.sessionId, sourceId);
      } else if (input.messageId) {
        row = this.db.query("SELECT * FROM steps WHERE session_id = ? AND message_id = ? AND kind = ?").get(input.sessionId, input.messageId, input.kind);
      }
    }
    if (!row) row = this.db.query("SELECT * FROM steps WHERE id = ?").get(id);
    return rowToStep(row);
  }

  updateStep(stepId: string, patch: { kind?: Step["kind"]; content?: string | null; outcome?: string | null; meta?: Record<string, unknown> | null }): void {
    const cur = this.getStep(stepId);
    if (!cur) return;
    const meta = patch.meta !== undefined ? patch.meta : cur.meta;
    this.db
      .query("UPDATE steps SET kind = ?, content = ?, outcome = ?, meta = ? WHERE id = ?")
      .run(
        patch.kind ?? cur.kind,
        patch.content !== undefined ? patch.content : cur.content,
        patch.outcome !== undefined ? patch.outcome : cur.outcome,
        meta ? (JSON.stringify(meta) ?? null) : null,
        stepId
      );
  }

  getStep(stepId: string): Step | null {
    const row = this.db.query("SELECT * FROM steps WHERE id = ?").get(stepId) as unknown;
    return row ? rowToStep(row) : null;
  }

  listChildren(parentId: string): Step[] {
    const rows = this.db.query("SELECT * FROM steps WHERE parent_id = ? ORDER BY seq ASC").all(parentId);
    return (rows as unknown[]).map(rowToStep);
  }

  listSteps(sessionId: string): Step[] {
    const rows = this.db.query("SELECT * FROM steps WHERE session_id = ? ORDER BY seq ASC").all(sessionId);
    return (rows as unknown[]).map(rowToStep);
  }

  stepsByKind(kind: Step["kind"], sessionId?: string): Step[] {
    const rows = sessionId
      ? this.db.query("SELECT * FROM steps WHERE kind = ? AND session_id = ? ORDER BY seq ASC").all(kind, sessionId)
      : this.db.query("SELECT * FROM steps WHERE kind = ? ORDER BY created_at ASC").all(kind);
    return (rows as unknown[]).map(rowToStep);
  }

  addPayload(stepId: string, kind: string, data: string): void {
    const compressed = deflateSync(Buffer.from(data, "utf8"), { level: 6 }).toString("base64");
    const dataHash = crypto.createHash("sha256").update(data).digest("hex");
    this.db.query("INSERT OR IGNORE INTO step_payloads (step_id, kind, data, data_hash) VALUES (?, ?, ?, ?)").run(stepId, kind, compressed, dataHash);
  }

  listPayloads(stepId: string): StepPayload[] {
    const rows = this.db.query("SELECT * FROM step_payloads WHERE step_id = ? ORDER BY id ASC").all(stepId);
    return (rows as unknown[]).map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: Number(row.id),
        stepId: String(row.step_id),
        kind: String(row.kind),
        data: inflateSync(Buffer.from(String(row.data), "base64")).toString("utf8"),
      };
    });
  }

  payloadText(stepId: string, kind: string): string | null {
    const row = this.db.query("SELECT data FROM step_payloads WHERE step_id = ? AND kind = ? LIMIT 1").get(stepId, kind) as { data: string } | null;
    return row ? inflateSync(Buffer.from(row.data, "base64")).toString("utf8") : null;
  }

  addFileRef(stepId: string, p: string, kind: StepFile["kind"]): void {
    this.db
      .query(
        `INSERT INTO step_files (step_id, path, kind) VALUES (?, ?, ?)
         ON CONFLICT(step_id, path) DO UPDATE SET kind = CASE
           WHEN excluded.kind = 'target' THEN 'target'
           WHEN excluded.kind = 'read' AND step_files.kind = 'mention' THEN 'read'
           ELSE step_files.kind END`
      )
      .run(stepId, p, kind);
  }

  listFiles(stepId: string): StepFile[] {
    const rows = this.db.query("SELECT * FROM step_files WHERE step_id = ? ORDER BY id ASC").all(stepId);
    return (rows as unknown[]).map((r) => {
      const row = r as Record<string, unknown>;
      return { id: Number(row.id), stepId: String(row.step_id), path: String(row.path), kind: row.kind as StepFile["kind"] };
    });
  }

  listFilesByPath(p: string): StepFile[] {
    const rows = this.db.query("SELECT * FROM step_files WHERE path = ? ORDER BY id ASC").all(p);
    return (rows as unknown[]).map((r) => {
      const row = r as Record<string, unknown>;
      return { id: Number(row.id), stepId: String(row.step_id), path: String(row.path), kind: row.kind as StepFile["kind"] };
    });
  }

  link(opts: NewStepLink): void {
    const meta = opts.meta ? JSON.stringify(opts.meta) : null;
    this.db
      .query(
        `INSERT OR IGNORE INTO step_links (source_step_id, target_step_id, relation, confidence, origin, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(opts.sourceStepId, opts.targetStepId, opts.relation, opts.confidence ?? 1.0, opts.origin, meta, Date.now());
  }

  getLinks(stepId: string): StepLink[] {
    const rows = this.db.query("SELECT * FROM step_links WHERE source_step_id = ? OR target_step_id = ?").all(stepId, stepId);
    return (rows as unknown[]).map(rowToLink);
  }

  listLinks(sessionId?: string): StepLink[] {
    const rows = sessionId
      ? this.db.query(
          `SELECT l.* FROM step_links l
           JOIN steps s1 ON l.source_step_id = s1.id AND s1.session_id = ?
           JOIN steps s2 ON l.target_step_id = s2.id AND s2.session_id = ?`
        ).all(sessionId, sessionId)
      : this.db.query("SELECT * FROM step_links").all();
    return (rows as unknown[]).map(rowToLink);
  }

  linkSharedFiles(sessionId: string): number {
    const pairs = this.db
      .query(
        `SELECT DISTINCT f1.step_id AS a, f2.step_id AS b, f1.path AS p
         FROM step_files f1
         JOIN step_files f2 ON f1.path = f2.path AND f1.step_id < f2.step_id
         WHERE f1.step_id IN (SELECT id FROM steps WHERE session_id = ?)
           AND f2.step_id IN (SELECT id FROM steps WHERE session_id = ?)`
      )
      .all(sessionId, sessionId) as Array<{ a: string; b: string; p: string }>;
    for (const pair of pairs) {
      this.link({ sourceStepId: pair.a, targetStepId: pair.b, relation: "SHARES_FILE", origin: "file", meta: { file: pair.p } });
    }
    return pairs.length;
  }

  graph(projectIdFilter?: string): GraphData {
    const sessionClause = projectIdFilter ? "WHERE s.project_id = ?" : "";
    const sessionParams = projectIdFilter ? [projectIdFilter] : [];
    const stepRows = this.db.query(`SELECT st.* FROM steps st JOIN sessions s ON st.session_id = s.id ${sessionClause}`).all(...sessionParams) as unknown[];
    const steps = stepRows.map(rowToStep);

    const stepIds = steps.map((s) => s.id);
    const nodes: GraphNode[] = steps.map((s) => ({
      id: s.id,
      type: "step",
      label: `${s.kind}${s.content ? " — " + s.content.slice(0, 80) : ""}`,
      kind: s.kind,
      degree: 0,
      meta: { ...(s.meta ?? {}), sessionId: s.sessionId },
    }));

    const fileRows = this.db
      .query(`SELECT DISTINCT f.path FROM step_files f WHERE f.step_id IN (SELECT st.id FROM steps st JOIN sessions s ON st.session_id = s.id ${sessionClause})`)
      .all(...sessionParams) as Array<{ path: string }>;
    for (const fr of fileRows) nodes.push({ id: `file:${fr.path}`, type: "file", label: fr.path, kind: null, degree: 0 });

    const nodeIds = new Set(nodes.map((n) => n.id));
    const links: GraphLink[] = [];
    if (stepIds.length > 0) {
      // Constrain both link endpoints and file refs via subqueries over the
      // (already project-filtered) steps table. Avoids SQLite's IN-list
      // variable limit AND keeps links whose endpoints fall in different
      // chunks — the old chunked IN() query silently dropped those.
      const inProject = `(SELECT st.id FROM steps st JOIN sessions s ON st.session_id = s.id ${sessionClause})`;
      const linkRows = this.db
        .query(`SELECT l.* FROM step_links l WHERE l.source_step_id IN ${inProject} AND l.target_step_id IN ${inProject}`)
        .all(...sessionParams, ...sessionParams) as unknown[];
      for (const row of linkRows) {
        const link = rowToLink(row);
        if (!nodeIds.has(link.sourceStepId) || !nodeIds.has(link.targetStepId)) continue;
        links.push({ id: `l${link.id}`, source: link.sourceStepId, target: link.targetStepId, relation: link.relation, origin: link.origin, label: link.meta?.file ? String(link.meta.file) : link.relation });
      }
      const stepFiles = this.db
        .query(`SELECT f.path, f.step_id FROM step_files f WHERE f.step_id IN ${inProject}`)
        .all(...sessionParams) as Array<{ path: string; step_id: string }>;
      const byPath = new Map<string, string[]>();
      for (const sf of stepFiles) {
        const list = byPath.get(sf.path) ?? [];
        list.push(sf.step_id);
        byPath.set(sf.path, list);
      }
      for (const fr of fileRows) {
        const stepIdsForPath = byPath.get(fr.path) ?? [];
        for (const stepId of stepIdsForPath) {
          links.push({ id: `fl${fr.path}:${stepId}`, source: `file:${fr.path}`, target: stepId, relation: "SHARES_FILE", origin: "file", label: fr.path });
        }
      }
    }

    const degree = new Map<string, number>();
    for (const l of links) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
    }
    for (const n of nodes) n.degree = degree.get(n.id) ?? 0;
    return { nodes, links };
  }

  setMeta(key: string, value: string): void {
    this.db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
    return row ? row.value : null;
  }
}

function rowToSession(row: unknown): SessionRow {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    projectLabel: String(r.project_label),
    agent: r.agent ? String(r.agent) : null,
    model: r.model ? String(r.model) : null,
    title: r.title ? String(r.title) : null,
    summary: r.summary ? String(r.summary) : null,
    startedAt: Number(r.started_at),
    endedAt: r.ended_at ? Number(r.ended_at) : null,
    source: r.source ? String(r.source) : null,
  };
}

function rowToStep(row: unknown): Step {
  const r = row as Record<string, unknown>;
  let meta: Record<string, unknown> | null = null;
  if (r.meta) {
    try {
      meta = JSON.parse(String(r.meta));
    } catch {
      meta = null;
    }
  }
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    messageId: r.message_id ? String(r.message_id) : null,
    parentId: r.parent_id ? String(r.parent_id) : null,
    seq: Number(r.seq),
    kind: r.kind as Step["kind"],
    role: r.role as Step["role"],
    content: r.content ? String(r.content) : null,
    context: r.context ? String(r.context) : null,
    outcome: r.outcome ? String(r.outcome) : null,
    meta,
    sourceId: r.source_id ? String(r.source_id) : null,
    createdAt: Number(r.created_at),
  };
}

function rowToLink(row: unknown): StepLink {
  const r = row as Record<string, unknown>;
  let meta: Record<string, unknown> | null = null;
  if (r.meta) {
    try {
      meta = JSON.parse(String(r.meta));
    } catch {
      meta = null;
    }
  }
  return {
    id: Number(r.id),
    sourceStepId: String(r.source_step_id),
    targetStepId: String(r.target_step_id),
    relation: r.relation as Relation,
    confidence: Number(r.confidence),
    origin: r.origin as StepLink["origin"],
    meta,
    createdAt: Number(r.created_at),
  };
}

export const RELATIONS = LINK_RELATIONS;
