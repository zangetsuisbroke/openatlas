export type Scope = "project" | "general";

export interface SessionSummary {
  id: string;
  projectId: string;
  projectLabel: string;
  agent: string | null;
  model: string | null;
  title: string | null;
  summary: string | null;
  startedAt: number;
  endedAt: number | null;
  stepCount: number;
  fileCount: number;
  errorCount: number;
}

export interface StepPayload {
  id: number;
  stepId: string;
  kind: string;
  data: string;
}

export interface StepFile {
  id: number;
  stepId: string;
  path: string;
  kind: "target" | "read" | "mention";
}

export interface StepLink {
  sourceStepId: string;
  targetStepId: string;
  relation: string;
  origin: string;
}

export interface StepDetail {
  id: string;
  seq: number;
  kind: string;
  role: string;
  content: string | null;
  context: string | null;
  outcome: string | null;
  meta: Record<string, unknown> | null;
  createdAt: number;
  payloads: StepPayload[];
  files: StepFile[];
  links: StepLink[];
}

export interface GraphNode {
  id: string;
  type: "step" | "file";
  label: string;
  kind: string | null;
  degree: number;
  meta: Record<string, unknown> | null;
}

export interface GraphLink {
  id: string;
  source: string;
  target: string;
  relation: string;
  origin: string;
  label: string | null;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface RecallStep {
  id: string;
  seq: number;
  kind: string;
  content: string | null;
  sessionId?: string;
}

export interface RecallChain {
  query: string;
  anchorStepId: string | null;
  steps: RecallStep[];
  files: string[];
  rootCauses: { id: string; content: string | null }[];
  lessons: { id: string; content: string | null }[];
  outcome: string | null;
  score: number;
}

export interface HabitSignal {
  sessionId: string;
  title: string | null;
  stepCount: number;
  toolCount: number;
  errorCount: number;
  retryCount: number;
  reworkFiles: string[];
  topFiles: string[];
  testsRun: string[];
  lintsRun: string[];
  buildsRun: string[];
  durationMs: number;
  reasoningChars: number;
  errorRate: number;
}

export interface HabitAggregate {
  stepCount: number;
  toolCount: number;
  errorCount: number;
  errorRate: number;
  topTools: Array<[string, number]>;
  topFiles: Array<[string, number]>;
  reworkFiles: string[];
  testsRun: string[];
  flags: string[];
}

export interface HabitReport {
  scope: "project" | "general";
  projectId: string | null;
  sessionCount: number;
  signals: HabitSignal[];
  aggregate: HabitAggregate;
}

export interface LogEntry {
  sessionId: string;
  path: string;
  size: number;
  updatedAt: number;
}

export interface ProjectInfo {
  projectId: string;
  label: string;
  dir: string;
  sessionCount: number;
  lastActive: number;
}

export interface Stats {
  scope: Scope;
  sessions: number;
  activeSessions24h: number;
  steps: number;
  files: number;
  links: number;
  errors: number;
  fixes: number;
  lessons: number;
  stepsByKind: Record<string, number>;
}

export interface ChatSession {
  id: string;
  title: string | null;
  directory: string | null;
  time: { created?: number } | null;
}

export interface ChatPart {
  id?: string;
  type: string;
  text?: string;
  tool?: string;
  state?: { status?: string; input?: unknown; output?: unknown; error?: unknown; title?: string };
  input?: unknown;
  output?: unknown;
  error?: unknown;
}

export interface ChatMessage {
  info: {
    id: string;
    role: string;
    sessionID: string;
    agent?: string | null;
    model?: { providerID?: string; modelID?: string } | null;
  };
  parts: ChatPart[];
}

const TIMEOUT_MS = 20000;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function hasArray(v: unknown): v is { [k: string]: unknown } & { nodes: unknown[]; links: unknown[] } {
  return isObj(v) && Array.isArray(v.nodes) && Array.isArray(v.links);
}

function hasSessions(v: unknown): v is { sessions: unknown[] } {
  return isObj(v) && Array.isArray(v.sessions);
}

function hasChains(v: unknown): v is { chains: unknown[] } {
  return isObj(v) && Array.isArray(v.chains);
}

function hasLogs(v: unknown): v is { logs: unknown[] } {
  return isObj(v) && Array.isArray(v.logs);
}

function hasSteps(v: unknown): v is { session: unknown; steps: unknown[] } {
  return isObj(v) && isObj(v.session) && Array.isArray(v.steps);
}

function hasAggregate(v: unknown): v is { aggregate: unknown } {
  return isObj(v) && isObj(v.aggregate);
}

async function get<T>(path: string, guard?: (v: unknown) => boolean): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(path, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    const data: unknown = await res.json();
    if (guard && !guard(data)) throw new Error(`${path}: unexpected response shape`);
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export const api = {
  health: () =>
    get<{ ok: boolean; version: string; harness?: { started: boolean; base?: string | null }; sseClients?: number }>(
      "/api/health",
    ),
  projects: () => get<{ current: string; projects: ProjectInfo[] }>("/api/projects"),
  stats: (scope: Scope) => get<{ stats: Stats }>(`/api/stats${qs({ scope })}`),
  sessions: (scope: Scope) => get<{ sessions: SessionSummary[] }>(`/api/sessions${qs({ scope })}`, hasSessions),
  session: (id: string, scope: Scope) =>
    get<{ session: SessionSummary; steps: StepDetail[] }>(`/api/session/${encodeURIComponent(id)}${qs({ scope })}`, hasSteps),
  graph: (scope: Scope) => get<GraphData>(`/api/graph${qs({ scope })}`, hasArray),
  recall: (q: string, file: string, k: number, scope: Scope) =>
    get<{ chains: RecallChain[] }>(`/api/recall${qs({ q, file, k, scope })}`, hasChains),
  habits: (scope: Scope) => get<HabitReport>(`/api/habits${qs({ scope })}`, hasAggregate),
  summarize: (scope: Scope) => post<{ summary: string }>("/api/habits/summarize", { scope }),
  logs: () => get<{ logs: LogEntry[] }>("/api/logs", hasLogs),
  log: (id: string) => get<{ sessionId: string; text: string }>(`/api/log/${encodeURIComponent(id)}`),
  chat: {
    listSessions: () => get<{ sessions: ChatSession[]; harnessUp: boolean }>("/api/chat/sessions"),
    createSession: (title?: string) => post<{ session: ChatSession }>("/api/chat/sessions", { title }),
    messages: (id: string) => get<{ messages: ChatMessage[] }>(`/api/chat/sessions/${encodeURIComponent(id)}/messages`),
    send: (id: string, text: string) => post<{ ok: boolean }>(`/api/chat/sessions/${encodeURIComponent(id)}/message`, { text }),
    abort: (id: string) => post<{ ok: boolean }>(`/api/chat/sessions/${encodeURIComponent(id)}/abort`, {}),
    events: (onEvent: (type: string, properties: Record<string, unknown>) => void): (() => void) => {
      const ctrl = new AbortController();
      void (async () => {
        let attempt = 0;
        while (!ctrl.signal.aborted) {
          try {
            const res = await fetch("/api/chat/events", { signal: ctrl.signal });
            if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
            attempt = 0;
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            let type = "message";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const lines = buf.split("\n");
              buf = lines.pop() ?? "";
              for (const line of lines) {
                if (line.startsWith("event:")) type = line.slice(6).trim();
                else if (line.startsWith("data:")) {
                  const data = line.slice(5).trim();
                  if (!data) continue;
                  try {
                    onEvent(type, JSON.parse(data));
                  } catch {
                    onEvent(type, { raw: data });
                  }
                  type = "message";
                }
              }
            }
          } catch {
            /* connection dropped — reconnect below */
          }
          if (ctrl.signal.aborted) break;
          // The server closes the SSE stream on navigation / idle; reconnect
          // with bounded exponential backoff instead of silently going stale
          // (browser logs ERR_INCOMPLETE_CHUNKED_ENCODING in that case).
          attempt += 1;
          await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 5000)));
        }
      })();
      return () => ctrl.abort();
    },
  },
};

