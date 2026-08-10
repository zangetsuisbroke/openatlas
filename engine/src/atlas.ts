import * as path from "node:path";
import { Ledger, archivePathFor, generalMemoryPath, logsDir } from "./ledger";
import { LogStore } from "./logstore";
import { Capturer } from "./capture";
import { Recall } from "./recall";
import { buildReport } from "./habits";
import { debugLog } from "./debug";
import type { HabitReport } from "./types";

export interface Atlas {
  projectDir: string;
  archive: Ledger;
  general: Ledger;
  logs: LogStore;
  recall: Recall;
  capturer: Capturer;
  habits: {
    project(): HabitReport;
    general(): HabitReport;
  };
}

const DISTILL_KINDS = new Set(["error", "root_cause", "lesson", "decision", "fix", "insight"]);

export function openAtlas(projectDir: string, opts: { agent?: string | null; model?: string | null; source?: string | null } = {}): Atlas {
  const resolved = path.resolve(projectDir);
  const archive = new Ledger(archivePathFor(resolved), { root: resolved, label: path.basename(resolved) });
  const general = new Ledger(generalMemoryPath());
  const logs = new LogStore(logsDir());
  const capturer = new Capturer(archive, { logstore: logs, ctx: { agent: opts.agent, model: opts.model, source: opts.source } });
  const recall = new Recall(archive);
  return {
    projectDir: resolved,
    archive,
    general,
    logs,
    recall,
    capturer,
    habits: {
      project: () => buildReport(archive, "project", archive.projectId),
      general: () => buildReport(general, "general", null),
    },
  };
}

export function finalizeSession(atlas: Atlas, sessionId: string): void {
  atlas.capturer.finalizeSession(sessionId);
  const steps = atlas.archive.listSteps(sessionId);
  const distilled = steps.filter((s) => DISTILL_KINDS.has(s.kind));
  const done = Number(atlas.general.getMeta(`distilled:${sessionId}`) ?? 0);
  const fresh = done > 0 ? distilled.slice(done) : distilled;
  debugLog("atlas.distill", `session=${sessionId} kinds=${distilled.length} fresh=${fresh.length}`);
  for (const s of fresh) {
    atlas.general.addStep({
      sessionId: s.sessionId,
      messageId: s.messageId,
      parentId: null,
      kind: s.kind,
      role: s.role,
      content: s.content,
      context: s.context,
      outcome: s.outcome,
      meta: { ...(s.meta ?? {}), sourceProject: atlas.archive.projectId },
    });
  }
  if (done === 0 && distilled.length > 0) {
    const arch = atlas.archive.getSession(sessionId);
    if (arch) {
      atlas.general.createSession({
        id: sessionId,
        agent: arch.agent,
        model: arch.model,
        title: arch.title,
        source: "distilled",
      });
      atlas.general.finishSession(sessionId, { title: arch.title, summary: arch.summary });
    }
  }
  atlas.general.setMeta(`distilled:${sessionId}`, distilled.length.toString());
}
