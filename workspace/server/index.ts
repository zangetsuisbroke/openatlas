import { randomUUID } from "node:crypto";
import { TerminalManager } from "./shell";
import * as ocServe from "./opencode-serve";
import { ensureConfig } from "./opencode-config";
import { scanNow, stale } from "./scan";
import { setGraphAccess, handleMCP } from "./mcp";
import { log } from "./log";
import type { GNode, GLink, StreamEvent, ServerMsg, ClientMsg } from "../src/types";
import { ASSETS as EMBEDDED_ASSETS } from "./embedded-assets";

const PORT = Math.min(65535, Math.max(1, Math.trunc(Number(process.env.PORT || 4819)) || 4819));
const boot = log.time("boot", "startup");
const MAX_EVENTS = 400;

// ---------- graph store ----------
class GraphStore {
  nodes = new Map<string, GNode>();
  links = new Map<string, GLink>();

  upsertNode(n: GNode) {
    const prev = this.nodes.get(n.id);
    if (prev) {
      prev.val = Math.min(12, Math.max(prev.val + 0.4, n.val));
      prev.label = n.label;
      prev.lastActive = n.lastActive;
    } else {
      this.nodes.set(n.id, n);
    }
  }
  touch(id: string, at: number) {
    const n = this.nodes.get(id);
    if (n) n.lastActive = at;
    return n;
  }
  link(source: string, target: string, relation: GLink["relation"], strength = 1) {
    const key = `${source}→${target}:${relation}`;
    this.links.set(key, { source, target, relation, strength });
  }
  snap(): { nodes: GNode[]; links: GLink[] } {
    return { nodes: [...this.nodes.values()], links: [...this.links.values()] };
  }
  remove(id: string): boolean {
    if (!this.nodes.has(id)) return false;
    this.nodes.delete(id);
    for (const [key, l] of [...this.links.entries()]) {
      if (l.source === id || l.target === id) this.links.delete(key);
    }
    return true;
  }
  clear() {
    this.nodes.clear();
    this.links.clear();
  }
}

const graph = new GraphStore();

// ---------- event store ----------
const events: StreamEvent[] = [];
function pushEvent(ev: Omit<StreamEvent, "id" | "at">): StreamEvent {
  const full: StreamEvent = { id: randomUUID(), at: Date.now(), ...ev };
  events.push(full);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  broadcast({ type: "event", data: full });
  if (ev.nodeId) broadcast({ type: "pulse", data: { nodeId: ev.nodeId, at: full.at } });
  return full;
}
function nodeEvent(kind: string, nodeId: string, subject: string, status: StreamEvent["status"], meta?: string) {
  graph.touch(nodeId, Date.now());
  pushEvent({ channel: "tool", kind, subject, status, meta, nodeId });
}

// ---------- ws hub ----------
const clients = new Set<WebSocket>();
function broadcast(msg: ServerMsg) {
  for (const ws of clients) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* drop */
    }
  }
}
function wsCount() {
  return clients.size;
}

