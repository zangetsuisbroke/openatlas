import * as fs from "node:fs";
import type { Plugin, PluginModule, Hooks, ToolDefinition } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import {
  openAtlas,
  finalizeSession,
  Recall,
  debugLog,
  logError,
  RELATIONS,
  type Atlas,
  type RecallChain,
  type Step,
  type StepKind,
  type Relation,
} from "openatlas-engine";

const KINDS: StepKind[] = [
  "task",
  "plan",
  "hypothesis",
  "action",
  "blocker",
  "decision",
  "error",
  "root_cause",
  "fix",
  "verification",
  "insight",
  "lesson",
];
const KIND_SET = new Set<string>(KINDS);
const RELATION_SET = new Set<string>(RELATIONS);

let atlas: Atlas | null = null;
let projectDir: string = process.cwd();

function resolveProjectDir(directory?: string, worktree?: string): string {
  for (const candidate of [directory, worktree]) {
    if (!candidate) continue;
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  console.warn(`openatlas: no valid project directory (${JSON.stringify({ directory, worktree })}); falling back to ${process.cwd()}`);
  return process.cwd();
}

function getAtlas(): Atlas {
  if (!atlas) atlas = openAtlas(projectDir, { source: "opencode" });
  return atlas;
}

function sessionIdOf(ev: unknown): string | undefined {
  const e = ev as { data?: Record<string, unknown>; properties?: Record<string, unknown> };
  const raw = e.data?.sessionID ?? e.properties?.sessionID;
  return typeof raw === "string" ? raw : undefined;
}

function trim(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
}

function formatChains(chains: RecallChain[]): string {
  if (chains.length === 0) return "No matching memory found in openatlas.";
  const out: string[] = [];
  for (const chain of chains) {
    out.push(`## chain (score ${chain.score.toFixed(3)}${chain.query ? ` · query "${trim(chain.query, 80)}"` : ""})`);
    for (const s of chain.steps) {
      out.push(`  [${s.seq} ${s.kind}] ${trim(s.content ?? "", 200) || "(no content)"}`);
    }
    if (chain.files.length) out.push(`  files: ${chain.files.join(", ")}`);
    if (chain.rootCauses.length) out.push(`  root causes: ${chain.rootCauses.map((s) => trim(s.content ?? "", 140)).join(" | ")}`);
    if (chain.lessons.length) out.push(`  lessons: ${chain.lessons.map((s) => trim(s.content ?? "", 140)).join(" | ")}`);
    if (chain.outcome) out.push(`  outcome: ${trim(chain.outcome, 200)}`);
  }
  return out.join("\n");
}

function topFilesFor(a: Atlas, steps: Step[]): string[] {
  const counts = new Map<string, number>();
  for (const s of steps) {
    for (const f of a.archive.listFiles(s.id)) {
      if (f.kind !== "target") continue;
      counts.set(f.path, (counts.get(f.path) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([f]) => f);
}

const atlas_commit: ToolDefinition = tool({
  description:
    "Explicitly label/commit the current reasoning step into openatlas memory with a semantic kind, and optionally link it to other steps. Use when the in-progress step is a durable decision, fix, blocker, root cause, lesson, or insight worth recording.",
  args: {
    kind: tool.schema.string().optional().describe(`Kind to label the step as. One of: ${KINDS.join(", ")}.`),
    summary: tool.schema.string().optional().describe("Optional replacement content for the step (defaults to the step's existing content)."),
    link_to: tool.schema.array(tool.schema.string()).optional().describe("Step ids to link from this step to (e.g. the id of the step this fixes)."),
    relation: tool.schema.string().optional().describe(`Relation for the links (default "FIXES"). One of: ${RELATIONS.join(", ")}.`),
  },
  async execute(args, ctx) {
    const a = getAtlas();
    const sessionID = ctx.sessionID;
    if (!sessionID) return "No session context; cannot locate a step to commit.";
    const steps = a.archive.listSteps(sessionID);
    if (steps.length === 0) return "No reasoning steps recorded in this session yet; nothing to commit.";
    const current =
      [...steps].reverse().find((s) => ctx.messageID && s.messageId === ctx.messageID) ?? steps[steps.length - 1]!;
    if (args.kind && !KIND_SET.has(args.kind)) {
      return `Invalid kind "${args.kind}". Allowed kinds: ${KINDS.join(", ")}.`;
    }
    const relation = args.relation ?? "FIXES";
    if (!RELATION_SET.has(relation)) {
      return `Invalid relation "${relation}". Allowed relations: ${RELATIONS.join(", ")}.`;
    }
    a.archive.updateStep(current.id, {
      kind: (args.kind as StepKind) ?? current.kind,
      content: args.summary ?? current.content,
      meta: { ...(current.meta ?? {}), committed: true },
    });
    let linked = 0;
    const missing: string[] = [];
    for (const targetId of args.link_to ?? []) {
      if (!a.archive.getStep(targetId)) {
        missing.push(targetId);
        continue;
      }
      a.archive.link({
        sourceStepId: current.id,
        targetStepId: targetId,
        relation: relation as Relation,
        origin: "agent",
      });
      linked++;
    }
    const bits = [`Committed step ${current.id} (seq ${current.seq}) as ${args.kind ?? current.kind}.`];
    if (linked) bits.push(`${linked} link(s) created (${relation}).`);
    if (missing.length) bits.push(`Skipped missing targets: ${missing.join(", ")}.`);
    return bits.join(" ");
  },
});

const atlas_recall: ToolDefinition = tool({
  description:
    "Search openatlas memory (persisted past reasoning chains) for content relevant to a query or file. Returns scored chains of steps with files touched, root causes, lessons, and outcomes.",
  args: {
    q: tool.schema.string().optional().describe("Free-text query; matched by word overlap against past step content."),
    file: tool.schema.string().optional().describe("A file path (relative to the project) to find memory that touched that file."),
    k: tool.schema.number().optional().describe("Maximum number of chains to return (default 8)."),
    scope: tool.schema.enum(["project", "general"]).optional().describe("Where to search: this project's archive (default) or cross-project general memory."),
  },
  async execute(args) {
    const a = getAtlas();
    const scope = args.scope ?? "project";
    const recall = scope === "general" ? new Recall(a.general) : a.recall;
    const chains = recall.query({
      q: args.q,
      file: args.file,
      k: args.k,
      projectId: scope === "project" ? a.archive.projectId : null,
    });
    return formatChains(chains);
  },
});

const atlas_habits: ToolDefinition = tool({
  description: "Return openatlas habit reports: aggregate signals about how you work (steps, tool calls, errors, rework files, tests run) on this project or across all projects.",
  args: {
    scope: tool.schema.enum(["project", "general"]).optional().describe("project = this repo only (default); general = cross-project."),
  },
  async execute(args) {
    const a = getAtlas();
    const scope = args.scope ?? "project";
    const report = scope === "general" ? a.habits.general() : a.habits.project();
    return JSON.stringify(report, null, 2);
  },
});

const atlas_logs: ToolDefinition = tool({
  description: "Read the raw opencode event transcript for a session (JSONL), or list all recorded session logs.",
  args: {
    session: tool.schema.string().optional().describe("Session id to read; omit to list available logs."),
  },
  async execute(args) {
    const a = getAtlas();
    if (args.session) {
      if (!a.logs.isSafeId(args.session)) return `Invalid session id: ${args.session}`;
      const text = a.logs.read(args.session);
      if (!text) return `No logs for session ${args.session}.`;
      return text.length > 8000 ? text.slice(-8000) : text;
    }
    const entries = a.logs.list();
    if (entries.length === 0) return "No session logs recorded yet.";
    return entries.map((e) => `${e.sessionId}\t${e.size} bytes\t${new Date(e.updatedAt).toISOString()}`).join("\n");
  },
});

const server: Plugin = async (input) => {
  const resolved = resolveProjectDir(input.directory, input.worktree);
  if (resolved !== projectDir && atlas) {
    try {
      atlas.archive.close();
      atlas.general.close();
    } catch {
      /* ignore close errors */
    }
    atlas = null;
  }
  projectDir = resolved;

  const hooks: Hooks = {
    event: async ({ event }) => {
      try {
        getAtlas().capturer.ingest(event);
        if (event.type === "session.idle") {
          const sid = sessionIdOf(event);
          if (sid) finalizeSession(getAtlas(), sid);
        }
      } catch (err) {
        logError("plugin.event", `type=${String((event as { type?: unknown })?.type ?? "?")} error=${String(err)}`);
        /* a harness must never break opencode */
      }
    },
    tool: {
      atlas_commit,
      atlas_recall,
      atlas_habits,
      atlas_logs,
    },
    "experimental.chat.system.transform": async (input, output) => {
      try {
        if (!input.sessionID) return;
        const a = getAtlas();
        const steps = a.archive.listSteps(input.sessionID);
        if (steps.length === 0) return;
        const task = [...steps].reverse().find((s) => s.role === "user" && !!s.content);
        if (!task) return;
        const chains = a.recall.query({ q: task.content, k: 3, projectId: a.archive.projectId });
        if (chains.length === 0) return;
        const lines: string[] = [];
        for (const chain of chains) {
          for (const s of chain.steps.slice(0, 4)) {
            if (!s.content) continue;
            lines.push(`- [${s.kind}] ${trim(s.content, 200)}`);
          }
        }
        if (lines.length === 0) return;
        const block = `\n\n[openatlas memory]\nBased on past reasoning, recall this before continuing:\n${lines.join("\n")}`;
        output.system.push(block.slice(0, 1500));
      } catch (err) {
        logError("plugin.recall-inject", `session=${String(input.sessionID ?? "?")} error=${String(err)}`);
        /* memory injection must never break opencode */
      }
    },
    "experimental.session.compacting": async (input, output) => {
      try {
        const a = getAtlas();
        const steps = a.archive.listSteps(input.sessionID);
        if (steps.length === 0) return;
        const signal = a.habits.project().signals.find((s) => s.sessionId === input.sessionID);
        const top = signal?.topFiles.length ? signal.topFiles : topFilesFor(a, steps);
        const bits = signal
          ? `${signal.stepCount} steps · ${signal.toolCount} tool calls · ${signal.errorCount} errors`
          : `${steps.length} steps captured`;
        const note = `[openatlas memory] ${bits}${top.length ? ` · files touched: ${top.join(", ")}` : ""}`;
        output.context.push(note.slice(0, 500));
      } catch {
        /* a harness must never break opencode */
      }
    },
    dispose: async () => {
      try {
        atlas?.archive.close();
        atlas?.general.close();
        atlas = null;
      } catch {
        /* ignore close errors */
      }
    },
  };
  return hooks;
};

const plugin: PluginModule = { id: "openatlas", server };

export default plugin;
