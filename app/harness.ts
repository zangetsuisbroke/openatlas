import type { Capturer } from "../engine/src/index.ts";
import { debugLog } from "../engine/src/debug.ts";
import { spawnSync } from "node:child_process";

let child: ReturnType<typeof Bun.spawn> | null = null;
let base = "";
let started = false;

function resolveBase(): string {
  const env = process.env.OPENATLAS_OC_URL;
  if (env && /^https?:\/\//.test(env)) return env.replace(/\/+$/, "");
  return "";
}

export function harnessBase(): string {
  return base;
}

export function harnessStarted(): boolean {
  return started;
}

function pickPort(): number {
  const raw = Number(process.env.OPENATLAS_OC_PORT ?? 4729);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4729;
}

export async function startHarness(cwd: string): Promise<void> {
  if (started) return;
  const envUrl = resolveBase();
  if (envUrl) {
    base = envUrl;
    started = true;
    console.log(`openatlas harness: using existing opencode server at ${base}`);
    return;
  }
  const port = pickPort();
  // If a previous app instance left a healthy opencode serve orphaned on our
  // port (a force-kill bypasses graceful shutdown), adopt it instead of
  // spawning a second server that will fail to bind and immediately exit.
  const existing = `http://127.0.0.1:${port}`;
  try {
    const probe = await fetch(`${existing}/global/health`, { signal: AbortSignal.timeout(1500) });
    if (probe.ok) {
      base = existing;
      started = true;
      console.log(`openatlas harness: reusing healthy opencode server at ${existing}`);
      return;
    }
  } catch {
    /* fall through to spawn */
  }
  try {
    child = Bun.spawn(["opencode", "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const childRef = child;
    // If the harness child dies (crash, kill from outside, taskkill), drop the
    // started flag so the SSE loop stops retrying and the API degrades to 502
    // instead of spinning forever against a dead backend.
    child.exited
      .then(() => {
        if (child === childRef) {
          child = null;
          started = false;
          debugLog("harness.child", "opencode serve exited; harness marked stopped");
        }
      })
      .catch(() => {});
    const out = child.stdout as ReadableStream<Uint8Array>;
    const err = child.stderr as ReadableStream<Uint8Array>;
    const decoder = new TextDecoder();
    const teeOut = (chunk: Uint8Array) => logHarness(decoder.decode(chunk, { stream: true }));
    const teeErr = (chunk: Uint8Array) => logHarness(decoder.decode(chunk, { stream: true }));
    // The pipes reject when the child is killed/closed — swallow so a
    // stopHarness() on Windows (or a crash) never surfaces an unhandled rejection.
    out.pipeTo(new WritableStream({ write: teeOut })).catch(() => {});
    err.pipeTo(new WritableStream({ write: teeErr })).catch(() => {});
    base = `http://127.0.0.1:${port}`;
    started = true;
    console.log(`openatlas harness: spawned opencode serve on port ${port}`);
  } catch (err) {
    console.error("openatlas harness: failed to spawn opencode serve:", err);
    started = false;
  }
}

function logHarness(line: string): void {
  if (process.env.OPENATLAS_DEBUG === "1" || process.env.OPENATLAS_DEBUG === "true") {
    for (const l of line.split("\n").filter(Boolean)) console.log(`[opencode] ${l}`);
  }
}
export async function harnessReady(): Promise<boolean> {
  if (!started) return false;
  try {
    const res = await fetch(`${base}/global/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function ocFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${path}`, init);
}

type SseHandler = (event: { type: string; properties: Record<string, unknown> }) => void;

const sseHandlers = new Set<SseHandler>();

let sseLoop: Promise<void> | null = null;

export function onOpenCodeEvent(fn: SseHandler): () => void {
  sseHandlers.add(fn);
  return () => sseHandlers.delete(fn);
}

export function emitOpenCodeEvent(ev: { type: string; properties: Record<string, unknown> }): void {
  for (const fn of sseHandlers) {
    try {
      fn(ev);
    } catch {
      /* ignore handler errors */
    }
  }
}

export async function parseEventStream(res: Response, onEvent: (type: string, data: unknown) => void): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
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
        if (!data || data === "[DONE]") continue;
        try {
          onEvent(type, JSON.parse(data));
        } catch {
          onEvent(type, data);
        }
        type = "message";
      }
    }
  }
}

async function consumeEvents(capturer: Capturer, onIdle: ((sessionID: string) => void) | null): Promise<void> {
  let reconnect = 0;
  while (started) {
    try {
      const res = await fetch(`${base}/event`);
      if (!res.ok) {
        debugLog("harness.sse", `opencode /event HTTP ${res.status}; retrying in 2s`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      reconnect = 0;
      debugLog("harness.sse", `connected to ${base}/event`);
      await parseEventStream(res, (sseType, data) => {
        const obj = (data ?? {}) as Record<string, unknown>;
        const type = typeof obj.type === "string" ? obj.type : sseType;
        const properties = (obj.properties ?? {}) as Record<string, unknown>;
        // Pass the full event (including its stable id) so the Capturer can
        // dedup SSE replays; the plugin path already forwards the whole event.
        capturer.ingest(obj);
        if (type === "session.idle" && onIdle) {
          const sid = typeof properties.sessionID === "string" ? properties.sessionID : null;
          if (sid) onIdle(sid);
        }
        for (const fn of sseHandlers) {
          try {
            fn({ type, properties });
          } catch {
            /* ignore handler errors */
          }
        }
      });
      debugLog("harness.sse", "stream ended cleanly");
    } catch (err) {
      debugLog("harness.sse", `connection error: ${String(err)}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    // A clean stream end (server closed the connection) also needs a brief
    // pause, otherwise a server that closes immediately on connect would make
    // this loop spin hot.
    if (!started) break;
    reconnect += 1;
    debugLog("harness.sse", `reconnecting (attempt ${reconnect})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export function startCapture(capturer: Capturer, opts: { onIdle?: (sessionID: string) => void } = {}): void {
  if (!started) return;
  const onIdle = opts.onIdle ?? null;
  void (async () => {
    for (let i = 0; i < 30; i++) {
      if (await harnessReady()) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    sseLoop = consumeEvents(capturer, onIdle);
    await sseLoop;
  })();
}

export function stopHarness(): void {
  started = false;
  const childRef = child;
  child = null;
  if (childRef) {
    try {
      childRef.kill();
    } catch {
      /* ignore */
    }
    // On Windows a bare SIGKILL on the parent "opencode serve" process leaves
    // the actual server and its child processes orphaned and still bound to
    // the port. taskkill /T /F reaps the whole tree.
    if (process.platform === "win32" && childRef.pid) {
      try {
        spawnSync("taskkill", ["/pid", String(childRef.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        /* ignore */
      }
    }
  }
}
