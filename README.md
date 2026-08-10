# openatlas

**Git for reasoning: persistent memory for opencode agent sessions.**

openatlas is a passive harness — an opencode plugin, a TypeScript engine, and a local web app — that auto-captures every reasoning step of an opencode agent session into persistent sqlite memory and lets you browse it. The engine never calls an LLM: capture, linking, recall, and habit signals are all mechanical. Everything rides inside opencode's own process using `bun:sqlite` — zero Python, zero daemons, zero network calls in the capture path.

## 1. Features

- **Auto full-fidelity capture** — the plugin's `event` hook converts every SDK event into reasoning steps. Tool calls become `action`/`verification` steps with their full args, output, and result payloads; reasoning and diff text is stored; nothing is summarized away.
- **Three-layer linking** — structural (the session spine, `auto`), architecture (`SHARES_FILE` between steps touching the same file, `file`), and semantic (agent `atlas_commit` links + recall edges).
- **File architecture view** — canonical repo-relative file references are extracted from text, diffs, and tool args; files render as hub nodes in the graph.
- **Zero-LLM recall** — `atlas_recall` matches on word overlap and walks the step graph. Free, instant, and available mid-session through the injected system prompt.
- **Habit analysis** — per-session mechanical signals (rework, tests, lint, error rate) with aggregation and flags; natural-language *summaries* are generated on demand via `opencode run -p` (opencode's own model), never in the capture path.
- **Transcript archive** — every raw SDK event for every session is appended to `~/.openatlas/logs/<sessionId>.jsonl`, full fidelity, browsable through the app.

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ opencode terminal (the coding agent session)                        │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ every SDK event (hook: event)
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ openatlas-plugin  (harness, bundled to plugin/dist/index.js)        │
│   hooks:  event · chat.system.transform · session.compacting        │
│   tools:  atlas_commit · atlas_recall · atlas_habits · atlas_logs   │
└───────────────────────────────┬─────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ openatlas-engine  (TypeScript, bun:sqlite, zero deps)               │
│   refs.ts      file-reference extraction + canonicalization         │
│   ledger.ts    sessions / steps / payloads / files / links, graph   │
│   capture.ts   SDK event -> reasoning steps (Capturer)              │
│   recall.ts    word-overlap + graph-walk, file-scoped recall        │
│   habits.ts    per-session signals + aggregation                    │
│   logstore.ts  JSONL transcript archive                             │
│   atlas.ts     openAtlas factory, finalizeSession, distill          │
└───────┬─────────────────────────┬─────────────────────┬────────────┘
        │                         │                     │
        ▼                         ▼                     ▼
  <project>/.openatlas/     ~/.openatlas/memory/   ~/.openatlas/logs/
  archive.db                memory.db              <sessionId>.jsonl
  project reasoning         distilled steps        raw SDK events,
  (that project only)       (error/root_cause/     full fidelity
                            lesson/decision/
                            fix/insight across
                            all projects, tagged
                            sourceProject)
        │
        ▼
┌─────────────────────────────────────────────────────────────────────┐
│ openatlas app  (bun HTTP server, port 4817)                         │
│   JSON API (see app/API.md) + the web UI (dashboard, search,        │
│   reasoning graph, chat relay, archives, habits, session logs)      │
└─────────────────────────────────────────────────────────────────────┘
```

On `session.idle` the plugin finalizes the session (title + summary), builds the structural `EXTENDS` spine, computes `SHARES_FILE` links, and **distills** every `error` / `root_cause` / `lesson` / `decision` / `fix` / `insight` step into the general memory DB (tagged with `sourceProject`) for cross-project habit analysis.

## 3. Quickstart

### Option A — click-and-run package (Windows)

Build the single-file executable (bundles the web UI and the server):

```bash
cd D:\ggggggggggg\openatlas
bun install
bun run package      # -> dist-package/openatlas.exe (~94 MB)
```

Double-click `dist-package\openatlas.exe` (or run it from a terminal). It
starts the server on `http://localhost:4817`, spawns/adopts the opencode
harness on port 4729, opens your browser, and keeps reasoning data in
`%USERPROFILE%\.openatlas\data` (override with `OPENATLAS_DIR`; use
`OPENATLAS_OPEN=0` to skip auto-opening the browser, `OPENATLAS_PORT` for a
different port).

### Option B — from source (Bun)

Prerequisites: [Bun](https://bun.sh) >= 1.1.

```bash
cd D:\ggggggggggg\openatlas
bun install                # installs the engine, plugin, and app/ui workspaces
bun test                   # engine + app + plugin suites
bun run --cwd plugin build # bundle the plugin to plugin/dist/index.js
bun run build:ui           # build the web UI to app/ui/dist
```

### Register the plugin

Add the built plugin folder to the `"plugin"` array in your opencode config:

`C:\Users\admin\.config\opencode\opencode.jsonc`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-ralph-loop",
    // ...existing plugins...,
    "D:\\ggggggggggg\\openatlas\\plugin"
  ]
}
```

(Alternatively, if `opencode plugin add` is available: `opencode plugin add D:\ggggggggggg\openatlas\plugin`.)

Restart opencode. Verify with `/atlas_habits` or any atlas tool. From that point every session is captured automatically — no per-session setup.

### Run the local app

```bash
bun app/server.ts
# openatlas app listening on http://localhost:4817
```

The server serves the JSON API from the current project's archive. Env overrides: `OPENATLAS_PORT` (default `4817`), `OPENATLAS_DIR` (default `process.cwd()`), `OPENATLAS_OPEN` (auto-open browser; `1` forces it, `0` disables).

The web UI is built with `bun run build:ui` into `app/ui/dist` and served automatically — dashboard, search, reasoning graph, chat relay, archives, habits, and session logs. The full API contract lives in `app/API.md`.

## 4. The atlas tools

All capture is automatic — the tools exist to *curate* and *query* memory.

| Tool | Purpose | Arguments |
|---|---|---|
| `atlas_commit` | Commit an interesting step (decision, root_cause, lesson, fix...) with semantic links so the graph compounds | `kind` (step kind), `content`, `link_to` (related step ids, comma-separated), `context`, `outcome` |
| `atlas_recall` | Zero-LLM recall of relevant past chains before/while working | `q` (task summary or question), `file` (canonical repo-relative path), `k` (chain count, default 8), `scope` (`project` or `general`) |
| `atlas_habits` | Mechanical habit report for a project or across all projects | `scope` (`project` default, or `general`) |
| `atlas_logs` | List raw JSONL transcripts on disk | `scope` (optional) |

- **`atlas_commit`** — promote a noteworthy moment into explicit memory. The step gets a kind, optional content/context/outcome, and `link_to` creates semantic `BASED_ON` links (origin `agent`) to the given step ids.
- **`atlas_recall`** — returns ranked chains. Each chain has `steps` (ordered by seq), `files`, `rootCauses`, `lessons`, `outcome` (the last verification/fix/insight content), and a `score`.
- **`atlas_habits`** — per-session signals plus a cross-session aggregate with flags (`rework`, `noTests`, `highErrorRate`). Optional LLM summary via the app (`opencode run -p`).
- **`atlas_logs`** — inspect the raw `~/.openatlas/logs/*.jsonl` transcript archive.

## 5. Data model

All tables live in both DBs (project archive and general memory). The general DB keeps the same schema; steps carry `meta.sourceProject`.

```sql
sessions(id TEXT PK, project_id TEXT, project_label TEXT, agent TEXT,
         model TEXT, title TEXT, summary TEXT, started_at INTEGER,
         ended_at INTEGER, source TEXT)

steps(id TEXT PK, session_id TEXT, message_id TEXT, parent_id TEXT,
      seq INTEGER, kind TEXT, role TEXT, content TEXT, context TEXT,
      outcome TEXT, meta TEXT, created_at INTEGER)
  -- index: steps(session_id), steps(kind)

step_payloads(id INTEGER PK AUTOINCREMENT, step_id TEXT, kind TEXT,
              data TEXT)  -- data: zlib-compressed (deflate, level 6),
                          -- base64-encoded; kinds: args/output/result/
                          -- diff/reasoning/text/error

step_files(id INTEGER PK AUTOINCREMENT, step_id TEXT, path TEXT, kind TEXT)
  -- kind: target | read | mention; path: canonical repo-relative;
  -- unique (step_id, path); index: step_files(path)

step_links(id INTEGER PK AUTOINCREMENT, source_step_id TEXT,
           target_step_id TEXT, relation TEXT, confidence REAL,
           origin TEXT, meta TEXT, created_at INTEGER)
  -- unique (source_step_id, target_step_id, relation, origin)

meta(key TEXT PK, value TEXT)
```

**Step kinds:** `task`, `plan`, `hypothesis`, `action`, `blocker`, `decision`, `error`, `root_cause`, `fix`, `verification`, `insight`, `lesson`.

**Relations:** `CAUSED_BY`, `FIXES`, `BASED_ON`, `SIMILAR_TO`, `CONTRADICTS`, `EXTENDS`, `REFINES`, `SHARES_FILE`.

**Origins:** `auto` | `file` | `agent` | `recall`.

Large tool outputs and diffs never bloat the step row — they go to `step_payloads`, compressed. Steps are identified by `id` (e.g. `st_...`); sessions by `id` (e.g. `s_...`).

## 6. Storage layout

| What | Where |
|---|---|
| Project archive | `<project>/.openatlas/archive.db` (+ `-wal`/`-shm` WAL sidecars). Gitignored by default. |
| General memory | `~/.openatlas/memory/memory.db` (on Windows: `C:\Users\admin\.openatlas\memory\memory.db`) |
| Raw transcripts | `~/.openatlas/logs/<sessionId>.jsonl` |
| Engine | `engine/` — TypeScript, `bun:sqlite`, zero runtime dependencies |
| Plugin | `plugin/` — built to a self-contained `dist/index.js` |
| App | `app/server.ts` (bun HTTP server, single-file exe via `bun run package`) + `app/ui/` (React/Vite web UI) |

Both DBs run in WAL mode. The general DB is keyed by the project hash (`sha1` of the resolved project dir, first 16 hex chars), stored in `sessions.project_id` and as `meta.sourceProject` on distilled steps.

## 7. Linking model

Three layers, each with its own origin tag:

1. **Structural** (`origin = auto`) — the session spine: consecutive steps get `EXTENDS` edges (confidence 0.35); a failed tool call gets a `CAUSED_BY` edge from its `error` step to the failing `action` step; step `parent_id` carries the hierarchy.
2. **Architecture** (`origin = file`) — on `finalizeSession`, `SHARES_FILE` edges are created between every pair of steps that mention the same canonical file path. In the graph, files render as hub nodes connected to every step that touched them — this is the "file architecture view."
3. **Semantic** (`origin = agent` | `recall`) — `atlas_commit ... link_to` produces agent-authored links (default `BASED_ON`), and recall walks the graph surfacing existing edges. `meta` on links carries extras such as `{ file: <path> }` for `SHARES_FILE` edges.

## 8. Recall semantics

`atlas_recall` (and `GET /api/recall`) is purely mechanical:

1. **Seed** — text queries are tokenized (lowercased, stopwords removed, tokens of length > 1) and every step in scope is scored by word overlap: `hits / sqrt(|query| * |stepText|)`, keeping seeds above `0.15`. A `file` argument seeds every step referencing that canonical path with score `2.0`.
2. **Graph walk** — a breadth-first walk from each seed over weighted relations (`CAUSED_BY` 2.0, `FIXES` 1.8, `BASED_ON` 1.5, `REFINES` 1.3, `SIMILAR_TO` 1.2, `CONTRADICTS` 1.0, `EXTENDS` 0.5) plus `parent_id`/children at 0.6, capped at 80 steps per chain (`MAX_CHAIN`).
3. **Return** — chains are ranked by seed score and truncated to `k` (default 8). Each chain returns its steps ordered by `seq`, the files involved, extracted `root_cause` and `lesson` steps, and the `outcome` (content of the last `verification`/`fix`/`insight` step).

`scope=project` reads only the current project's archive; `scope=general` queries distilled memory across all projects. Recall is zero-LLM, so it is safe to call as often as you like.

## 9. Habit analysis

Per session, mechanical signals are computed without any LLM:

- `stepCount`, `toolCount`, `toolCounts` (per tool), `errorCount`, `errorRate`
- `reworkFiles` — target-edited files referenced 3+ times in one session
- `topFiles`, `testsRun` / `lintsRun` / `buildsRun` (regex-matched from tool command content)
- `durationMs`, `reasoningChars`

The aggregate rolls these up across sessions and emits flags:

- `rework:<n> files edited 3+ times`
- `noTests: edited code without running tests`
- `highErrorRate:<pct>% of tool calls failed`

To get a natural-language read on top of the numbers, the app's `POST /api/habits/summarize` pipes the mechanical report into `opencode run -p` (opencode's own model) and returns a blunt, actionable bullet list. The model is only used for this on-demand summary — never for capture or storage.

## 10. App API summary

`bun app/server.ts` serves a JSON API on port `4817` (override with `OPENATLAS_PORT`), same-origin with the built UI. Endpoints:

```
GET  /api/health            GET  /api/projects
GET  /api/sessions          GET  /api/session/:id
GET  /api/graph             GET  /api/recall?q=&file=&k=&scope=
GET  /api/habits            POST /api/habits/summarize
GET  /api/logs              GET  /api/log/:sessionId
```

All response shapes and types are documented in **`app/API.md`**, which is the contract. The React/Vite frontend under `app/ui/` is built with `bun run build:ui` and served same-origin — dashboard, search, reasoning graph (2D force layout, no dependencies), chat relay, archives, habits, and session logs.

## 11. Out of scope (v1)

- Embeddings / vector recall
- Automatic LLM link-proposal
- Documentation ingestion
- Git-branch semantics
- Vault markdown mirror
- npm publishing

## 12. Roadmap

- **Frontend UI** — Reasoning Graph 3D with file hubs, Archives browser, Habits dashboards, Sessions/Logs viewer (dependencies already wired in `app/ui`).
