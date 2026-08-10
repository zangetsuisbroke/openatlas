# openatlas app HTTP API

Served by `app/server.ts` (bun) on port `OPENATLAS_PORT` (default **4817**).
Same-origin: the server also serves the built UI from `app/ui/dist`.

All responses are JSON. `project` filters against the current project archive;
`scope=general` reads `~/.openatlas/memory/memory.db` (cross-project, habits/recall only).

## Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{ ok: true, version }` |
| GET | `/api/projects` | `{ current, projects: [{ projectId, label, dir, sessionCount, lastActive }] }` |
| GET | `/api/sessions?project=<id>&scope=project\|general` | `{ sessions: SessionSummary[] }` |
| GET | `/api/session/:id` | `{ session, steps: StepDetail[] }` |
| GET | `/api/graph?project=<id>&session=<id>` | `{ nodes: GraphNode[], links: GraphLink[] }` |
| GET | `/api/recall?q=&file=&k=&scope=` | `{ chains: RecallChain[] }` |
| GET | `/api/habits?scope=project\|general` | `HabitReport` |
| POST | `/api/habits/summarize` body `{ scope, projectId? }` | `{ summary: string }` (via `opencode run -p`) |
| GET | `/api/logs` | `{ logs: LogEntry[] }` |
| GET | `/api/log/:sessionId` | `{ sessionId, text }` (raw JSONL transcript) |
| GET | `/api/chat/sessions` | `{ sessions: ChatSession[], harnessUp }` (proxies opencode `/session`) |
| POST | `/api/chat/sessions` body `{ title? }` | `{ session: { id, title } }` (creates an opencode session, `201`) |
| GET | `/api/chat/sessions/:id/messages` | `{ messages: ChatMessage[] }` (proxies opencode `/session/:id/message`) |
| POST | `/api/chat/sessions/:id/message` body `{ text }` | `{ ok: true }` (`202`, async prompt via opencode `/session/:id/prompt_async`) |
| POST | `/api/chat/sessions/:id/abort` | `{ ok }` (proxies opencode `/session/:id/abort`) |
| GET | `/api/chat/events` | SSE stream of `event:` / `data:` lines with the live opencode event stream (type + properties) |

## Shapes (the engine's types, serialized)

```ts
type SessionSummary = {
  id: string; projectId: string; projectLabel: string;
  agent: string | null; model: string | null; title: string | null; summary: string | null;
  startedAt: number; endedAt: number | null;
  stepCount: number; fileCount: number; errorCount: number;
};

type StepDetail = {
  id: string; seq: number; kind: string; role: string;
  content: string | null; context: string | null; outcome: string | null;
  meta: Record<string, unknown> | null; createdAt: number;
  payloads: { kind: string; data: string }[];   // output/args/diff/result/reasoning/text/error — full fidelity
  files: { path: string; kind: "target" | "read" | "mention" }[];
  links: { sourceStepId: string; targetStepId: string; relation: string; origin: string }[];
};

type GraphNode = { id: string; type: "step" | "file"; label: string; kind: string | null; degree: number; meta: Record<string, unknown> | null };
type GraphLink = { id: string; source: string; target: string; relation: string; origin: string; label: string | null };
type GraphData = { nodes: GraphNode[]; links: GraphLink[] };

type RecallChain = {
  query: string; anchorStepId: string | null;
  steps: { id: string; seq: number; kind: string; content: string | null }[];
  files: string[]; rootCauses: { id: string; content: string | null }[];
  lessons: { id: string; content: string | null }[];
  outcome: string | null; score: number;
};

type HabitReport = {
  scope: "project" | "general"; projectId: string | null; sessionCount: number;
  signals: { sessionId: string; title: string | null; stepCount: number; toolCount: number;
    errorCount: number; reworkFiles: string[]; topFiles: string[]; testsRun: string[];
    durationMs: number; errorRate: number }[];
  aggregate: { stepCount: number; toolCount: number; errorCount: number; errorRate: number;
    topTools: [string, number][]; topFiles: [string, number][]; reworkFiles: string[];
    testsRun: string[]; flags: string[] };
};
```

`step.kind` ∈ `task plan hypothesis action blocker decision error root_cause fix verification insight lesson`
`step.origin` for links ∈ `auto file agent recall`

Chat shapes (proxied from the opencode server, trimmed in the app):

```ts
type ChatSession = {
  id: string; title: string | null; directory: string | null;
  time: { created?: number; updated?: number } | null;
};

type ChatMessage = {
  info: { id: string; role: string; sessionID: string; agent?: string | null;
    model?: { providerID?: string; modelID?: string } | null };
  parts: { id?: string; type: string; text?: string; tool?: string;
    state?: { status?: string; input?: unknown; output?: unknown; error?: unknown; title?: string };
    input?: unknown; output?: unknown; error?: unknown }[];
};
```

The SSE `/api/chat/events` stream emits lines shaped like `event: <type>\ndata: <json properties>\n\n` for every live opencode event; the UI reconnects with backoff if the stream drops.