// ---------- seed graph ----------
function seed() {
  const now = Date.now();
  const N = (id: string, label: string, type: GNode["type"], val = 1): GNode => ({
    id,
    label,
    type,
    val,
    created: now - 1,
    lastActive: now,
  });
  const L = (s: string, t: string, relation: GLink["relation"], strength = 1) => graph.link(s, t, relation, strength);

  const concepts = ["auth", "session", "oauth2", "jwt", "cache", "ratelimit", "middleware", "revocation", "rotation", "observability"];
  const conceptLabels: Record<string, string> = {
    auth: "Authentication",
    session: "Session Management",
    oauth2: "OAuth2",
    jwt: "JWT",
    cache: "Cache Invalidation",
    ratelimit: "Rate Limiting",
    middleware: "Middleware Pipeline",
    revocation: "Lazy Revocation",
    rotation: "Token Rotation",
    observability: "Observability",
  };
  const files = [
    "src/auth/middleware.ts",
    "src/auth/session.ts",
    "src/auth/oauth.ts",
    "src/auth/jwt.ts",
    "src/db/cache.ts",
    "src/api/routes.ts",
    "src/api/users.ts",
    "src/lib/redis.ts",
    "config/env.ts",
    "tests/auth.spec.ts",
  ];
  const decisions = [
    ["d-jwt", "JWT over opaque tokens"],
    ["d-redis", "Redis-backed sessions"],
    ["d-blacklist", "Blacklist lazy revocation"],
    ["d-tenant", "Per-tenant rate limits"],
    ["d-rotate", "Rotate on refresh"],
  ];
  const tools = ["editor", "bun-test", "redis-cli", "curl", "git", "opencode", "tsc"];
  const toolLabels: Record<string, string> = {
    editor: "editor",
    "bun-test": "bun test",
    "redis-cli": "redis-cli",
    curl: "curl",
    git: "git",
    opencode: "opencode",
    tsc: "tsc",
  };
  const tasks = ["Wire refresh flow", "Add session blacklist", "Unit test middleware", "Rotate signing keys", "Migrate sessions to Redis"];
  const memories = ["auth stack context", "team prefers RFC style", "prod runs k8s", "redis v7 quirk"];
  const errors = ["JWT_EXPIRED_HANDLING", "REDIS_CONN_RESET"];

  for (const c of concepts) graph.upsertNode(N(`c:${c}`, conceptLabels[c], "concept"));
  for (const f of files) {
    const short = f.split("/").slice(-2).join("/");
    graph.upsertNode(N(`f:${f}`, short, "file", 0.7));
  }
  for (const [id, label] of decisions) graph.upsertNode(N(id, label, "decision", 1.6));
  for (const t of tools) graph.upsertNode(N(`t:${t}`, toolLabels[t], "tool", 1.1));
  tasks.forEach((t, i) => graph.upsertNode(N(`k:${i}`, t, "task", 1.2)));
  memories.forEach((m, i) => graph.upsertNode(N(`m:${i}`, m, "memory", 0.8)));
  errors.forEach((e, i) => graph.upsertNode(N(`e:${i}`, e, "error", 1.0)));
  graph.upsertNode(N("a:atlas", "atlas-core", "agent", 2.0));

  // relations
  L("c:auth", "c:session", "relates");
  L("c:session", "c:jwt", "relates");
  L("c:session", "c:oauth2", "relates");
  L("c:session", "c:revocation", "derives");
  L("c:jwt", "c:revocation", "relates");
  L("c:jwt", "c:rotation", "derives");
  L("c:ratelimit", "c:middleware", "derives");
  L("c:cache", "c:revocation", "conflicts");
  L("c:auth", "c:middleware", "derives");
  L("c:observability", "c:auth", "relates");

  L("d-jwt", "c:jwt", "derives");
  L("d-jwt", "c:auth", "derives");
  L("d-redis", "c:session", "derives");
  L("d-redis", "c:cache", "relates");
  L("d-blacklist", "c:revocation", "derives");
  L("d-tenant", "c:ratelimit", "derives");
  L("d-rotate", "c:rotation", "derives");
  L("d-rotate", "c:jwt", "derives");

  L("a:atlas", "c:auth", "observes");
  L("a:atlas", "c:session", "observes");
  L("a:atlas", "m:1", "relates");
  L("a:atlas", "k:0", "activates");

  L("f:src/auth/middleware.ts", "c:middleware", "relates");
  L("f:src/auth/middleware.ts", "d-jwt", "relates");
  L("f:src/auth/middleware.ts", "t:tsc", "edits");
  L("f:src/auth/jwt.ts", "c:jwt", "relates");
  L("f:src/auth/jwt.ts", "d-rotate", "relates");
  L("f:src/auth/jwt.ts", "t:editor", "edits");
  L("f:src/auth/session.ts", "c:session", "relates");
  L("f:src/auth/session.ts", "d-redis", "relates");
  L("f:src/auth/session.ts", "t:editor", "edits");
  L("f:src/auth/oauth.ts", "c:oauth2", "relates");
  L("f:src/db/cache.ts", "c:cache", "relates");
  L("f:src/db/cache.ts", "d-redis", "relates");
  L("f:src/db/cache.ts", "t:redis-cli", "edits");
  L("f:src/api/routes.ts", "d-tenant", "relates");
  L("f:src/api/routes.ts", "c:ratelimit", "relates");
  L("f:src/api/routes.ts", "t:curl", "edits");
  L("f:src/api/users.ts", "c:auth", "relates");
  L("f:src/lib/redis.ts", "c:cache", "relates");
  L("f:src/lib/redis.ts", "d-redis", "relates");
  L("f:src/lib/redis.ts", "t:redis-cli", "edits");
  L("f:config/env.ts", "m:2", "relates");
  L("f:tests/auth.spec.ts", "t:bun-test", "edits");
  L("f:tests/auth.spec.ts", "k:2", "activates");

  L("t:opencode", "k:0", "activates");
  L("t:opencode", "k:1", "activates");
  L("t:bun-test", "k:2", "activates");
  L("t:git", "m:0", "relates");
  L("e:JWT_EXPIRED_HANDLING", "c:jwt", "relates");
  L("e:JWT_EXPIRED_HANDLING", "k:0", "conflicts");
  L("e:REDIS_CONN_RESET", "c:cache", "relates");
  L("k:4", "c:session", "depends");
  L("k:1", "c:revocation", "depends");
  L("k:0", "c:rotation", "depends");
  L("k:2", "d-jwt", "depends");

  broadcast({ type: "hello", data: graph.snap() });
}

