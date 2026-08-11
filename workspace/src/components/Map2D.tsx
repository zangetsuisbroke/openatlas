import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
} from "d3-force";
import type { GLink, GNode } from "../types";
import { drawShape, LINK_STYLE, NODE_STYLE, nodeColor, nodeRadius, TYPE_ORDER } from "../graph/visuals";

export interface Map2DHandle {
  focusNode(id: string): void;
  fitView(ms?: number): void;
  zoom(dir: number): void;
}

interface Props {
  nodes: GNode[];
  links: GLink[];
  pulses: Map<string, number>;
  onSelect: (n: GNode | null) => void;
  onStats: (s: { nodes: number; links: number }) => void;
}

interface SimNode extends GNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  index?: number;
  fx?: number | null;
  fy?: number | null;
}
interface SimLink {
  source: string | SimNode;
  target: string | SimNode;
  relation: string;
}

interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_K = 0.15;
const MAX_K = 4.5;
const PULSE_MS = 900;

const TYPE_CLUSTERS: Record<string, { x: number; y: number }> = {
  agent: { x: 0, y: 0 },
  file: { x: -180, y: -120 },
  folder: { x: -260, y: -40 },
  branch: { x: 200, y: 200 },
  package: { x: 260, y: -40 },
  concept: { x: 0, y: -180 },
  decision: { x: 180, y: -120 },
  task: { x: 200, y: 30 },
  tool: { x: 140, y: 150 },
  memory: { x: 0, y: 180 },
  error: { x: -160, y: 140 },
  event: { x: -200, y: 10 },
};

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h % 1000) / 1000;
}

function seedPos(n: { type: string; id: string }): { x: number; y: number } {
  const anchor = TYPE_CLUSTERS[n.type] ?? { x: 0, y: 0 };
  const h = hash(n.id);
  const offsetR = 15 + h * 35;
  const offsetA = h * Math.PI * 2;
  return {
    x: anchor.x + Math.cos(offsetA) * offsetR,
    y: anchor.y + Math.sin(offsetA) * offsetR,
  };
}

