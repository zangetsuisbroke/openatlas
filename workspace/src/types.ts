export type NodeType =
  | "file"
  | "concept"
  | "decision"
  | "agent"
  | "task"
  | "tool"
  | "memory"
  | "error"
  | "event";

export type Relation =
  | "derives"
  | "relates"
  | "conflicts"
  | "activates"
  | "edits"
  | "observes"
  | "depends";

export interface GNode {
  id: string;
  label: string;
  type: NodeType;
  val: number;
  created: number;
  lastActive: number;
}

export interface GLink {
  source: string;
  target: string;
  relation: Relation;
  strength: number;
}

export type EventChannel = "agent" | "tool" | "file" | "system" | "memory";
export type EventStatus = "ok" | "fail" | "run" | "info";

export interface StreamEvent {
  id: string;
  at: number;
  channel: EventChannel;
  kind: string;
  subject: string;
  meta?: string;
  status: EventStatus;
  nodeId?: string;
  terminal?: string;
}

export type ServerMsg =
  | { type: "hello"; data: { nodes: GNode[]; links: GLink[] } }
  | { type: "event"; data: StreamEvent }
  | { type: "graph"; data: { nodes: GNode[]; links: GLink[] } }
  | { type: "pulse"; data: { nodeId: string; at: number } }
  | { type: "term:create"; data: { id: string; shell: string; title: string } }
  | { type: "term:exit"; data: { id: string } }
  | { type: "term:data"; data: { id: string; data: string } };

export type ClientMsg =
  | { type: "term:input"; id: string; data: string }
  | { type: "term:resize"; id: string; cols: number; rows: number }
  | { type: "term:create"; shell?: string }
  | { type: "term:kill"; id: string }
  | { type: "graph:reset" }
  | { type: "demo:run" }
  | { type: "ping" };
