import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger, archivePathFor, generalMemoryPath } from "../engine/src/index.ts";

const PORT = 4861;
const tmp = path.join(os.tmpdir(), "openatlas-server-test", Math.random().toString(36).slice(2));
const mem = path.join(tmp, "mem");
const fakeBase = `http://127.0.0.1:${PORT + 1}`;

let fakeSessions: Array<Record<string, unknown>> = [{ id: "ses_fake_1", title: "fake session", directory: tmp }];
let fakeMessages: Record<string, unknown[]> = { ses_fake_1: [] };
let emittedRealEvents = false;

async function pollUntil(pred: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("pollUntil: condition not met within " + ms + "ms");
}

async function fakeBackend(): Promise<{ close: () => void }> {
  const server = Bun.serve({
    port: PORT + 1,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/global/health") return new Response("ok");
      if (url.pathname === "/provider") {
        return new Response(JSON.stringify({ connected: ["opencode"], default: { opencode: "big-pickle" } }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/session" && req.method === "GET") {
        return new Response(JSON.stringify(fakeSessions), { headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/session" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const created = { id: `ses_fake_${Date.now()}`, title: typeof body.title === "string" ? body.title : null };
        fakeSessions = [created, ...fakeSessions];
        return new Response(JSON.stringify(created), { status: 201, headers: { "content-type": "application/json" } });
      }
      const msgMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
      if (msgMatch && req.method === "GET") {
        const id = decodeURIComponent(msgMatch[1]!);
        return new Response(JSON.stringify(fakeMessages[id] ?? []), { headers: { "content-type": "application/json" } });
      }
      const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (promptMatch && req.method === "POST") {
        const id = decodeURIComponent(promptMatch[1]!);
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        if (body.model && typeof body.model === "object") {
          fakeMessages[id] = [
            ...(fakeMessages[id] ?? []),
            { info: { id: "am1", role: "assistant", sessionID: id, model: body.model }, parts: [{ type: "text", text: "fake reply" }] },
          ];
        }
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }
      const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
      if (abortMatch && req.method === "POST") return new Response("{}", { headers: { "content-type": "application/json" } });
      if (url.pathname === "/event") {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            const enc = new TextEncoder();
            let n = 0;
            if (!emittedRealEvents) {
              emittedRealEvents = true;
              const sessionID = "ses_hub_flow";
              const evs = [
                { id: "ev_hub_flow", type: "session.error", properties: { sessionID, error: { message: "integration boom" } } },
                { id: "ev_hub_flow_idle", type: "session.idle", properties: { sessionID } },
              ];
              for (const ev of evs) c.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
            }
            const timer = setInterval(() => {
              try {
                c.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify({ type: "fake", properties: { heartbeat: 1 } })}\n\n`));
              } catch {
                clearInterval(timer);
                return;
              }
              if (++n >= 5) {
                clearInterval(timer);
                try {
                  c.close();
                } catch {
                  /* ignore */
                }
              }
            }, 200);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { close: () => {
      try {
        server.stop(true);
      } catch {
        /* already stopped */
      }
    } };
}

let backend: { close: () => void } | null = null;
let serverTs: unknown = null;

beforeAll(async () => {
  backend = await fakeBackend();
  process.env.OPENATLAS_PORT = String(PORT);
  process.env.OPENATLAS_HOST = "127.0.0.1";
  process.env.OPENATLAS_DIR = tmp;
  process.env.OPENATLAS_OC_URL = fakeBase;
  process.env.OPENATLAS_MEMORY_DIR = mem;
  process.env.OPENATLAS_DEBUG = "1";
  serverTs = await import("./server.ts");
});

afterAll(async () => {
  backend?.close();
  try {
    const { stopHarness } = await import("./harness.ts");
    stopHarness();
  } catch {
    /* ignore */
  }
});

describe("chat API routes (proxied to opencode backend)", () => {
  test("GET /api/chat/sessions proxies the backend session list", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ id: string; title: string | null }>; harnessUp: boolean };
    expect(body.sessions.some((s) => s.id === "ses_fake_1")).toBe(true);
    expect(body.harnessUp).toBe(true);
  });

  test("POST /api/chat/sessions creates a session and returns 201", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "created via test" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { session: { id: string; title: string | null } };
    expect(body.session.id).toContain("ses_fake_");
    expect(body.session.title).toBe("created via test");
  });

  test("POST /api/chat/sessions with malformed JSON returns 400, not a silent success", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid JSON body");
  });

  test("POST message sends via prompt_async with a resolved default model", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions/ses_fake_1/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    const msgs = (await (await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions/ses_fake_1/messages`)).json()) as {
      messages: Array<{ info: { role: string; model?: { providerID?: string; modelID?: string } } }>;
    };
    expect(msgs.messages.some((m) => m.info.role === "assistant" && m.info.model?.modelID === "big-pickle")).toBe(true);
  });

  test("empty message is rejected with 400", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions/ses_fake_1/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    expect(res.status).toBe(400);
  });

  test("abort proxies and returns ok", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions/ses_fake_1/abort`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("chat events SSE stream stays open and carries a content-type of text/event-stream", async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/chat/events`, { signal: ctrl.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.body).not.toBeNull();
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
  });

  test("harness SSE pipeline (B2/H1): ingest + onIdle finalize distills app sessions into general memory", async () => {
    const sid = "ses_hub_flow";
    const archive = new Ledger(archivePathFor(tmp), { root: tmp, label: "server-test" });
    const general = new Ledger(generalMemoryPath());
    try {
      await pollUntil(() => {
        const errs = archive.listSteps(sid).filter((s) => s.kind === "error");
        const archRow = archive.getSession(sid);
        return errs.length >= 1 && errs.some((s) => s.sourceId === "ev_hub_flow") && !!archRow?.summary;
      }, 8000);

      const errStep = archive.listSteps(sid).find((s) => s.kind === "error" && s.sourceId === "ev_hub_flow");
      expect(errStep).toBeDefined();

      // The app-harness copy stays open (ended_at untouched)...
      const arch = archive.getSession(sid);
      expect(arch?.summary).toContain("1 errors");
      expect(arch?.endedAt).toBeNull();

      // ...while the distilled general-memory copy gets a proper ended_at.
      await pollUntil(() => general.getSession(sid) !== null, 8000);
      const gs = general.getSession(sid);
      expect(gs?.endedAt).not.toBeNull();
      expect(general.listSteps(sid).length).toBeGreaterThan(0);
    } finally {
      archive.close();
      general.close();
    }
  });
});

describe("chat routes when the opencode backend is down", () => {
  beforeAll(() => {
    backend?.close();
  });

  test("GET /api/chat/sessions returns 502 with a clear message when the backend is unreachable", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("opencode unavailable (backend down)");
  });

  test("POST /api/chat/sessions returns 502 when the backend is unreachable", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "unreachable" }),
    });
    expect(res.status).toBe(502);
  });

  test("POST message returns 502 instead of a 500 internal error when the backend is unreachable", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions/ses_fake_1/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("opencode unavailable (backend down)");
  });

  test("abort returns 502 when the backend is unreachable", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/chat/sessions/ses_fake_1/abort`, { method: "POST" });
    expect(res.status).toBe(502);
  });
});
