import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { openAtlas, Recall, finalizeSession, debugLog } from "../engine/src/index.ts";
import type { Ledger, HabitReport } from "../engine/src/index.ts";
import { startHarness, startCapture, stopHarness, ocFetch, harnessStarted, harnessBase } from "./harness.ts";
import { SseHub } from "./sseHub.ts";
import { assets as UI_ASSETS } from "./ui-assets.ts";
import { PACKAGED, VERSION } from "./build-info.ts";

const PORT = Number(process.env.OPENATLAS_PORT ?? 4817);
const HOST = process.env.OPENATLAS_HOST ?? "127.0.0.1";
const DEBUG = process.env.OPENATLAS_DEBUG === "1" || process.env.OPENATLAS_DEBUG === "true";

const projectDir = path.resolve(
  process.env.OPENATLAS_DIR ?? (PACKAGED ? path.join(os.homedir(), ".openatlas", "data") : process.cwd())
);
const uiDist = path.resolve(process.env.OPENATLAS_UI_DIR ?? path.join(import.meta.dir, "ui", "dist"));

const atlas = openAtlas(projectDir);
const generalRecall = new Recall(atlas.general);
const sseHub = new SseHub();

startHarness(projectDir).then(() => startCapture(atlas.capturer, { onIdle: (sid) => finalizeSession(atlas, sid) }));

let defaultChatModel: { modelID: string; providerID: string } | null = null;

async function resolveDefaultModel(): Promise<{ modelID: string; providerID: string } | null> {
  if (defaultChatModel) return defaultChatModel;
  try {
    const res = await ocFetch("/provider");
    if (!res.ok) return null;
    const data = (await res.json()) as { connected?: string[]; default?: Record<string, string> };
    const connected = data.connected ?? [];
    const def = data.default ?? {};
    const providerID = connected.find((p) => p === "opencode") ?? connected[0];
    if (providerID && def[providerID]) {
      defaultChatModel = { modelID: def[providerID]!, providerID };
    }
  } catch {
    /* leave null */
  }
  return defaultChatModel;
}

function generalReport(): HabitReport {
  return atlas.habits.general();
}

function sessionSummary(ledger: Ledger, id: string): Record<string, unknown> | null {
  const s = ledger.getSession(id);
  if (!s) return null;
  const steps = ledger.listSteps(id);
  const files = new Set<string>();
  for (const st of steps) for (const f of ledger.listFiles(st.id)) files.add(f.path);
  return {
    ...s,
    stepCount: steps.length,
    fileCount: files.size,
    errorCount: steps.filter((st) => st.kind === "error").length,
  };
}

function stepDetail(ledger: Ledger, stepId: string): Record<string, unknown> {
  const st = ledger.getStep(stepId)!;
  return {
    ...st,
    payloads: ledger.listPayloads(stepId),
    files: ledger.listFiles(stepId),
    links: ledger.getLinks(stepId).map((l) => ({ sourceStepId: l.sourceStepId, targetStepId: l.targetStepId, relation: l.relation, origin: l.origin })),
  };
}

