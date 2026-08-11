// Minimal hand-rolled MCP server over streamable HTTP (JSON-RPC 2.0).
// Exposes the live Atlas knowledge graph as read-only tools so the opencode
// agent can pull workspace context on demand.
import { log } from "./log";
import type { GNode, GLink } from "../src/types";

const PROTOCOL_VERSION = "2025-06-18";

export interface GraphAccess {
  snap(): { nodes: GNode[]; links: GLink[] };
  nodes(): GNode[];
  links(): GLink[];
  refresh(): void;
}

let graph: GraphAccess | null = null;

export function setGraphAccess(a: GraphAccess): void {
  graph = a;
}

// ---------- tool implementations ----------
function toolList(): unknown {
  return [
    {
      name: "atlas_graph_search",
      description:
        "Search the Atlas workspace knowledge graph for nodes (files, folders, packages, tools, concepts, tasks, errors) by label or id. Use when you need to find what entities exist in the project or locate a specific file/component. Returns matching nodes with their type.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "text to match against node labels/ids" },
          limit: { type: "number", description: "max results (default 20)" },
        },
        required: ["query"],
      },
    },
    {
      name: "atlas_graph_query",
      description:
        "Get the subgraph around a node (its neighbors, relationships, and their types) up to a depth. Use when you need to understand how an entity connects to the rest of the project — e.g. which files import a module, what depends on a package, or what a tool touches.",
      inputSchema: {
        type: "object",
        properties: {
          node: { type: "string", description: "node id (e.g. 'w:src/auth/jwt.ts', 'dep:react', 'c:auth', 't:git'). Search with atlas_graph_search first if unsure." },
          depth: { type: "number", description: "neighborhood depth, 1-3 (default 1)" },
        },
        required: ["node"],
      },
    },
    {
      name: "atlas_graph_snapshot",
      description:
        "Return a summary of the current workspace graph: node/link counts by type, plus a sample of recent nodes. Use when you want an overall picture of the project structure before diving deeper.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "max sample nodes (default 50)" },
        },
      },
    },
    {
      name: "atlas_graph_path",
      description:
        "Find the shortest relationship path between two nodes. Use to understand how two entities are indirectly connected (e.g. a file to a decision, a tool to a package).",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "start node id" },
          to: { type: "string", description: "target node id" },
        },
        required: ["from", "to"],
      },
    },
  ];
}

function nodeMatches(n: GNode, q: string): boolean {
  const s = `${n.label} ${n.id} ${n.type}`.toLowerCase();
  return s.includes(q.toLowerCase());
}

function searchTool(args: Record<string, unknown>): unknown {
  const q = String(args.query ?? "");
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
  if (!graph) return { content: [{ type: "text", text: "graph not available" }], isError: true };
  const hits = graph.nodes().filter((n) => nodeMatches(n, q)).slice(0, limit);
  return {
    content: [
      {
        type: "text",
        text: hits.length
          ? hits.map((n) => `${n.id}\t[${n.type}]\t${n.label}`).join("\n")
          : `no graph nodes match "${q}"`,
      },
    ],
  };
}

