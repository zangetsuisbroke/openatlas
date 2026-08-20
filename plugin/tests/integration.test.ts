// Plugin integration tests
// Tests the Atlas MCP tools via HTTP against a running server

const PORT = process.env.ATLAS_PORT || 4819;
const BASE = `http://127.0.0.1:${PORT}`;

interface McpResponse {
  jsonrpc: string;
  id: number;
  result?: { content?: { text: string }[]; tools?: any[] };
  error?: { code: number; message: string };
}

async function callMcp(method: string, params: any): Promise<McpResponse> {
  const resp = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return resp.json();
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await callMcp("tools/call", { name, arguments: args });
  if (res.error) throw new Error(res.error.message);
  return res.result?.content?.map((c) => c.text).join("\n") ?? "";
}

// ---------- tests ----------
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

async function testToolsList() {
  console.log("\n[tools/list]");
  const res = await callMcp("tools/list", {});
  const tools = res.result?.tools ?? [];
  assert(tools.length === 8, `expected 8 tools, got ${tools.length}`);

  const names = tools.map((t: any) => t.name).sort();
  const expected = [
    "atlas_graph_add_link",
    "atlas_graph_add_node",
    "atlas_graph_log_error",
    "atlas_graph_path",
    "atlas_graph_query",
    "atlas_graph_remove_node",
    "atlas_graph_search",
    "atlas_graph_snapshot",
  ];
  assert(JSON.stringify(names) === JSON.stringify(expected), "all 8 tool names present");
}

async function testSearch() {
  console.log("\n[atlas_graph_search]");
  const result = await callTool("atlas_graph_search", { query: "auth", limit: 5 });
  assert(result.includes("c:auth"), "found auth concept");
  assert(!result.includes("no graph nodes match"), "has results");
}

async function testSnapshot() {
  console.log("\n[atlas_graph_snapshot]");
  const result = await callTool("atlas_graph_snapshot", { limit: 5 });
  assert(result.includes("nodes"), "has node count");
  assert(result.includes("links"), "has link count");
}

async function testQuery() {
  console.log("\n[atlas_graph_query]");
  const result = await callTool("atlas_graph_query", { node: "c:auth", depth: 1 });
  assert(result.includes("c:auth"), "query root present");
  assert(result.includes("depth 1"), "shows depth");
}

async function testPath() {
  console.log("\n[atlas_graph_path]");
  const result = await callTool("atlas_graph_path", {
    from: "c:auth",
    to: "c:jwt",
  });
  assert(result.includes("→"), "path has arrows");
}

async function testAddNode() {
  console.log("\n[atlas_graph_add_node]");
  const result = await callTool("atlas_graph_add_node", {
    type: "decision",
    label: "test decision node",
    id: "d:test-plugin-integration",
  });
  assert(result.includes("created"), "node created");
  assert(result.includes("d:test-plugin-integration"), "correct id");

  // verify it exists
  const search = await callTool("atlas_graph_search", { query: "test decision node" });
  assert(search.includes("d:test-plugin-integration"), "node searchable after creation");
}

async function testAddLink() {
  console.log("\n[atlas_graph_add_link]");
  const result = await callTool("atlas_graph_add_link", {
    source: "d:test-plugin-integration",
    target: "c:auth",
    relation: "relates",
  });
  assert(result.includes("linked"), "link created");

  // small delay for graph update
  await new Promise((r) => setTimeout(r, 100));

  // verify via query
  const query = await callTool("atlas_graph_query", {
    node: "d:test-plugin-integration",
    depth: 1,
  });
  assert(query.includes("Authentication") || query.includes("c:auth"), "link visible in query");
}

async function testLogError() {
  console.log("\n[atlas_graph_log_error]");
  const result = await callTool("atlas_graph_log_error", {
    message: "test error for integration",
    file: "test.ts",
    tool: "bun",
  });
  assert(result.includes("logged error"), "error logged");

  // verify it exists
  const search = await callTool("atlas_graph_search", { query: "test error for integration" });
  assert(search.includes("e:test_error_for_integration"), "error node searchable");
}

async function testRemoveNode() {
  console.log("\n[atlas_graph_remove_node]");
  const result = await callTool("atlas_graph_remove_node", {
    id: "d:test-plugin-integration",
  });
  assert(result.includes("removed"), "node removed");

  // verify it's gone
  const search = await callTool("atlas_graph_search", { query: "test decision node" });
  assert(search.includes("no graph nodes match"), "node gone after removal");
}

// ---------- run ----------
async function main() {
  console.log(`Atlas Plugin Integration Tests (port ${PORT})`);

  // check server is running
  try {
    await callMcp("ping", {});
  } catch {
    console.error(`\nAtlas server not running on port ${PORT}. Start it first.`);
    process.exit(1);
  }

  await testToolsList();
  await testSearch();
  await testSnapshot();
  await testQuery();
  await testPath();
  await testAddNode();
  await testAddLink();
  await testLogError();
  await testRemoveNode();

  // cleanup error node
  await callTool("atlas_graph_remove_node", { id: "e:test_error_for_integration" });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner failed:", e);
  process.exit(1);
});
