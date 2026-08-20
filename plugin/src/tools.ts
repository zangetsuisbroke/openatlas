// Atlas graph tool definitions for the OpenCode plugin.
// Each tool calls the Atlas MCP server running on localhost.

export interface ToolDef {
  name: string;
  description: string;
  input: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

async function callMcp(name: string, args: Record<string, unknown>, port: number = 4819): Promise<string> {
  const resp = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const data = (await resp.json()) as { result?: { content?: { text: string }[] }; error?: { message: string } };
  if (data.error) return `Error: ${data.error.message}`;
  return data.result?.content?.map((c) => c.text).join("\n") ?? "no result";
}

export const TOOLS: ToolDef[] = [
  {
    name: "atlas_graph_search",
    description:
      "Search the Atlas workspace knowledge graph for nodes (files, folders, packages, tools, concepts, tasks, errors) by label or id. Use when you need to find what entities exist in the project or locate a specific file/component.",
    input: {
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
      "Get the subgraph around a node (its neighbors, relationships, and their types) up to a depth. Use when you need to understand how an entity connects to the rest of the project — e.g. which files import a module, what depends on a package.",
    input: {
      type: "object",
      properties: {
        node: { type: "string", description: "node id (e.g. 'w:src/auth/jwt.ts', 'dep:react'). Search with atlas_graph_search first if unsure." },
        depth: { type: "number", description: "neighborhood depth, 1-3 (default 1)" },
      },
      required: ["node"],
    },
  },
  {
    name: "atlas_graph_snapshot",
    description:
      "Return a summary of the current workspace graph: node/link counts by type, plus a sample of recent nodes. Use when you want an overall picture of the project structure before diving deeper.",
    input: {
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
    input: {
      type: "object",
      properties: {
        from: { type: "string", description: "start node id" },
        to: { type: "string", description: "target node id" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "atlas_graph_add_node",
    description:
      "Create a new node in the knowledge graph. Use to track decisions, tasks, memories, errors, or concepts that emerge during work. The graph is live — nodes appear immediately in the UI.",
    input: {
      type: "object",
      properties: {
        type: { type: "string", description: "node type: concept, decision, task, memory, or error" },
        label: { type: "string", description: "human-readable label for the node" },
        id: { type: "string", description: "optional custom id (auto-generated if omitted)" },
        meta: { type: "object", description: "optional metadata (e.g. {file: 'src/foo.ts', tool: 'git'})" },
      },
      required: ["type", "label"],
    },
  },
  {
    name: "atlas_graph_add_link",
    description:
      "Create a relationship between two existing nodes. Use to connect entities — e.g. a file relates to a decision, a task depends on a concept.",
    input: {
      type: "object",
      properties: {
        source: { type: "string", description: "source node id" },
        target: { type: "string", description: "target node id" },
        relation: { type: "string", description: "relation type: relates, depends, conflicts, derives, observes, activates, edits, imports" },
      },
      required: ["source", "target", "relation"],
    },
  },
  {
    name: "atlas_graph_remove_node",
    description:
      "Remove a node and all its links from the graph. Use to clean up stale or incorrect entries.",
    input: {
      type: "object",
      properties: {
        id: { type: "string", description: "node id to remove" },
      },
      required: ["id"],
    },
  },
  {
    name: "atlas_graph_log_error",
    description:
      "Log an error node to the graph for tracking. Optionally link it to a file and/or tool. Use when you encounter errors worth remembering.",
    input: {
      type: "object",
      properties: {
        message: { type: "string", description: "error message or code" },
        file: { type: "string", description: "optional file path where error occurred" },
        tool: { type: "string", description: "optional tool that produced the error" },
      },
      required: ["message"],
    },
  },
];

export async function executeTool(name: string, args: Record<string, unknown>, port: number = 4819): Promise<string> {
  return callMcp(name, args, port);
}