seed();

// ---------- command observation ----------
let seq = 0;
function later(ms: number, fn: () => void) {
  setTimeout(fn, ms);
}

function fileNodesFrom(cmd: string, toolNodeId: string, status: StreamEvent["status"]) {
  const re = /(?:^|\s)([\w./\\-]+\.\w+)(?=\s|$)/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) {
    const p = m[1];
    if (!/\.(ts|tsx|js|jsx|py|go|rs|json|toml|md|css|html|env|sh|yml|yaml)$/i.test(p)) continue;
    const id = `f:${p.replace(/^\.\//, "")}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const short = p.split(/[/\\]/).slice(-2).join("/");
    const node: GNode = {
      id,
      label: short,
      type: "file",
      val: 0.7,
      created: Date.now(),
      lastActive: Date.now(),
    };
    if (!graph.nodes.has(id)) {
      graph.upsertNode(node);
      graph.link(id, toolNodeId, "edits", 1);
      broadcast({ type: "graph", data: { nodes: [node], links: [{ source: id, target: toolNodeId, relation: "edits", strength: 1 }] } });
    }
    later(200 + Math.random() * 400, () => {
      graph.touch(id, Date.now());
      pushEvent({ channel: "file", kind: "file.modified", subject: short, status, meta: p, nodeId: id });
    });
  }
}

function observeCommand(cmd: string, termId: string) {
  const parts = cmd.trim().split(/\s+/);
  const tool = parts[0].toLowerCase();
  const t0 = Date.now();
  const toolLabel = tool;

  const toolNodeId = `t:${tool}`;
  if (!graph.nodes.has(toolNodeId)) {
    graph.upsertNode({ id: toolNodeId, label: toolLabel, type: "tool", val: 1.1, created: t0, lastActive: t0 });
  }
  graph.touch(toolNodeId, t0);
  graph.touch("a:atlas", t0);

  if (tool === "atlas") {
    const sub = parts[1];
    if (sub === "demo") {
      runDemo(termId);
      return;
    }
    if (sub === "clear") {
      pushEvent({ channel: "system", kind: "graph.reset", subject: "knowledge graph reset", status: "info" });
      graph.clear();
      later(80, () => {
        seed();
        pushEvent({ channel: "system", kind: "graph.seeded", subject: "seeded base graph", status: "info" });
      });
      return;
    }
    pushEvent({ channel: "agent", kind: "agent.started", subject: "atlas", status: "run", meta: cmd });
    return;
  }

  pushEvent({ channel: "tool", kind: "tool.started", subject: toolLabel, status: "run", meta: cmd, nodeId: toolNodeId });
  broadcast({ type: "pulse", data: { nodeId: toolNodeId, at: t0 } });

  if (["git"].includes(tool)) {
    later(300, () => {
      pushEvent({ channel: "tool", kind: "tool.completed", subject: toolLabel, status: "ok", meta: "0 files changed", nodeId: toolNodeId });
      pushEvent({ channel: "agent", kind: "decision", subject: "keep history linear", status: "info", nodeId: "d-jwt" });
    });
  } else if (["bun", "npm", "pnpm", "yarn"].includes(tool)) {
    later(500, () => {
      pushEvent({ channel: "tool", kind: "tool.completed", subject: toolLabel, status: "ok", meta: "tests passed", nodeId: toolNodeId });
      pushEvent({ channel: "memory", kind: "memory.retrieved", subject: "auth stack context", status: "info", nodeId: "m:0" });
    });
    fileNodesFrom(cmd, toolNodeId, "ok");
  } else if (["python", "node", "bunx"].includes(tool)) {
    later(700, () => {
      pushEvent({ channel: "tool", kind: "tool.completed", subject: toolLabel, status: "ok", meta: "exit 0", nodeId: toolNodeId });
      pushEvent({ channel: "agent", kind: "agent.thinking", subject: "parsing output", status: "info", nodeId: "a:atlas" });
    });
    fileNodesFrom(cmd, toolNodeId, "ok");
  } else if (["curl", "wget"].includes(tool)) {
    later(600, () => {
      pushEvent({ channel: "tool", kind: "tool.completed", subject: toolLabel, status: "ok", meta: parts[1] ?? "", nodeId: toolNodeId });
      pushEvent({ channel: "memory", kind: "memory.retrieved", subject: "prod runs k8s", status: "info", nodeId: "m:2" });
    });
  } else if (["redis-cli"].includes(tool)) {
    later(400, () => {
      pushEvent({ channel: "tool", kind: "tool.completed", subject: toolLabel, status: "ok", meta: parts.slice(1).join(" "), nodeId: toolNodeId });
      pushEvent({ channel: "memory", kind: "memory.retrieved", subject: "redis v7 quirk", status: "info", nodeId: "m:3" });
    });
  } else if (["opencode"].includes(tool)) {
    pushEvent({ channel: "agent", kind: "agent.started", subject: "opencode", status: "run", meta: cmd, nodeId: "a:atlas" });
    later(900, () => {
      pushEvent({ channel: "agent", kind: "decision", subject: "Wire refresh flow first", status: "info", nodeId: "d-rotate" });
      pushEvent({ channel: "tool", kind: "tool.started", subject: "editor", status: "run", nodeId: "t:editor" });
    });
    later(1800, () => {
      pushEvent({ channel: "tool", kind: "tool.completed", subject: "editor", status: "ok", meta: "src/auth/jwt.ts", nodeId: "t:editor" });
      graph.upsertNode({ id: "f:src/auth/jwt.ts", label: "auth/jwt.ts", type: "file", val: 0.8, created: Date.now(), lastActive: Date.now() });
      broadcast({ type: "graph", data: graph.snap() });
      pushEvent({ channel: "file", kind: "file.modified", subject: "auth/jwt.ts", status: "ok", meta: "token rotation on refresh", nodeId: "f:src/auth/jwt.ts" });
      pushEvent({ channel: "agent", kind: "agent.completed", subject: "opencode", status: "ok", meta: cmd, nodeId: "a:atlas" });
    });
  } else if (["ls", "cat", "tail", "head", "grep", "rg", "find"].includes(tool)) {
    later(150, () => {
      pushEvent({ channel: "tool", kind: "tool.completed", subject: toolLabel, status: "ok", meta: parts.slice(1).join(" ") || ".", nodeId: toolNodeId });
    });
    fileNodesFrom(cmd, toolNodeId, "info");
  } else {
    // generic
    later(500 + Math.random() * 600, () => {
      const ok = Math.random() > 0.15;
      pushEvent({
        channel: "tool",
        kind: "tool.completed",
        subject: toolLabel,
        status: ok ? "ok" : "fail",
        meta: ok ? "exit 0" : "exit 1",
        nodeId: toolNodeId,
      });
      if (ok) pushEvent({ channel: "agent", kind: "agent.thinking", subject: "indexing output", status: "info", nodeId: "a:atlas" });
      else pushEvent({ channel: "system", kind: "error", subject: `${tool} exited non-zero`, status: "fail" });
    });
    fileNodesFrom(cmd, toolNodeId, "info");
  }
}

// ---------- demo sequence ----------
function runDemo(termId: string) {
  const demo: Array<[number, StreamEvent]> = [
    [0, { channel: "agent", kind: "agent.started", subject: "atlas-core", status: "run", meta: "demo sweep" }],
    [500, { channel: "agent", kind: "agent.thinking", subject: "scanning session graph", status: "run" }],
    [1100, { channel: "memory", kind: "memory.retrieved", subject: "auth stack context", status: "info", nodeId: "m:0" }],
    [1600, { channel: "tool", kind: "tool.started", subject: "redis-cli", status: "run", nodeId: "t:redis-cli" }],
    [2100, { channel: "file", kind: "file.modified", subject: "db/cache.ts", status: "ok", nodeId: "f:src/db/cache.ts" }],
    [2600, { channel: "agent", kind: "decision", subject: "JWT over opaque tokens", status: "ok", nodeId: "d-jwt" }],
    [3200, { channel: "tool", kind: "tool.completed", subject: "redis-cli", status: "ok", nodeId: "t:redis-cli" }],
    [3800, { channel: "agent", kind: "decision", subject: "Lazy revocation via blacklist", status: "ok", nodeId: "d-blacklist" }],
    [4400, { channel: "file", kind: "file.modified", subject: "auth/jwt.ts", status: "ok", nodeId: "f:src/auth/jwt.ts" }],
    [5000, { channel: "tool", kind: "tool.started", subject: "bun test", status: "run", nodeId: "t:bun-test" }],
    [5700, { channel: "tool", kind: "tool.completed", subject: "bun test", status: "ok", meta: "42 passed", nodeId: "t:bun-test" }],
    [6400, { channel: "memory", kind: "memory.stored", subject: "token rotation validated", status: "info", nodeId: "d-rotate" }],
    [7000, { channel: "agent", kind: "agent.completed", subject: "atlas-core", status: "ok", meta: "demo sweep done" }],
  ];
  let cursor = termId;
  for (const [delay, ev] of demo) {
    later(delay, () => {
      pushEvent({ ...ev, terminal: cursor });
    });
  }
}

// ---------- terminals ----------
const termManager = new TerminalManager({
  onData: (id, data) => broadcast({ type: "term:data", data: { id, data } }),
  onExit: (id) => {
    broadcast({ type: "term:exit", data: { id } });
    termManager.sessions.delete(id);
    log.info("pty", `session ${id.slice(0, 8)} exited`);
  },
  onCommand: (id, cmd) => {
    log.info("graph", `cmd[${id.slice(0, 8)}] ${cmd.slice(0, 120)}`);
    try {
      observeCommand(cmd, id);
    } catch (e) {
      console.error("observe failed", e);
      log.error("graph", `observeCommand failed: ${String(e)}`);
    }
  },
});

// ---------- static serving ----------
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

let EMBEDDED: Record<string, string> | null = Object.keys(EMBEDDED_ASSETS).length ? EMBEDDED_ASSETS : null;
const cached = new Map<string, { body: Uint8Array; type: string }>();
const DIST = import.meta.dir + "/../dist";
const HAS_DISK_DIST = await Bun.file(`${DIST}/index.html`).exists();

function cacheControlFor(path: string) {
  if (path.endsWith(".html")) return "no-cache";
  if (path.includes("/assets/")) return "public, max-age=31536000, immutable";
  return "public, max-age=60";
}

async function serveStatic(pathname: string): Promise<Response> {
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (p.endsWith("/")) p += "index.html";
  if (p === "") p = "/index.html";
  const rel = p.replace(/^\/+/, "");
  const relParts = rel.split("/");
  if (relParts.some((seg) => seg === ".." || seg === "." || seg.includes("\\") || seg.includes(":"))) {
    return new Response("not found", { status: 404 });
  }
  const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";

  if (cached.has(rel)) {
    const c = cached.get(rel)!;
    return new Response(c.body, { headers: { "Content-Type": c.type, "Cache-Control": cacheControlFor(rel) } });
  }

  if (HAS_DISK_DIST) {
    const file = Bun.file(`${DIST}/${rel}`);
    if (await file.exists()) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      cached.set(rel, { body: bytes, type });
      return new Response(bytes, { headers: { "Content-Type": type, "Cache-Control": cacheControlFor(rel) } });
    }
  }

  if (EMBEDDED && Object.hasOwn(EMBEDDED, rel)) {
    const raw = EMBEDDED[rel];
    const body = raw.startsWith("data:") ? Buffer.from(raw.split(",")[1], "base64") : new TextEncoder().encode(raw);
    cached.set(rel, { body, type });
    return new Response(body, { headers: { "Content-Type": type, "Cache-Control": cacheControlFor(rel) } });
  }

  if (rel === "index.html") {
    const ok = HAS_DISK_DIST || (EMBEDDED !== null && "index.html" in EMBEDDED);
    return ok ? serveStatic("/index.html") : new Response("app not built — missing index.html", { status: 404 });
  }
  if (!p.includes(".")) {
    return serveStatic(`/${rel}.html`).then((r) => (r.status === 404 ? new Response("not found", { status: 404 }) : r));
  }
  return new Response("not found", { status: 404 });
}

// ---------- server ----------
const server = Bun.serve<{ clientId: string }>({
  port: PORT,
  hostname: process.env.ATLAS_HOST || "127.0.0.1",
  websocket: {
    open(ws) {
      clients.add(ws);
      log.info("ws", `client connected (${wsCount()} total)`);
      ws.send(JSON.stringify({ type: "hello", data: graph.snap() } satisfies ServerMsg));
      for (const t of termManager.list()) {
        ws.send(JSON.stringify({ type: "term:create", data: { id: t.id, shell: t.shell, title: t.title } } satisfies ServerMsg));
      }
    },
    message(ws, raw) {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        log.warn("ws", "unparseable message");
        return;
      }
      switch (msg.type) {
        case "ping":
          ws.send(JSON.stringify({ type: "pong" } satisfies ServerMsg));
          break;
        case "term:input":
          termManager.write(msg.id, msg.data);
          break;
        case "term:resize":
          termManager.resize(msg.id, msg.cols, msg.rows);
          break;
        case "term:create": {
          const t = termManager.create();
          broadcast({ type: "term:create", data: { id: t.id, shell: t.shell, title: t.title } });
          break;
        }
        case "term:kill":
          termManager.kill(msg.id);
          break;
        case "graph:reset":
          pushEvent({ channel: "system", kind: "graph.reset", subject: "knowledge graph reset", status: "info" });
          graph.clear();
          later(80, () => {
            seed();
          });
          break;
        case "demo:run":
          runDemo("");
          break;
      }
    },
    close(ws) {
      clients.delete(ws);
      log.info("ws", `client disconnected (${wsCount()} total)`);
      if (clients.size === 0) {
        setTimeout(() => {
          if (clients.size === 0) {
            log.info("pty", "no clients — killing all terminal sessions");
            termManager.killAll();
          }
        }, 4000);
      }
    },
  },
  fetch(req, srv) {
    const url = new URL(req.url);
    const t0 = performance.now();
    const done = () => log.info("http", `${req.method} ${url.pathname} ${(performance.now() - t0).toFixed(0)}ms`);
    if (url.pathname === "/ws") {
      if (srv.upgrade(req)) {
        done();
        return undefined as unknown as Response;
      }
      return new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/api/opencode/start") {
      return ocServe.start().then((st) => {
        done();
        return json(st);
      });
    }
    if (url.pathname === "/api/opencode/session" && req.method === "POST") {
      return ocServe
        .start()
        .then(async (st) => {
          if (!st.running || !st.url) {
            done();
            return json({ ok: false, error: st.error || "serve not running" });
          }
          try {
            const r = await fetch(`${st.url}/session`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            });
            const body = (await r.json().catch(() => ({}))) as { id?: string; path?: string };
            if (!r.ok || !body.id) {
              done();
              return json({ ok: false, error: `opencode create session failed (${r.status})` });
            }
            done();
            return json({
              ok: true,
              id: body.id,
              url: `${st.url}/${body.path ?? "workspace"}/session/${body.id}`,
            });
          } catch (e) {
            done();
            return json({ ok: false, error: String(e) });
          }
        });
    }
    if (url.pathname === "/api/opencode/status") {
      done();
      return json(ocServe.status());
    }
    if (url.pathname === "/api/opencode/stop") {
      return ocServe.stop().then(() => {
        done();
        return json({ running: false });
      });
    }
    if (url.pathname === "/api/mcp" || url.pathname === "/api/mcp/") {
      return handleMCP(req).then((r) => {
        done();
        return r;
      });
    }
    if (url.pathname === "/") {
      return serveStatic("/index.html").then((r) => {
        done();
        return r;
      });
    }
    if (url.pathname === "/landing") {
      return serveStatic("/landing.html").then((r) => {
        done();
        return r;
      });
    }
    return serveStatic(url.pathname).then((r) => {
      done();
      return r;
    });
  },
});

// ---------- workspace scan -> graph merge ----------
function mergeScanNodes(nodes: GNode[], links: GLink[], rescanFiles: string[] = []) {
  const addedNodes: GNode[] = [];
  const addedLinks: GLink[] = [];
  const prevNodes = new Set(graph.nodes.keys());
  const prevLinks = new Set(graph.links.keys());
  for (const n of nodes) {
    if (!graph.nodes.has(n.id)) {
      graph.upsertNode(n);
      addedNodes.push(n);
    }
  }
  // Reconcile import links for files whose imports were just recomputed: any old
  // imports link the fresh scan no longer emits is stale (the import was removed).
  const rescanIds = new Set(rescanFiles.map((f) => `w:${f.split(/[\\/]/).join("/")}`));
  if (rescanIds.size) {
    for (const [key, l] of [...graph.links.entries()]) {
      if (l.relation === "imports" && rescanIds.has(String(l.source))) {
        graph.links.delete(key);
      }
    }
  }
  for (const l of links) {
    const key = `${l.source}→${l.target}:${l.relation}`;
    if (!graph.links.has(key)) {
      graph.links.set(key, l);
      addedLinks.push(l);
    }
  }
  // prune scan-owned nodes that no longer exist (files deleted, dirs removed,
  // deps dropped from package.json, branch changed/removed)
  const scanIds = new Set(nodes.map((n) => n.id));
  const removed = new Set<string>();
  for (const nid of [...graph.nodes.keys()]) {
    if (!nid.startsWith("w:") && !nid.startsWith("dep:") && !nid.startsWith("git:")) continue;
    if (!scanIds.has(nid)) {
      graph.nodes.delete(nid);
      removed.add(nid);
    }
  }
  // drop links that touched a removed node; keep every other scan link (e.g. imports
  // between still-existing files) even if this scan pass did not recompute it.
  for (const [key, l] of [...graph.links.entries()]) {
    if (removed.has(String(l.source)) || removed.has(String(l.target))) {
      graph.links.delete(key);
    }
  }
  const removedNodes = [...prevNodes].filter((k) => !graph.nodes.has(k));
  const removedLinks = [...prevLinks].filter((k) => !graph.links.has(k));
  if (removedNodes.length || removedLinks.length || addedNodes.length || addedLinks.length) {
    // one full snapshot keeps the client reconciled (nodes + links, incl. deletions)
    broadcast({ type: "graph", data: { ...graph.snap(), replace: true } });
  }
}
let scanning = false;
async function refreshScan() {
  if (!stale() || scanning) return;
  scanning = true;
  const t = log.time("scan", "refresh");
  try {
    const r = await scanNow();
    if (r) mergeScanNodes(r.nodes, r.links, r.rescanFiles);
  } finally {
    scanning = false;
    t();
  }
}
setGraphAccess({
  snap: () => graph.snap(),
  nodes: () => [...graph.nodes.values()],
  links: () => [...graph.links.values()],
  refresh: () => refreshScan(),
  addNode(type, label, id, meta) {
    const nodeId = id ?? `${type}:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const node: GNode = {
      id: nodeId,
      label,
      type,
      val: 1,
      created: Date.now(),
      lastActive: Date.now(),
      ...(meta as Record<string, unknown>),
    };
    graph.upsertNode(node);
    broadcast({ type: "graph", data: { nodes: [node], links: [] } });
    return node;
  },
  addLink(source, target, relation) {
    graph.link(source, target, relation);
    const link: GLink = { source, target, relation, strength: 1 };
    broadcast({ type: "graph", data: { nodes: [], links: [link] } });
    return link;
  },
  removeNode(id) {
    const ok = graph.remove(id);
    if (ok) broadcast({ type: "graph", data: { nodes: [], links: [], removed: [id] } });
    return ok;
  },
});
// kick off initial workspace scan in the background (non-blocking)
setTimeout(() => refreshScan(), 500);
// keep the scan fresh while the server runs
setInterval(() => refreshScan(), 15000);

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// ---------- graceful shutdown ----------
let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("app", `received ${sig} — shutting down`);
    try {
      termManager.dispose();
      await ocServe.stop();
    } catch (e) {
      log.warn("app", `shutdown: ${String(e)}`);
    }
    process.exit(0);
  });
}

boot();
ensureConfig(PORT);
log.info("app", `atlas-workspace serving on http://localhost:${PORT}`);