async function summarize(report: HabitReport): Promise<string> {
  const prompt = [
    "You are openatlas, an analyst of an AI coding agent's habits. Here is a mechanical report of agent behavior (tool usage, errors, rework, tests).",
    "Write a short, blunt, actionable analysis (5-8 bullets): the agent's strongest habits, its worst habits, and the top 3 concrete changes that would improve it.",
    "Report JSON:",
    JSON.stringify(report),
  ].join("\n\n");
  const cmd = process.env.OPENATLAS_LLM_CMD ?? "opencode";
  const cwd = process.env.OPENATLAS_DIR ?? process.cwd();
  try {
    const proc = Bun.spawn([cmd, "run", "-p", prompt], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.trim() || "no summary returned";
  } catch (err) {
    return `summarize unavailable (spawn ${cmd} failed): ${String(err)}`;
  }
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

type BodyResult = { ok: true; body: Record<string, unknown> } | { ok: false };

async function readBody(req: Request): Promise<BodyResult> {
  try {
    const b = await req.json();
    return { ok: true, body: b && typeof b === "object" ? (b as Record<string, unknown>) : {} };
  } catch {
    return { ok: false };
  }
}

function invalidBody(): Response {
  return json({ error: "invalid JSON body" }, 400);
}

async function chatFetch(p: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await ocFetch(p, init);
  } catch {
    return null;
  }
}

function chatUnavailable(): Response {
  return json({ error: "opencode unavailable (backend down)" }, 502);
}

function logRequest(req: Request, status: number, startedAt: number): void {
  if (!DEBUG) return;
  const url = new URL(req.url);
  const ms = Date.now() - startedAt;
  console.log(`[${new Date().toISOString()}] ${req.method} ${url.pathname}${url.search} -> ${status} (${ms}ms)`);
}

function stats(scope: string): Record<string, unknown> {
  const ledger = scope === "general" ? atlas.general : atlas.archive;
  const project = scope === "general" ? undefined : (atlas.archive.projectId ?? undefined);
  const sessions = ledger.listSessions(project);
  const kinds = new Map<string, number>();
  const files = new Set<string>();
  for (const s of sessions) {
    for (const st of ledger.listSteps(s.id)) {
      kinds.set(st.kind, (kinds.get(st.kind) ?? 0) + 1);
      for (const f of ledger.listFiles(st.id)) files.add(f.path);
    }
  }
  const links = ledger.listLinks();
  const day = Date.now() - 24 * 60 * 60 * 1000;
  return {
    scope,
    sessions: sessions.length,
    activeSessions24h: sessions.filter((s) => s.startedAt >= day).length,
    steps: [...kinds.values()].reduce((a, b) => a + b, 0),
    files: files.size,
    links: links.length,
    errors: kinds.get("error") ?? 0,
    fixes: kinds.get("fix") ?? 0,
    lessons: kinds.get("lesson") ?? 0,
    stepsByKind: Object.fromEntries(kinds),
  };
}

function safeDecode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

const UI_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

function serveStatic(p: string): Response {
  // Packaged build: serve from the embedded base64 manifest.
  const key = p === "/" ? "/index.html" : p;
  const embedded = UI_ASSETS[key];
  if (PACKAGED && embedded) {
    const data = Buffer.from(embedded, "base64");
    const mime = UI_MIME[path.extname(key)] ?? "application/octet-stream";
    return new Response(data, { headers: { "content-type": mime } });
  }
  // Source development / exe-adjacent UI: read from disk.
  const resolved = path.resolve(path.join(uiDist, p === "/" ? "index.html" : p));
  if (resolved !== uiDist && !resolved.startsWith(uiDist + path.sep)) return new Response("forbidden", { status: 403 });
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return new Response(Bun.file(resolved));
  if (fs.existsSync(path.join(uiDist, "index.html"))) return new Response(Bun.file(path.join(uiDist, "index.html")));
  return new Response("UI not built. Run: bun run build:ui", { status: 200, headers: { "content-type": "text/plain" } });
}

function openBrowser(url: string): void {
  const args =
    process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(args, { stdio: "ignore" });
  } catch {
    /* browser opener unavailable — the URL is still printed on stdout */
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const startedAt = Date.now();
    const respond = (res: Response): Response => {
      logRequest(req, res.status, startedAt);
      return res;
    };
    try {
      if (p === "/api/health") {
        return respond(
          json(
            {
              ok: true,
              version: VERSION,
              harness: { started: harnessStarted(), base: harnessBase() },
              sseClients: sseHub.clientCount,
            },
            200
          )
        );
      }

    if (p === "/api/stats") {
      const scope = url.searchParams.get("scope") ?? "project";
      return respond(json({ stats: stats(scope) }, 200));
    }

    if (p === "/api/chat/sessions" && req.method === "GET") {
      if (!harnessStarted()) return respond(chatUnavailable());
      const res = await chatFetch("/session");
      if (!res) return respond(chatUnavailable());
      if (!res.ok) return respond(json({ error: `opencode unavailable (${res.status})` }, 502));
      const sessions = (await res.json()) as Array<Record<string, unknown>>;
      const out = sessions.map((s) => ({
        id: String(s.id ?? ""),
        title: typeof s.title === "string" ? s.title : null,
        directory: typeof s.directory === "string" ? s.directory : null,
        time: s.time ?? null,
      }));
      return respond(json({ sessions: out, harnessUp: harnessStarted() }, 200));
    }

    if (p === "/api/chat/sessions" && req.method === "POST") {
      const parsed = await readBody(req);
      if (!parsed.ok) return respond(invalidBody());
      const body = parsed.body;
      const res = await chatFetch("/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: typeof body.title === "string" ? body.title : undefined }),
      });
      if (!res) return respond(chatUnavailable());
      if (!res.ok) return respond(json({ error: `opencode create failed (${res.status})` }, 502));
      const created = (await res.json()) as Record<string, unknown>;
      return respond(json({ session: { id: String(created.id ?? ""), title: typeof created.title === "string" ? created.title : null } }, 201));
    }

    const chatSessionMatch = p.match(/^\/api\/chat\/sessions\/([^/]+)\/messages$/);
    if (chatSessionMatch && req.method === "GET") {
      const id = safeDecode(chatSessionMatch[1]!);
      if (!id) return respond(json({ error: "bad session id" }, 400));
      const res = await chatFetch(`/session/${encodeURIComponent(id)}/message`);
      if (!res) return respond(chatUnavailable());
      if (!res.ok) return respond(json({ error: `opencode unavailable (${res.status})` }, 502));
      const messages = await res.json();
      return respond(json({ messages }, 200));
    }

    const chatSendMatch = p.match(/^\/api\/chat\/sessions\/([^/]+)\/message$/);
    if (chatSendMatch && req.method === "POST") {
      const id = safeDecode(chatSendMatch[1]!);
      if (!id) return respond(json({ error: "bad session id" }, 400));
      const parsed = await readBody(req);
      if (!parsed.ok) return respond(invalidBody());
      const body = parsed.body;
      const text = typeof body.text === "string" ? body.text : "";
      if (!text.trim()) return respond(json({ error: "empty message" }, 400));
      const model = (await resolveDefaultModel()) ?? undefined;
      const res = await chatFetch(`/session/${encodeURIComponent(id)}/prompt_async`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(model ? { model } : {}),
          parts: [{ type: "text", text }],
        }),
      });
      if (!res) return respond(chatUnavailable());
      if (!res.ok) return respond(json({ error: `opencode send failed (${res.status})` }, 502));
      return respond(json({ ok: true }, 202));
    }

    const chatAbortMatch = p.match(/^\/api\/chat\/sessions\/([^/]+)\/abort$/);
    if (chatAbortMatch && req.method === "POST") {
      const id = safeDecode(chatAbortMatch[1]!);
      if (!id) return respond(json({ error: "bad session id" }, 400));
      const res = await chatFetch(`/session/${encodeURIComponent(id)}/abort`, { method: "POST" });
      if (!res) return respond(chatUnavailable());
      return respond(json({ ok: res.ok }, res.ok ? 200 : 502));
    }

    if (p === "/api/chat/events") {
      const stream = sseHub.connect(req.signal);
      debugLog("sse.client", `connected (total ${sseHub.clientCount})`);
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    }

    if (p === "/api/projects") {
      const sessions = atlas.archive.listSessions();
      const lastActive = sessions.length > 0 ? Math.max(...sessions.map((s) => s.startedAt)) : 0;
      return respond(
        json(
          {
            current: atlas.archive.projectId,
            projects: [
              {
                projectId: atlas.archive.projectId,
                label: atlas.archive.projectLabel,
                dir: atlas.projectDir,
                sessionCount: sessions.length,
                lastActive,
              },
            ],
          },
          200
        )
      );
    }

    if (p === "/api/sessions") {
      const scope = url.searchParams.get("scope") ?? "project";
      const ledger = scope === "general" ? atlas.general : atlas.archive;
      const project = scope === "general" ? undefined : (url.searchParams.get("project") ?? atlas.archive.projectId ?? undefined);
      const sessions = project ? ledger.listSessions(project) : ledger.listSessions();
      return respond(json({ sessions: sessions.map((s) => sessionSummary(ledger, s.id)).filter(Boolean) }, 200));
    }

    const sessionMatch = p.match(/^\/api\/session\/(.+)$/);
    if (sessionMatch) {
      const id = safeDecode(sessionMatch[1]!);
      if (!id || !atlas.logs.isSafeId(id)) return respond(json({ error: "bad session id" }, 400));
      const scope = url.searchParams.get("scope") ?? "project";
      const ledger = scope === "general" ? atlas.general : atlas.archive;
      const session = ledger.getSession(id);
      if (!session) return respond(json({ error: "session not found" }, 404));
      const steps = ledger.listSteps(id).map((st) => stepDetail(ledger, st.id));
      return respond(json({ session: sessionSummary(ledger, id), steps }, 200));
    }

    if (p === "/api/graph") {
      const scope = url.searchParams.get("scope") ?? "project";
      const ledger = scope === "general" ? atlas.general : atlas.archive;
      const project = scope === "general" ? undefined : (url.searchParams.get("project") ?? atlas.archive.projectId ?? undefined);
      return respond(json(ledger.graph(project), 200));
    }

    if (p === "/api/recall") {
      const scope = url.searchParams.get("scope") ?? "project";
      const recall = scope === "general" ? generalRecall : atlas.recall;
      const q = url.searchParams.get("q") || null;
      const file = url.searchParams.get("file") || null;
      const k = Number(url.searchParams.get("k") ?? 8);
      const project = scope === "general" ? null : atlas.archive.projectId;
      const chains = recall.query({ q, file, k, projectId: project });
      return respond(json({ chains }, 200));
    }

    if (p === "/api/habits") {
      const scope = url.searchParams.get("scope") ?? "project";
      return respond(json(scope === "general" ? generalReport() : atlas.habits.project(), 200));
    }

    if (p === "/api/habits/summarize" && req.method === "POST") {
      const parsed = await readBody(req);
      if (!parsed.ok) return respond(invalidBody());
      const body = parsed.body;
      const scope = (body.scope as string) ?? "project";
      const report = scope === "general" ? generalReport() : atlas.habits.project();
      const summary = await summarize(report);
      return respond(json({ summary }, 200));
    }

    if (p === "/api/logs") {
      return respond(json({ logs: atlas.logs.list() }, 200));
    }

    const logMatch = p.match(/^\/api\/log\/(.+)$/);
    if (logMatch) {
      const id = safeDecode(logMatch[1]!);
      if (!id || !atlas.logs.isSafeId(id)) return respond(json({ error: "bad session id" }, 400));
      const text = atlas.logs.read(id);
      if (text === "" && !atlas.logs.list().some((e) => e.sessionId === id)) return respond(json({ error: "log not found" }, 404));
      return respond(json({ sessionId: id, text }, 200));
    }

    if (p.startsWith("/api/")) return respond(json({ error: "not found" }, 404));

    return respond(serveStatic(p));
    } catch (err) {
      console.error("server error:", err);
      return json({ error: "internal error" }, 500);
    }
  },
});

console.log(`openatlas app listening on http://${HOST}:${server.port}`);
console.log(`  project archive: ${projectDir}/.openatlas/archive.db`);
console.log(`  general memory:  ~/.openatlas/memory/memory.db`);
console.log(`  transcripts:     ~/.openatlas/logs/`);

// Click-and-run: open the browser automatically once the server is up. Gated
// so plain `bun app/server.ts` development stays quiet unless asked.
const AUTO_OPEN = process.env.OPENATLAS_OPEN === "1" || (PACKAGED && process.env.OPENATLAS_OPEN !== "0");
if (AUTO_OPEN) {
  const url = `http://${HOST}:${server.port}`;
  console.log(`opening ${url}`);
  setTimeout(() => openBrowser(url), 400);
}

process.on("exit", () => stopHarness());

let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    stopHarness();
    server.stop(true);
  } catch {
    /* ignore */
  }
  // Close the SQLite handles so WAL data is checkpointed cleanly on exit.
  try {
    atlas.archive.close();
  } catch {
    /* ignore */
  }
  try {
    atlas.general.close();
  } catch {
    /* ignore */
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", (err) => {
  console.error("uncaught exception:", err);
  shutdown(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection:", reason);
  shutdown(1);
});