const Map2D = forwardRef<Map2DHandle, Props>(function Map2D({ nodes, links, pulses, onSelect, onStats }, ref) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const pulsesRef = useRef(pulses);
  const onSelectRef = useRef(onSelect);
  const viewRef = useRef<View>({ x: 0, y: 0, k: 1 });
  const wakeRef = useRef<(() => void) | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const fittedRef = useRef(false);
  const hoverRef = useRef<string | null>(null);
  const pressRef = useRef<{ x: number; y: number; node: SimNode | null; moved: boolean } | null>(null);
  const dragRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const tweenRef = useRef<{ from: View; to: View; t0: number; dur: number } | null>(null);

  useEffect(() => {
    pulsesRef.current = pulses;
    onSelectRef.current = onSelect;
  }, [pulses, onSelect]);

  // create simulation once
  useEffect(() => {
    const sim = forceSimulation<SimNode>([])
      .force(
        "link",
        forceLink<SimNode, SimLink>([])
          .id((d: SimNode) => d.id)
          .distance(50)
          .strength(0.5)
      )
      .force("charge", forceManyBody<SimNode>().strength(-150))
      .force("collide", forceCollide<SimNode>().radius((d) => nodeRadius(d, false) + 14))
      .force("x", forceX<SimNode>((d) => TYPE_CLUSTERS[d.type]?.x ?? 0).strength(0.12))
      .force("y", forceY<SimNode>((d) => TYPE_CLUSTERS[d.type]?.y ?? 0).strength(0.12))
      .force("center", forceCenter(0, 0))
      .alpha(0.55)
      .alphaDecay(0.03)
      .velocityDecay(0.3)
      .stop();
    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, []);

  // sync data into the sim
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    const existing = new Map(nodesRef.current.map((n) => [n.id, n]));
    const next: SimNode[] = [];
    for (const n of nodes) {
      const prev = existing.get(n.id);
      if (prev) {
        prev.label = n.label;
        prev.type = n.type;
        prev.val = n.val;
        prev.lastActive = n.lastActive;
        next.push(prev);
      } else {
        const s = seedPos(n);
        next.push({ ...n, x: s.x, y: s.y, vx: 0, vy: 0 });
      }
    }
    nodesRef.current = next;
    const ids = new Set(next.map((n) => n.id));
    linksRef.current = links
      .filter((l) => ids.has(String(l.source)) && ids.has(String(l.target)))
      .map((l) => ({ source: String(l.source), target: String(l.target), relation: l.relation }));
    sim.nodes(next);
    (sim.force("link") as ReturnType<typeof forceLink>).links(linksRef.current as any);
    sim.alpha(0.5);
    onStats({ nodes: next.length, links: linksRef.current.length });
    wakeRef.current?.();
    if (!fittedRef.current && next.length > 0 && sizeRef.current.w > 0) {
      fittedRef.current = true;
      requestAnimationFrame(() => fitViewRef.current(500));
    }
  }, [nodes, links]);

  const fitViewRef = useRef<(ms: number) => void>(() => {});
  const zoomRef = useRef<(dir: number) => void>(() => {});
  const focusRef = useRef<(id: string) => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let rafRunning = false;
    let cssW = 0;
    let cssH = 0;

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      cssW = r.width;
      cssH = r.height;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      sizeRef.current = { w: cssW, h: cssH };
      if (rafRunning) draw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

    const draw = () => {
      if (!cssW || !cssH) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      const view = viewRef.current;
      const now = performance.now();
      ctx.save();
      ctx.translate(cssW / 2 + view.x, cssH / 2 + view.y);
      ctx.scale(view.k, view.k);

      const byId = new Map(nodesRef.current.map((n) => [n.id, n]));

      // links
      ctx.lineWidth = 1 / view.k;
      for (const l of linksRef.current) {
        const s = typeof l.source === "string" ? byId.get(l.source) : l.source;
        const t = typeof l.target === "string" ? byId.get(l.target) : l.target;
        if (!s || !t) continue;
        ctx.strokeStyle = LINK_STYLE[l.relation as keyof typeof LINK_STYLE] ?? "#4d5560";
        ctx.globalAlpha = 0.26;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // nodes
      for (const n of nodesRef.current) {
        const isHover = n.id === hoverRef.current;
        const r = nodeRadius(n, isHover);
        const color = nodeColor(n.type);
        const shape = NODE_STYLE[n.type]?.shape ?? "circle";
        const p = pulsesRef.current.get(n.id);
        let glow = 0;
        if (p) {
          const age = now - p;
          if (age < PULSE_MS) glow = 1 - age / PULSE_MS;
        }
        if (glow > 0) {
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.55 * glow;
          ctx.lineWidth = 2 / view.k;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 5 + glow * 16, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.shadowColor = color;
        ctx.shadowBlur = glow > 0 ? 14 * glow : isHover ? 8 : 0;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.94;
        drawShape(ctx, shape, n.x, n.y, r);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;

        if (view.k > 0.3 && n.label) {
          ctx.font = `${10.5 / view.k}px 'JetBrains Mono', 'Consolas', monospace`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.lineWidth = 3 / view.k;
          ctx.strokeStyle = "rgba(8,10,13,0.75)";
          ctx.strokeText(n.label, n.x, n.y + r + 4 / view.k);
          ctx.fillStyle = isHover ? "#eef1f5" : "#b9c0cb";
          ctx.fillText(n.label, n.x, n.y + r + 4 / view.k);
        }
      }
      ctx.restore();
    };

    const startLoop = () => {
      if (rafRunning) return;
      rafRunning = true;
      const loop = () => {
        const sim = simRef.current;
        const tw = tweenRef.current;
        let busy = false;
        if (sim && sim.alpha() > sim.alphaMin()) {
          sim.tick();
          busy = true;
        }
        if (tw) {
          const t = Math.min(1, (performance.now() - tw.t0) / tw.dur);
          const e = ease(t);
          const v = viewRef.current;
          v.x = tw.from.x + (tw.to.x - tw.from.x) * e;
          v.y = tw.from.y + (tw.to.y - tw.from.y) * e;
          v.k = tw.from.k + (tw.to.k - tw.from.k) * e;
          if (t >= 1) tweenRef.current = null;
          busy = true;
        }
        const now = performance.now();
        for (const [, p] of pulsesRef.current) {
          if (now - p < PULSE_MS) {
            busy = true;
            break;
          }
        }
        // hover rendering is static (constant shadow) — one redraw on pointermove is enough
        if (pressRef.current) busy = true;
        draw();
        if (busy) raf = requestAnimationFrame(loop);
        else rafRunning = false;
      };
      raf = requestAnimationFrame(loop);
    };
    wakeRef.current = startLoop;
    startLoop();

    const screenToGraph = (mx: number, my: number) => {
      const v = viewRef.current;
      return { x: (mx - cssW / 2 - v.x) / v.k, y: (my - cssH / 2 - v.y) / v.k };
    };

    const hitTest = (mx: number, my: number): SimNode | null => {
      const g = screenToGraph(mx, my);
      let best: SimNode | null = null;
      let bestD = Infinity;
      for (const n of nodesRef.current) {
        const dx = n.x - g.x;
        const dy = n.y - g.y;
        const d = Math.hypot(dx, dy);
        const r = nodeRadius(n, false) + 3;
        if (d <= r && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    };

    fitViewRef.current = (ms: number) => {
      const arr = nodesRef.current;
      if (!arr.length || !cssW || !cssH) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of arr) {
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x > maxX) maxX = n.x;
        if (n.y > maxY) maxY = n.y;
      }
      const bw = Math.max(1, maxX - minX);
      const bh = Math.max(1, maxY - minY);
      const k = Math.max(MIN_K, Math.min(MAX_K, (Math.min(cssW / bw, cssH / bh) * 0.82)));
      const to: View = {
        x: -(minX + bw / 2) * k,
        y: -(minY + bh / 2) * k,
        k,
      };
      tweenRef.current = { from: { ...viewRef.current }, to, t0: performance.now(), dur: Math.max(0, ms) };
      startLoop();
    };

    zoomRef.current = (dir: number) => {
      const factor = Math.pow(1.28, dir);
      const v = viewRef.current;
      const k = Math.max(MIN_K, Math.min(MAX_K, v.k * factor));
      v.x *= k / v.k;
      v.y *= k / v.k;
      v.k = k;
      startLoop();
    };

    focusRef.current = (id: string) => {
      const n = nodesRef.current.find((x) => x.id === id);
      if (!n) return;
      const v = viewRef.current;
      const k = Math.max(v.k, 1.5);
      tweenRef.current = {
        from: { ...v },
        to: { x: -n.x * k, y: -n.y * k, k },
        t0: performance.now(),
        dur: 550,
      };
      pulsesRef.current.set(id, performance.now());
      startLoop();
    };

    // ---- pointer ----
    const setHover = (mx: number, my: number) => {
      const hit = hitTest(mx, my);
      hoverRef.current = hit?.id ?? null;
      canvas.style.cursor = hit ? "pointer" : dragRef.current ? "grabbing" : "grab";
    };

    const onPointerDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const hit = hitTest(mx, my);
      pressRef.current = { x: mx, y: my, node: hit, moved: false };
      dragRef.current = { x: mx, y: my, vx: viewRef.current.x, vy: viewRef.current.y };
      startLoop();
    };
    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (pressRef.current) {
        const pr = pressRef.current;
        const dx = mx - pr.x;
        const dy = my - pr.y;
        if (Math.hypot(dx, dy) > 3) pr.moved = true;
        if (dragRef.current) {
          viewRef.current.x = dragRef.current.vx + dx;
          viewRef.current.y = dragRef.current.vy + dy;
        }
        canvas.style.cursor = "grabbing";
      } else {
        setHover(mx, my);
        startLoop();
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      const pr = pressRef.current;
      pressRef.current = null;
      dragRef.current = null;
      if (pr && !pr.moved) onSelectRef.current(pr.node);
      const rect = canvas.getBoundingClientRect();
      setHover(e.clientX - rect.left, e.clientY - rect.top);
      startLoop();
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const g = screenToGraph(mx, my);
      const v = viewRef.current;
      const factor = Math.pow(1.12, -e.deltaY / 40);
      const k = Math.max(MIN_K, Math.min(MAX_K, v.k * factor));
      v.x = mx - cssW / 2 - g.x * k;
      v.y = my - cssH / 2 - g.y * k;
      v.k = k;
      startLoop();
    };

    const onLeave = () => {
      hoverRef.current = null;
      startLoop();
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focusNode: (id) => focusRef.current(id),
      fitView: (ms = 600) => fitViewRef.current(ms),
      zoom: (dir) => zoomRef.current(dir),
    }),
    []
  );

  return (
    <div className="graph-canvas" ref={wrapRef}>
      <canvas ref={canvasRef} />
    </div>
  );
});

export default Map2D;
