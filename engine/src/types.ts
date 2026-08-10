export type StepKind =
  | "task"
  | "plan"
  | "hypothesis"
  | "action"
  | "blocker"
  | "decision"
  | "error"
  | "root_cause"
  | "fix"
  | "verification"
  | "insight"
  | "lesson";

export type Role = "user" | "assistant" | "tool" | "system";

export type Relation =
  | "CAUSED_BY"
  | "FIXES"
  | "BASED_ON"
  | "SIMILAR_TO"
  | "CONTRADICTS"
  | "EXTENDS"
  | "REFINES"
  | "SHARES_FILE";

export type Origin = "auto" | "file" | "agent" | "recall";

export interface SessionRow {
  id: string;
  projectId: string;
  projectLabel: string;
  agent: string | null;
  model: string | null;
  title: string | null;
  summary: string | null;
  startedAt: number;
  endedAt: number | null;
  source: string | null;
}

export interface NewStep {
  sessionId: string;
  messageId?: string | null;
  parentId?: string | null;
  kind: StepKind;
  role: Role;
  content?: string | null;
  context?: string | null;
  outcome?: string | null;
  meta?: Record<string, unknown> | null;
  /** Stable source event id used for idempotent replay (INSERT OR IGNORE). */
  sourceId?: string | null;
}

export interface Step extends NewStep {
  id: string;
  seq: number;
  createdAt: number;
  messageId: string | null;
  parentId: string | null;
  content: string | null;
  context: string | null;
  outcome: string | null;
  meta: Record<string, unknown> | null;
}

export interface StepPayload {
  id: number;
  stepId: string;
  kind: string;
  data: string;
}

export interface StepFile {
  id: number;
  stepId: string;
  path: string;
  kind: "target" | "read" | "mention";
}

export interface StepLink {
  id: number;
  sourceStepId: string;
  targetStepId: string;
  relation: Relation;
  confidence: number;
  origin: Origin;
  meta: Record<string, unknown> | null;
  createdAt: number;
}

export interface NewStepLink {
  sourceStepId: string;
  targetStepId: string;
  relation: Relation;
  confidence?: number;
  origin: Origin;
  meta?: Record<string, unknown> | null;
}

export interface FileRefInput {
  text?: string | null;
  filePath?: string | null;
  diff?: string | null;
  args?: unknown;
}

export interface GraphNode {
  id: string;
  type: "step" | "file";
  label: string;
  kind?: StepKind | null;
  degree: number;
  meta?: Record<string, unknown> | null;
}

export interface GraphLink {
  id: string;
  source: string;
  target: string;
  relation: Relation;
  origin: Origin;
  label?: string | null;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface RecallChain {
  query: string;
  anchorStepId: string | null;
  steps: Step[];
  files: string[];
  rootCauses: Step[];
  lessons: Step[];
  outcome: string | null;
  score: number;
}

export interface HabitSignal {
  sessionId: string;
  title: string | null;
  stepCount: number;
  toolCount: number;
  toolCounts: Record<string, number>;
  errorCount: number;
  retryCount: number;
  reworkFiles: string[];
  topFiles: string[];
  testsRun: string[];
  lintsRun: string[];
  buildsRun: string[];
  durationMs: number;
  reasoningChars: number;
  errorRate: number;
}

export interface HabitAggregate {
  stepCount: number;
  toolCount: number;
  errorCount: number;
  errorRate: number;
  topTools: Array<[string, number]>;
  topFiles: Array<[string, number]>;
  reworkFiles: string[];
  testsRun: string[];
  flags: string[];
}

export interface HabitReport {
  scope: "project" | "general";
  projectId?: string | null;
  sessionCount: number;
  signals: HabitSignal[];
  aggregate: HabitAggregate;
}
