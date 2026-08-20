// OpenCode Atlas Plugin
// Registers the Atlas knowledge graph as native OpenCode tools.
// Auto-starts Atlas server if not running.

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { spawn, exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TOOLS, executeTool } from "./tools.js";
import type { Plugin } from "@opencode-ai/plugin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load bundled skill markdown
const SKILL_MD = readFileSync(join(__dirname, "skill.md"), "utf8");

// Parse frontmatter from skill markdown
function parseSkill(md: string): { name: string; description: string; content: string } {
  const match = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { name: "atlas-graph", description: "", content: md };
  const front = match[1];
  const body = match[2];
  const name = front.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "atlas-graph";
  const description = front.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
  return { name, description, content: body };
}

const skill = parseSkill(SKILL_MD);

// Atlas server management
let atlasProcess: ReturnType<typeof spawn> | null = null;
let atlasStartedByPlugin = false;

async function findAtlasExecutable(): Promise<string | null> {
  // Check common locations
  const locations = [
    join(__dirname, "..", "..", "atlas-workspace.exe"), // sibling to plugin
    join(__dirname, "..", "atlas-workspace.exe"), // parent dir
    "C:\\Program Files\\Atlas\\atlas-workspace.exe",
    "C:\\Program Files (x86)\\Atlas\\atlas-workspace.exe",
  ];
  
  for (const loc of locations) {
    if (existsSync(loc)) return loc;
  }
  
  // Try PATH
  return new Promise((resolve) => {
    exec("where atlas-workspace.exe", (err, stdout) => {
      if (err || !stdout.trim()) resolve(null);
      else resolve(stdout.trim().split("\n")[0]);
    });
  });
}

async function isAtlasRunning(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function startAtlas(port: number): Promise<void> {
  if (await isAtlasRunning(port)) {
    console.log(`[atlas-plugin] Atlas already running on port ${port}`);
    return;
  }
  
  const exe = await findAtlasExecutable();
  if (!exe) {
    console.warn(`[atlas-plugin] atlas-workspace.exe not found — start Atlas manually`);
    return;
  }
  
  console.log(`[atlas-plugin] Starting Atlas from ${exe}`);
  atlasProcess = spawn(exe, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PORT: String(port) },
  });
  atlasStartedByPlugin = true;
  
  atlasProcess.on("error", (err) => {
    console.error(`[atlas-plugin] Atlas spawn error:`, err);
    atlasProcess = null;
  });
  
  atlasProcess.on("exit", (code) => {
    console.log(`[atlas-plugin] Atlas exited with code ${code}`);
    atlasProcess = null;
  });
  
  // Wait for server to be ready
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isAtlasRunning(port)) {
      console.log(`[atlas-plugin] Atlas ready on port ${port}`);
      return;
    }
  }
  console.warn(`[atlas-plugin] Atlas started but not responding on port ${port}`);
}

async function stopAtlas(): Promise<void> {
  if (atlasProcess && atlasStartedByPlugin) {
    console.log(`[atlas-plugin] Stopping Atlas (PID ${atlasProcess.pid})`);
    atlasProcess.kill();
    atlasProcess = null;
    atlasStartedByPlugin = false;
  }
}

// Plugin entry — registers tools and skill with OpenCode
export const server: Plugin = async (input, options) => {
  const port = options?.port ?? 4819;

  // Auto-start Atlas if configured
  if (options?.autoStart !== false) {
    await startAtlas(port);
  }

  // Helper to call MCP tools from hooks
  async function callAtlas(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      const result = await executeTool(name, args, port);
      return result;
    } catch {
      return "";
    }
  }

  return {
    // Register tools
    tool: Object.fromEntries(
      TOOLS.map((t) => [
        t.name,
        {
          description: t.description,
          parameters: t.input,
          execute: async (args) => {
            try {
              const result = await executeTool(t.name, args, port);
              return { title: t.name, output: result };
            } catch (e) {
              return {
                title: t.name,
                output: `Atlas error: ${String(e)}\n\nIs the Atlas server running on port ${port}?`,
                metadata: { error: true },
              };
            }
          },
        },
      ])
    ),

    // Auto-log errors and track tool usage
    "tool.execute.after": async (input, output) => {
      const { tool, sessionID } = input;
      const { output: result, metadata } = output;

      // Skip atlas's own tools to avoid infinite loops
      if (tool.startsWith("atlas_graph_")) return;

      // Auto-log errors
      if (metadata?.error || result?.includes("error") || result?.includes("Error")) {
        const errorMsg = `tool:${tool} failed in session ${sessionID.slice(0, 8)}`;
        await callAtlas("atlas_graph_add_node", {
          type: "error",
          label: errorMsg,
          meta: { tool, session: sessionID },
        });
      }

      // Track file modifications
      if (tool === "write" || tool === "edit") {
        const fileMatch = result?.match(/wrote\s+(\S+)/i) || result?.match(/edited\s+(\S+)/i);
        if (fileMatch) {
          await callAtlas("atlas_graph_add_node", {
            type: "concept",
            label: fileMatch[1],
            id: `w:${fileMatch[1]}`,
            meta: { tool, session: sessionID },
          });
        }
      }

      // Track command executions
      if (tool === "bash" || tool === "terminal") {
        const cmd = input.args?.command || input.args?.cmd || "";
        if (cmd) {
          await callAtlas("atlas_graph_add_node", {
            type: "tool",
            label: String(cmd).split(" ")[0],
            meta: { command: String(cmd).slice(0, 200), session: sessionID },
          });
        }
      }
    },

    // Inject skill via config hook
    config: async (config) => {
      config.skills = config.skills ?? [];
      config.skills.push({
        name: skill.name,
        description: skill.description,
        content: skill.content,
      });
    },

    // Cleanup — stop Atlas if we started it
    dispose: async () => {
      await stopAtlas();
    },
  };
};