function queryTool(args: Record<string, unknown>): unknown {
  const rootId = String(args.node ?? "");
  const depth = Math.max(1, Math.min(3, Number(args.depth) || 1));
  if (!graph) return { content: [{ type: "text", text: "graph not available" }], isError: true };
  const nodes = graph.nodes();
  const links = graph.links();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const root = byId.get(rootId);
  if (!root) return { content: [{ type: "text", text: `node "${rootId}" not found — use atlas_graph_search first` }], isError: true };

  const reached = new Set<string>([rootId]);
  let frontier = [rootId];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const l of links) {
        for (const n of [l.source, l.target]) {
          if (n === f && !reached.has(l.source === f ? l.target : l.source)) {
            const other = l.source === f ? l.target : l.source;
            reached.add(other);
            next.push(other);
          }
        }
      }
    }
    frontier = next;
  }

  const sub = [...reached].filter((id) => byId.has(id)).map((id) => byId.get(id)!);
  const subLinks = links.filter((l) => reached.has(l.source) && reached.has(l.target));
  const lines = [`node ${rootId} [${root.type}] ${root.label}`];
  for (const l of subLinks) {
    const from = byId.get(l.source)?.label ?? l.source;
    const to = byId.get(l.target)?.label ?? l.target;
    lines.push(`  ${from} -${l.relation}-> ${to}`);
  }
  if (subLinks.length === 0) lines.push("  (no direct relationships)");
  lines.push(`— ${sub.length} nodes, ${subLinks.length} links (depth ${depth})`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

function snapshotTool(args: Record<string, unknown>): unknown {
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
  if (!graph) return { content: [{ type: "text", text: "graph not available" }], isError: true };
  graph.refresh?.();
  const nodes = graph.nodes();
  const links = graph.links();
  const byType = new Map<string, number>();
  for (const n of nodes) byType.set(n.type, (byType.get(n.type) ?? 0) + 1);
  const byRel = new Map<string, number>();
  for (const l of links) byRel.set(l.relation, (byRel.get(l.relation) ?? 0) + 1);
  const lines = [`atlas graph snapshot: ${nodes.length} nodes, ${links.length} links`];
  lines.push(`by type: ${[...byType.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  lines.push(`by relation: ${[...byRel.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  const sample = [...nodes].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0)).slice(0, limit);
  lines.push("recently active:");
  for (const n of sample) lines.push(`  ${n.id}\t[${n.type}]\t${n.label}`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

function pathTool(args: Record<string, unknown>): unknown {
  const from = String(args.from ?? "");
  const to = String(args.to ?? "");
  if (!graph) return { content: [{ type: "text", text: "graph not available" }], isError: true };
  const nodes = graph.nodes();
  const links = graph.links();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (!byId.has(from) || !byId.has(to)) {
    return { content: [{ type: "text", text: "start or end node not found — use atlas_graph_search" }], isError: true };
  }
  const adj = new Map<string, string[]>();
  for (const l of links) {
    if (!adj.has(l.source)) adj.set(l.source, []);
    adj.get(l.source)!.push(l.target);
    if (!adj.has(l.target)) adj.set(l.target, []);
    adj.get(l.target)!.push(l.source);
  }
  const prev = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === to) break;
    for (const nb of adj.get(cur) ?? []) {
      if (!prev.has(nb)) {
        prev.set(nb, cur);
        queue.push(nb);
      }
    }
  }
  if (!prev.has(to)) {
    return { content: [{ type: "text", text: `no path between ${from} and ${to}` }] };
  }
  const path: string[] = [];
  let cur: string | null = to;
  while (cur) {
    path.unshift(cur);
    cur = prev.get(cur) ?? null;
  }
  return { content: [{ type: "text", text: path.map((id) => byId.get(id)?.label ?? id).join(" → ") }] };
}

const TOOLS: Record<string, (args: Record<string, unknown>) => unknown> = {
  atlas_graph_search: searchTool,
  atlas_graph_query: queryTool,
  atlas_graph_snapshot: snapshotTool,
  atlas_graph_path: pathTool,
};

// ---------- JSON-RPC handling ----------
interface RpcRequest {
  jsonrpc: string;
  id?: number | string;
  method: string;
  params?: any;
}

function rpcResult(id: number | string | null | undefined, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: number | string | null | undefined, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function handleMessage(msg: RpcRequest): unknown {
  const isNotif = msg.id === undefined;
  if (typeof msg.method !== "string" || msg.method.length === 0) {
    return rpcError(isNotif ? null : msg.id, -32600, "invalid request");
  }
  if (isNotif) return null; // notification — never respond
  switch (msg.method) {
    case "initialize":
      if (msg.params != null && (typeof msg.params !== "object" || Array.isArray(msg.params))) {
        return rpcError(msg.id, -32602, "invalid params");
      }
      return rpcResult(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "atlas-graph", version: "1.0.0" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
    case "notifications/roots/list_changed":
      return null; // 202, no body
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: toolList() });
    case "tools/call": {
      const p = msg.params;
      if (!p || typeof p !== "object" || Array.isArray(p)) return rpcError(msg.id, -32602, "invalid params");
      const { name, arguments: args } = p as { name?: unknown; arguments?: unknown };
      if (typeof name !== "string" || name.length === 0) return rpcError(msg.id, -32602, "invalid params: missing tool name");
      if (args != null && (typeof args !== "object" || Array.isArray(args))) return rpcError(msg.id, -32602, "invalid params: arguments must be an object");
      const fn = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
      if (!fn) return rpcError(msg.id, -32601, `unknown tool: ${name}`);
      try {
        return rpcResult(msg.id, fn((args as Record<string, unknown>) ?? {}));
      } catch (e) {
        log.error("mcp", `tools/call ${name} failed: ${String(e)}`);
        return rpcError(msg.id, -32603, `tool call failed: ${String(e)}`);
      }
    }
    case "tools/list_changed":
      return rpcResult(msg.id, {});
    default:
      return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

export async function handleMCP(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    // Streamable HTTP only carries JSON-RPC requests over POST; a GET would only
    // be used to open a server->client SSE stream, which this stateless server
    // never does.
    return new Response(null, {
      status: 405,
      headers: { Allow: "POST", "MCP-Protocol-Version": PROTOCOL_VERSION },
    });
  }
  const wantSse = (req.headers.get("accept") ?? "").includes("text/event-stream");
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    return respond(httpError(-32700, "parse error"), wantSse, performance.now());
  }
  const t0 = performance.now();
  if (!body || typeof body !== "object") {
    return respond(httpError(-32600, "invalid request"), wantSse, t0);
  }
  if (Array.isArray(body)) {
    if (body.length === 0) {
      // an empty batch is an Invalid Request per JSON-RPC 2.0 — single error response
      return respond(httpError(-32600, "invalid request"), wantSse, t0);
    }
    // batch — process each independently so one bad item can't kill the whole batch
    const out: unknown[] = [];
    for (const m of body) {
      if (!m || typeof m !== "object") {
        out.push(rpcError(null, -32600, "invalid batch item"));
        continue;
      }
      try {
        const r = handleMessage(m as RpcRequest);
        if (r !== null) out.push(r);
      } catch (e) {
        log.error("mcp", `batch item failed: ${String(e)}`);
        out.push(rpcError((m as RpcRequest).id ?? null, -32603, `batch item failed: ${String(e)}`));
      }
    }
    if (out.length === 0) {
      // batch of only notifications — no response body (202 Accepted)
      return new Response(null, { status: 202, headers: { "MCP-Protocol-Version": PROTOCOL_VERSION } });
    }
    return respond(out, wantSse, t0);
  }
  const msg = body as RpcRequest;
  const out = handleMessage(msg);
  if (out === null) {
    // notification → 202 Accepted, no body
    return new Response(null, { status: 202, headers: { "MCP-Protocol-Version": PROTOCOL_VERSION } });
  }
  return respond(out, wantSse, t0);
}

function httpError(code: number, message: string): unknown {
  return { jsonrpc: "2.0", id: null, error: { code, message } };
}

function respond(payload: unknown, sse: boolean, t0: number): Response {
  const json = JSON.stringify(payload);
  log.info("mcp", `response ${(performance.now() - t0).toFixed(1)}ms (${json.length} bytes)`);
  if (sse) {
    const data = `event: message\ndata: ${json}\n\n`;
    return new Response(data, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "MCP-Protocol-Version": PROTOCOL_VERSION },
    });
  }
  return new Response(json, {
    headers: { "Content-Type": "application/json; charset=utf-8", "MCP-Protocol-Version": PROTOCOL_VERSION },
  });
}
