import type { Ledger } from "./ledger";
import type { HabitReport, HabitSignal, HabitAggregate, SessionRow, Step } from "./types";

const TEST_RE = /\b(bun test|npm test|npm run test|npm run test:|pytest|go test|cargo test|jest|vitest|deno test)\b/i;
const LINT_RE = /\b(bun run lint|npm run lint|eslint|tsc --noEmit|typecheck|ruff|golangci-lint)\b/i;
const BUILD_RE = /\b(bun build|npm run build|tsc\b|tsc -|cargo build|go build|vite build|next build|bunx tsc)\b/i;

function commandPatterns(steps: Step[]): { tests: string[]; lints: string[]; builds: string[] } {
  const tests: string[] = [];
  const lints: string[] = [];
  const builds: string[] = [];
  for (const s of steps) {
    const cmd = s.content ?? "";
    if (TEST_RE.test(cmd)) tests.push(cmd.slice(0, 160));
    if (LINT_RE.test(cmd)) lints.push(cmd.slice(0, 160));
    if (BUILD_RE.test(cmd) && !TEST_RE.test(cmd)) builds.push(cmd.slice(0, 160));
  }
  return { tests, lints, builds };
}

function computeSignal(session: SessionRow, steps: Step[], fileCounts: Map<string, number>): HabitSignal {
  const toolSteps = steps.filter((s) => s.role === "tool");
  const toolCounts: Record<string, number> = {};
  for (const s of toolSteps) {
    const tool = (s.meta?.tool as string) ?? s.content ?? "unknown";
    toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
  }
  const errorCount = steps.filter((s) => s.kind === "error").length;
  const reworkFiles = [...fileCounts.entries()].filter(([, n]) => n >= 3).map(([f]) => f);
  const topFiles = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f]) => f);
  const { tests, lints, builds } = commandPatterns(steps);
  const reasoningChars = steps.reduce((acc, s) => acc + (s.meta?.reasoningChars as number ?? 0), 0);
  return {
    sessionId: session.id,
    title: session.title,
    stepCount: steps.length,
    toolCount: toolSteps.length,
    toolCounts,
    errorCount,
    retryCount: 0,
    reworkFiles,
    topFiles,
    testsRun: tests,
    lintsRun: lints,
    buildsRun: builds,
    durationMs: session.endedAt ? session.endedAt - session.startedAt : 0,
    reasoningChars,
    errorRate: toolSteps.length > 0 ? errorCount / toolSteps.length : 0,
  };
}

function computeFileCounts(steps: Step[], ledger: Ledger): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of steps) {
    for (const f of ledger.listFiles(s.id)) {
      if (f.kind !== "target") continue;
      counts.set(f.path, (counts.get(f.path) ?? 0) + 1);
    }
  }
  return counts;
}

export function buildReport(ledger: Ledger, scope: "project" | "general", projectId?: string | null): HabitReport {
  const sessions = projectId ? ledger.listSessions(projectId) : ledger.listSessions();
  const signals: HabitSignal[] = [];
  for (const session of sessions) {
    const steps = ledger.listSteps(session.id);
    if (steps.length === 0) continue;
    const fileCounts = computeFileCounts(steps, ledger);
    signals.push(computeSignal(session, steps, fileCounts));
  }
  const aggregate = aggregateSignals(signals);
  return { scope, projectId: projectId ?? null, sessionCount: signals.length, signals, aggregate };
}

export function aggregateSignals(signals: HabitSignal[]): HabitAggregate {
  const stepCount = signals.reduce((a, s) => a + s.stepCount, 0);
  const toolCount = signals.reduce((a, s) => a + s.toolCount, 0);
  const errorCount = signals.reduce((a, s) => a + s.errorCount, 0);
  const toolMap = new Map<string, number>();
  for (const s of signals) for (const [t, n] of Object.entries(s.toolCounts)) toolMap.set(t, (toolMap.get(t) ?? 0) + n);
  const fileMap = new Map<string, number>();
  for (const s of signals) for (const f of s.topFiles) fileMap.set(f, (fileMap.get(f) ?? 0) + 1);
  const reworkFiles = [...new Set(signals.flatMap((s) => s.reworkFiles))];
  const testsRun = [...new Set(signals.flatMap((s) => s.testsRun))];
  const errorRate = Math.min(1, toolCount > 0 ? errorCount / toolCount : 0);
  const flags: string[] = [];
  if (reworkFiles.length > 0) flags.push(`rework:${reworkFiles.length} files edited 3+ times`);
  if (toolCount > 0 && testsRun.length === 0) flags.push("noTests:edited code without running tests");
  if (toolCount > 0 && errorRate > 0.3) flags.push(`highErrorRate:${(errorRate * 100).toFixed(0)}% of tool calls failed`);
  return {
    stepCount,
    toolCount,
    errorCount,
    errorRate,
    topTools: [...toolMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
    topFiles: [...fileMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
    reworkFiles,
    testsRun,
    flags,
  };
}
