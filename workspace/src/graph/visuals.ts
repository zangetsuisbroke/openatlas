import type { GNode, NodeType, Relation } from "../types";

export type ShapeKind =
  | "circle"
  | "square"
  | "box"
  | "diamond"
  | "hex"
  | "pill"
  | "triangle"
  | "tri-down";

export const NODE_STYLE: Record<NodeType, { color: string; shape: ShapeKind }> = {
  file: { color: "#6f9df1", shape: "pill" },
  folder: { color: "#8b929d", shape: "box" },
  branch: { color: "#d9b268", shape: "pill" },
  package: { color: "#8adfd7", shape: "hex" },
  concept: { color: "#6cc8e0", shape: "circle" },
  decision: { color: "#a892e0", shape: "diamond" },
  agent: { color: "#d62f22", shape: "hex" },
  task: { color: "#d9b268", shape: "pill" },
  tool: { color: "#93c76a", shape: "triangle" },
  memory: { color: "#8adfd7", shape: "circle" },
  error: { color: "#e0788c", shape: "tri-down" },
  event: { color: "#6f9df1", shape: "circle" },
};

export const LINK_STYLE: Record<Relation, string> = {
  derives: "#d62f22",
  relates: "#4d5560",
  conflicts: "#e0788c",
  activates: "#a892e0",
  edits: "#6f9df1",
  observes: "#4d5560",
  depends: "#d9b268",
  contains: "#4d5560",
  imports: "#6f9df1",
};

export const TYPE_ORDER: NodeType[] = ["file", "folder", "branch", "package", "concept", "decision", "agent", "task", "tool", "memory", "error", "event"];

export function nodeColor(type: NodeType): string {
  return NODE_STYLE[type]?.color ?? "#8b929d";
}

export function nodeRadius(node: GNode, hovered: boolean): number {
  const base = 3.5 + Math.min(node.val ?? 1, 4) * 2.4;
  return base * (hovered ? 1.18 : 1);
}

export function drawShape(ctx: CanvasRenderingContext2D, shape: ShapeKind, x: number, y: number, r: number): void {
  ctx.beginPath();
  switch (shape) {
    case "square":
      ctx.rect(x - r * 0.75, y - r * 0.75, r * 1.5, r * 1.5);
      break;
    case "box":
      ctx.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
      break;
    case "diamond":
      ctx.moveTo(x, y - r * 1.1);
      ctx.lineTo(x + r * 1.1, y);
      ctx.lineTo(x, y + r * 1.1);
      ctx.lineTo(x - r * 1.1, y);
      ctx.closePath();
      break;
    case "hex":
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        const px = x + Math.cos(a) * r * 1.05;
        const py = y + Math.sin(a) * r * 1.05;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    case "pill":
      ctx.roundRect(x - r, y - r * 0.62, r * 2, r * 1.24, r * 0.62);
      break;
    case "triangle":
      ctx.moveTo(x, y - r * 1.1);
      ctx.lineTo(x + r * 1.1, y + r * 0.9);
      ctx.lineTo(x - r * 1.1, y + r * 0.9);
      ctx.closePath();
      break;
    case "tri-down":
      ctx.moveTo(x, y + r * 1.1);
      ctx.lineTo(x + r * 1.1, y - r * 0.9);
      ctx.lineTo(x - r * 1.1, y - r * 0.9);
      ctx.closePath();
      break;
    default:
      ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}
