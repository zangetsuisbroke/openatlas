// Auto-writes the isolated opencode config so the graph MCP + skill are
// pre-configured in every build — the user only has to sign in to their provider.
// Writes into the config dir that appEnv() points OPENCODE_CONFIG_DIR at.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log";
import { appRoot } from "./shell";

function configDir(): string {
  const iso = join(appRoot(), ".atlas", "opencode-config");
  mkdirSync(iso, { recursive: true });
  return iso;
}

const SKILL_MD = `---
name: atlas-graph
description: When you need additional context about the workspace — its structure, what files/folders/packages exist, how things are connected (imports, dependencies, active tools and tasks) — use the atlas_graph_* MCP tools. Prefer this over guessing when you need to know how an entity relates to the rest of the project.
---

## What I do
- Expose the live Atlas knowledge graph: real files, folders, packages, imports, git branch, tools, concepts, decisions, tasks, memories and errors that have been observed.
- The graph is maintained live: workspace scans plus every command run in the terminal.

## When to use me
Use me whenever you need broader project context that isn't obvious from the files you've already read:
- "which files import this module?" -> \`atlas_graph_query\` on the file node
- "what exists in this project?" -> \`atlas_graph_snapshot\` or \`atlas_graph_search\`
- "how is X related to Y?" -> \`atlas_graph_path\`
- "find the node for a file/package/tool" -> \`atlas_graph_search\`

## How to use
1. Start with \`atlas_graph_search\` (or \`atlas_graph_snapshot\`) to locate node ids.
2. Expand with \`atlas_graph_query <node> depth=1..2\` to see relationships.
3. Use \`atlas_graph_path\` to trace indirect connections between two entities.
Keep limits modest (search <= 20, query depth 1-2) to stay token-efficient.
`;

const OPENCODE_JSON = (port: number): string =>
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        atlas: {
          type: "remote",
          url: `http://127.0.0.1:${port}/api/mcp`,
          enabled: true,
          timeout: 15000,
        },
      },
    },
    null,
    2
  );

export function ensureConfig(port: number): void {
  try {
    const dir = configDir();
    const skillsDir = join(dir, "skills", "atlas-graph");
    mkdirSync(skillsDir, { recursive: true });

    const jsonPath = join(dir, "opencode.json");
    writeFileSync(jsonPath, OPENCODE_JSON(port));
    log.info("serve", `wrote ${jsonPath}`);

    const skillPath = join(skillsDir, "SKILL.md");
    if (!existsSync(skillPath)) {
      writeFileSync(skillPath, SKILL_MD);
      log.info("serve", `wrote ${skillPath}`);
    }
  } catch (e) {
    log.error("serve", `failed to write opencode config: ${String(e)}`);
  }
}