export const KIND_COLORS: Record<string, string> = {
  task: "#4ea1ff",
  plan: "#9a8cff",
  hypothesis: "#ffb86c",
  action: "#5eead4",
  blocker: "#f43f5e",
  decision: "#f59e0b",
  error: "#ef4444",
  root_cause: "#fb923c",
  fix: "#22c55e",
  verification: "#34d399",
  insight: "#e879f9",
  lesson: "#a3e635",
};

export const ORIGIN_COLORS: Record<string, string> = {
  auto: "#8b93a3",
  file: "#22d3ee",
  agent: "#fbbf24",
  recall: "#c084fc",
};

export const KIND_LABELS: Record<string, string> = {
  task: "Task",
  plan: "Plan",
  hypothesis: "Hypothesis",
  action: "Action",
  blocker: "Blocker",
  decision: "Decision",
  error: "Error",
  root_cause: "Root cause",
  fix: "Fix",
  verification: "Verification",
  insight: "Insight",
  lesson: "Lesson",
};

export function fmtTime(ms: number | null | undefined): string {
  if (!Number.isFinite(ms) || !ms) return "—";
  return new Date(ms).toLocaleString();
}

export function fmtDur(ms: number | null | undefined): string {
  if (!Number.isFinite(ms) || !ms) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (!Number.isFinite(n) || !n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function fmtWhen(ms: number | null | undefined): string {
  if (!Number.isFinite(ms) || !ms) return "—";
  const diff = Date.now() - ms;
  const s = Math.round(diff / 1000);
  if (s < 45) return "just now";
  if (s < 90) return "a minute ago";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(ms).toLocaleDateString();
}

export function fmtDate(ms: number | null | undefined): string {
  if (!Number.isFinite(ms) || !ms) return "—";
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
