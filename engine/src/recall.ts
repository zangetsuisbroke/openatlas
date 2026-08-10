import * as path from "node:path";
import type { Step, StepKind, RecallChain } from "./types";
import type { Ledger } from "./ledger";

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "for", "to", "of", "in", "on", "with", "at", "by",
  "is", "are", "was", "were", "be", "been", "being", "it", "this", "that", "these", "those",
  "i", "we", "you", "he", "she", "they", "me", "us", "them", "my", "our", "your", "their",
  "not", "no", "yes", "so", "if", "then", "else", "when", "how", "what", "which", "who",
  "there", "here", "as", "from", "about", "than", "too", "very", "can", "could", "will",
  "would", "should", "may", "might", "must", "do", "does", "did", "have", "has", "had",
  "let", "us", "just", "need", "want", "try", "make", "get", "one", "two", "also", "like",
]);

function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const m of s.toLowerCase().matchAll(/[a-z0-9_]+/g)) {
    const t = m[0];
    if (t.length > 1 && !STOP.has(t)) out.push(t);
  }
  return out;
}

export function wordOverlap(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const setB = new Set(tb);
  let hit = 0;
  for (const t of ta) if (setB.has(t)) hit++;
  return hit / Math.sqrt(ta.length * tb.length);
}

const WALK_RELATIONS = new Set(["CAUSED_BY", "FIXES", "BASED_ON", "SIMILAR_TO", "EXTENDS", "REFINES", "CONTRADICTS"]);
const RELATION_WEIGHT: Record<string, number> = {
  CAUSED_BY: 2.0,
  FIXES: 1.8,
  BASED_ON: 1.5,
  REFINES: 1.3,
  SIMILAR_TO: 1.2,
  CONTRADICTS: 1.0,
  EXTENDS: 0.5,
};
const MAX_CHAIN = 80;

export class Recall {
  constructor(private ledger: Ledger) {}

  query(opts: { q?: string | null; file?: string | null; projectId?: string | null; k?: number; scope?: "project" | "general" }): RecallChain[] {
    const rawK = opts.k ?? 8;
    const k = Number.isFinite(rawK) ? Math.max(1, Math.min(50, Math.floor(rawK))) : 8;
    const seeds: Array<{ stepId: string; score: number }> = [];

    if (opts.file) {
      const fileRefs = this.ledger.listFilesByPath(opts.file);
      for (const fr of fileRefs) {
        if (this.inScope(fr.stepId, opts.projectId)) seeds.push({ stepId: fr.stepId, score: 2 });
      }
    }
    if (opts.q) {
      const steps = this.allStepsInScope(opts.projectId);
      const scored = steps
        .map((s) => {
          const text = `${s.content ?? ""} ${s.context ?? ""} ${s.outcome ?? ""}`;
          return { stepId: s.id, score: wordOverlap(opts.q ?? "", text) };
        })
        .filter((x) => x.score > 0.15);
      seeds.push(...scored);
    }

    const byId = new Map<string, number>();
    for (const s of seeds) {
      byId.set(s.stepId, Math.max(byId.get(s.stepId) ?? 0, s.score));
    }

    const seen = new Set<string>();
    const chains: RecallChain[] = [];
    const query = opts.q ?? opts.file ?? "";
    for (const [anchor, score] of byId) {
      if (seen.has(anchor)) continue;
      const chain = this.walk(anchor, score, query, seen);
      if (chain.steps.length > 0) chains.push(chain);
      if (chains.length >= k) break;
    }
    chains.sort((a, b) => b.score - a.score);
    return chains.slice(0, k);
  }

  private inScope(stepId: string, projectId?: string | null): boolean {
    if (!projectId) return true;
    const step = this.ledger.getStep(stepId);
    if (!step) return false;
    const session = this.ledger.getSession(step.sessionId);
    return session ? session.projectId === projectId : true;
  }

  private allStepsInScope(projectId?: string | null): Step[] {
    if (!projectId) return this.allSteps();
    const sessions = this.ledger.listSessions(projectId);
    const out: Step[] = [];
    for (const s of sessions) out.push(...this.ledger.listSteps(s.id));
    return out;
  }

  private allSteps(): Step[] {
    const sessions = this.ledger.listSessions();
    const out: Step[] = [];
    for (const s of sessions) out.push(...this.ledger.listSteps(s.id));
    return out;
  }

  private walk(anchor: string, score: number, query: string, seen: Set<string>): RecallChain {
    const visited = new Set<string>();
    const queue: string[] = [anchor];
    while (queue.length > 0 && visited.size < MAX_CHAIN) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const neighbors: Array<{ id: string; weight: number }> = [];
      for (const link of this.ledger.getLinks(id)) {
        if (!WALK_RELATIONS.has(link.relation)) continue;
        const next = link.sourceStepId === id ? link.targetStepId : link.sourceStepId;
        neighbors.push({ id: next, weight: RELATION_WEIGHT[link.relation] ?? 1 });
      }
      const step = this.ledger.getStep(id);
      if (step?.parentId) neighbors.push({ id: step.parentId, weight: 0.6 });
      for (const c of this.ledger.listChildren(id)) neighbors.push({ id: c.id, weight: 0.6 });
      neighbors.sort((a, b) => b.weight - a.weight);
      for (const n of neighbors) if (!visited.has(n.id)) queue.push(n.id);
    }
    for (const id of visited) seen.add(id);
    const steps: Step[] = [];
    for (const id of visited) {
      const s = this.ledger.getStep(id);
      if (s) steps.push(s);
    }
    steps.sort((a, b) => a.seq - b.seq);
    const files = new Set<string>();
    for (const s of steps) for (const f of this.ledger.listFiles(s.id)) files.add(f.path);
    const rootCauses = steps.filter((s) => s.kind === "root_cause");
    const lessons = steps.filter((s) => s.kind === "lesson");
    const outcomeStep = [...steps].reverse().find((s) => ["verification", "fix", "insight"].includes(s.kind));
    return {
      query,
      anchorStepId: anchor,
      steps,
      files: [...files],
      rootCauses,
      lessons,
      outcome: outcomeStep?.content ?? null,
      score,
    };
  }
}
