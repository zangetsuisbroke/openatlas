import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  KIND_COLORS,
  KIND_LABELS,
  ORIGIN_COLORS,
  type GraphData,
  type GraphLink,
  type GraphNode,
  type Scope,
} from "../api";
import { EmptyState, IconNetwork } from "../components";

const FILE_COLOR = "#22d3ee";
const FALLBACK_COLOR = "#8b93a3";

const ORIGINS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "auto", label: "Auto" },
  { id: "file", label: "File" },
  { id: "agent", label: "Agent" },
  { id: "recall", label: "Recall" },
];

function Dot({ color }: { color: string }) {
  return <span className="dot-inline" style={{ background: color }} />;
}

function ToggleChip({
  on,
  color,
  label,
  onClick,
}: {
  on: boolean;
  color: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="chip"
      onClick={onClick}
      title={on ? `Hide ${label}` : `Show ${label}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        cursor: "pointer",
        opacity: on ? 1 : 0.35,
        borderColor: on ? color : undefined,
      }}
    >
      <Dot color={color} />
      {label}
    </button>
  );
}

function fmtMetaValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

interface Pos {
  x: number;
  y: number;
}

const KIND_GROUPS = ["task", "plan", "action", "decision", "hypothesis", "blocker", "error", "root_cause", "fix", "verification", "insight", "lesson"];

/** Clustered initial placement + Fruchterman–Reingold-style refinement. */
function layout(nodes: GraphNode[], links: GraphLink[], w: number, h: number): Map<string, Pos> {
  const pos = new Map<string, Pos>();
  const groupOf = (n: GraphNode) => (n.type === "file" ? "file" : n.kind && KIND_GROUPS.includes(n.kind) ? n.kind : "other");
  const groups = Array.from(new Set(nodes.map(groupOf)));
  const byGroup = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const g = groupOf(n);
    byGroup.set(g, [...(byGroup.get(g) ?? []), n]);
  }
  groups.forEach((g, gi) => {
    const members = byGroup.get(g) ?? [];
    const startAngle = (gi / groups.length) * 2 * Math.PI;
    const spread = (Math.PI * 1.8) / Math.max(1, groups.length);
    members.forEach((n, mi) => {
      const angle = startAngle + (mi / Math.max(1, members.length)) * spread;
      const ring = 70 + (mi % 5) * 55 + (g === "file" ? 40 : 0);
      pos.set(n.id, {
        x: w / 2 + Math.cos(angle) * ring + (Math.random() - 0.5) * 30,
        y: h / 2 + Math.sin(angle) * ring * 0.7 + (Math.random() - 0.5) * 30,
      });
    });
  });

  const area = Math.max(1, w * h);
  const k = 55 * Math.sqrt(area / Math.max(10, nodes.length * 900));
  const kRep = k * k;
  const nodesArr = nodes;
  const iterations = nodes.length < 150 ? 320 : nodes.length < 400 ? 180 : 90;
  for (let iter = 0; iter < iterations; iter++) {
    const temp = Math.max(2, 40 * (1 - iter / iterations));
    // repulsion
    for (let i = 0; i < nodesArr.length; i++) {
      const a = pos.get(nodesArr[i]!.id);
      if (!a) continue;
      for (let j = i + 1; j < nodesArr.length; j++) {
        const b = pos.get(nodesArr[j]!.id);
        if (!b) continue;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-4) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = 1;
        }
        const d = Math.sqrt(d2);
        const f = Math.min(kRep / d, temp * 3);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.x += fx;
        a.y += fy;
        b.x -= fx;
        b.y -= fy;
      }
    }
    // springs
    for (const link of links) {
      const s = pos.get(String(link.source));
      const t = pos.get(String(link.target));
      if (!s || !t) continue;
      let dx = t.x - s.x;
      let dy = t.y - s.y;
      let d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-4) d = 1;
      const f = ((d - 120) / 120) * temp * 0.6;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      s.x += fx;
      s.y += fy;
      t.x -= fx;
      t.y -= fy;
    }
    // gravity + bounds clamp
    for (const n of nodesArr) {
      const p = pos.get(n.id);
      if (!p) continue;
      p.x += (w / 2 - p.x) * 0.008 * temp * 0.04;
      p.y += (h / 2 - p.y) * 0.008 * temp * 0.04;
      p.x = Math.max(30, Math.min(w - 30, p.x));
      p.y = Math.max(30, Math.min(h - 30, p.y));
    }
  }
  return pos;
}

export default function GraphView({
  scope,
  onOpenSession,
}: {
  scope: Scope;
  onOpenSession: (sessionId: string) => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [hiddenOrigins, setHiddenOrigins] = useState<Set<string>>(new Set());
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const [positions, setPositions] = useState<Map<string, Pos>>(new Map());

  const measure = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setSize((prev) => (prev.w === rect.width && prev.h === rect.height ? prev : { w: rect.width, h: rect.height }));
  }, []);

  useEffect(() => {
    measure();
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelected(null);
    setTransform({ x: 0, y: 0, k: 1 });
    api
      .graph(scope)
      .then((data) => {
        if (cancelled) return;
        setGraphData(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, measure]);

  const filtered = useMemo<GraphData>(() => {
    if (!graphData) return { nodes: [], links: [] };
    const visible = new Set<string>();
    for (const node of graphData.nodes) {
      if (node.type === "file" || !node.kind || !hiddenKinds.has(node.kind)) visible.add(node.id);
    }
    const links = graphData.links.filter(
      (link) => !hiddenOrigins.has(link.origin) && visible.has(link.source) && visible.has(link.target),
    );
    const nodes = graphData.nodes.filter((node) => visible.has(node.id));
    return { nodes, links };
  }, [graphData, hiddenKinds, hiddenOrigins]);

  // (Re)compute layout when the visible graph changes.
  useEffect(() => {
    if (size.w === 0 || filtered.nodes.length === 0) return;
    setPositions(layout(filtered.nodes, filtered.links, size.w, size.h));
  }, [filtered, size.w, size.h]);

  const toggleKind = useCallback((kind: string) => {
    setHiddenKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const toggleOrigin = useCallback((origin: string) => {
    setHiddenOrigins((prev) => {
      const next = new Set(prev);
      if (next.has(origin)) next.delete(origin);
      else next.add(origin);
      return next;
    });
  }, []);

  const selectedLinks = useMemo(() => {
    if (!selected || !graphData) return [];
    return graphData.links.filter((l) => l.source === selected.id || l.target === selected.id);
  }, [selected, graphData]);

  const neighborCount = useMemo(() => {
    if (!selected || !graphData) return 0;
    const ids = new Set<string>();
    for (const link of graphData.links) {
      if (link.source === selected.id) ids.add(String(link.target));
      else if (link.target === selected.id) ids.add(String(link.source));
    }
    return ids.size;
  }, [selected, graphData]);

  const hoverNeighbors = useMemo(() => {
    if (!hover || !graphData) return null;
    const set = new Set<string>([hover]);
    for (const link of graphData.links) {
      if (link.source === hover) set.add(String(link.target));
      else if (link.target === hover) set.add(String(link.source));
    }
    return set;
  }, [hover, graphData]);

  const metaEntries = useMemo(() => {
    if (!selected?.meta) return [];
    return Object.entries(selected.meta).filter(([key]) => key !== "sessionId");
  }, [selected]);

  const sessionId = useMemo(() => {
    const meta = selected?.meta;
    return meta && typeof meta.sessionId === "string" ? (meta.sessionId as string) : null;
  }, [selected]);

  const hoverNode = useMemo(
    () => (hover && graphData ? graphData.nodes.find((n) => n.id === hover) ?? null : null),
    [hover, graphData],
  );

  // ---- interaction (pan / zoom / drag) ----
  const interaction = useRef<{ mode: "pan" | "drag"; nodeId: string | null; startX: number; startY: number; origX: number; origY: number } | null>(null);

  const screenToGraph = useCallback((sx: number, sy: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const ox = rect ? rect.left : 0;
    const oy = rect ? rect.top : 0;
    return { x: (sx - ox - transform.x) / transform.k, y: (sy - oy - transform.y) / transform.k };
  }, [transform]);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const rect = svgRef.current?.getBoundingClientRect();
      const mx = rect ? e.clientX - rect.left : 0;
      const my = rect ? e.clientY - rect.top : 0;
      setTransform((t) => {
        const k = Math.min(4, Math.max(0.25, t.k * factor));
        const nx = mx - ((mx - t.x) * k) / t.k;
        const ny = my - ((my - t.y) * k) / t.k;
        return { x: nx, y: ny, k };
      });
    },
    [],
  );

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const onBgDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      interaction.current = { mode: "pan", nodeId: null, startX: e.clientX, startY: e.clientY, origX: transform.x, origY: transform.y };
      try {
        (e.target as Element).setPointerCapture?.(e.pointerId);
      } catch {
        /* synthetic events / no active pointer */
      }
    },
    [transform],
  );

  const onNodeDown = useCallback(
    (e: React.PointerEvent, id: string) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const p = positions.get(id);
      interaction.current = { mode: "drag", nodeId: id, startX: e.clientX, startY: e.clientY, origX: p?.x ?? 0, origY: p?.y ?? 0 };
      try {
        (e.target as Element).setPointerCapture?.(e.pointerId);
      } catch {
        /* synthetic events / no active pointer */
      }
    },
    [positions],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const it = interaction.current;
      if (!it) return;
      if (it.mode === "pan") {
        const dx = e.clientX - it.startX;
        const dy = e.clientY - it.startY;
        setTransform((t) => ({ x: it.origX + dx, y: it.origY + dy, k: t.k }));
      } else if (it.mode === "drag" && it.nodeId) {
        const g = screenToGraph(e.clientX, e.clientY);
        setPositions((prev) => {
          const next = new Map(prev);
          next.set(it.nodeId!, { x: g.x, y: g.y });
          return next;
        });
      }
    },
    [screenToGraph],
  );

  const endInteraction = useCallback(() => {
    interaction.current = null;
  }, []);

  const labelStyle = { fontSize: 10, letterSpacing: 1, color: "var(--text-faint)", textTransform: "uppercase" as const };

  const nodeRadius = (n: GraphNode) => (n.type === "file" ? 6 + Math.min(6, n.degree * 0.4) : 4 + Math.min(10, n.degree * 0.7));

  return (
    <div className="graph-wrap">
      {size.w > 0 && !loading && !error && graphData && graphData.nodes.length > 0 && (
        <div className="graph-filters">
          <div className="graph-filter-row">
            <span style={labelStyle}>Kinds</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {Object.entries(KIND_LABELS).map(([kind, label]) => (
                <ToggleChip key={kind} on={!hiddenKinds.has(kind)} color={KIND_COLORS[kind] ?? FALLBACK_COLOR} label={label} onClick={() => toggleKind(kind)} />
              ))}
            </div>
          </div>
          <div className="graph-filter-row">
            <span style={labelStyle}>Origins</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {ORIGINS.map((o) => (
                <ToggleChip key={o.id} on={!hiddenOrigins.has(o.id)} color={ORIGIN_COLORS[o.id] ?? FALLBACK_COLOR} label={o.label} onClick={() => toggleOrigin(o.id)} />
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="graph-canvas" ref={canvasRef}>
        {size.w > 0 && !loading && !error && graphData && graphData.nodes.length > 0 && (
          <svg
            ref={svgRef}
            width={size.w}
            height={size.h}
            onPointerDown={onBgDown}
            onPointerMove={onPointerMove}
            onPointerUp={endInteraction}
            style={{ touchAction: "none" }}
          >
            <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
              {/* links */}
              {filtered.links.map((link) => {
                const s = positions.get(String(link.source));
                const t = positions.get(String(link.target));
                if (!s || !t) return null;
                return (
                  <line
                    key={link.id}
                    x1={s.x}
                    y1={s.y}
                    x2={t.x}
                    y2={t.y}
                    stroke={ORIGIN_COLORS[link.origin] ?? FALLBACK_COLOR}
                    strokeOpacity={hover && (!hoverNeighbors?.has(String(link.source)) || !hoverNeighbors?.has(String(link.target))) ? 0.08 : 0.3}
                    strokeWidth={1}
                  />
                );
              })}
              {/* nodes */}
              {filtered.nodes.map((n) => {
                const p = positions.get(n.id);
                if (!p) return null;
                const dim = hover ? !hoverNeighbors?.has(n.id) : false;
                const color = n.type === "file" ? FILE_COLOR : (n.kind ? KIND_COLORS[n.kind] : undefined) ?? FALLBACK_COLOR;
                const isSel = selected?.id === n.id;
                const r = nodeRadius(n);
                return (
                  <g
                    key={n.id}
                    transform={`translate(${p.x},${p.y})`}
                    opacity={dim ? 0.15 : 1}
                    onPointerDown={(e) => onNodeDown(e, n.id)}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelected(n);
                    }}
                    onPointerEnter={() => setHover(n.id)}
                    onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
                    style={{ cursor: "pointer" }}
                  >
                    {n.type === "file" ? (
                      <rect
                        x={-r}
                        y={-r}
                        width={r * 2}
                        height={r * 2}
                        rx={2}
                        fill={color}
                        fillOpacity={0.25}
                        stroke={isSel ? "#ffffff" : color}
                        strokeWidth={isSel ? 2 : 1.2}
                      />
                    ) : (
                      <circle
                        r={r}
                        fill={color}
                        fillOpacity={0.32}
                        stroke={isSel ? "#ffffff" : color}
                        strokeWidth={isSel ? 2 : 1.2}
                      />
                    )}
                    <text
                      y={r + 11}
                      textAnchor="middle"
                      fontSize={9.5}
                      fill="var(--text-dim)"
                      style={{ pointerEvents: "none", userSelect: "none" }}
                    >
                      {n.label.length > 34 ? n.label.slice(0, 33) + "…" : n.label}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        )}

        {loading && (
          <div className="graph-overlay">
            <div className="loading">Building graph…</div>
          </div>
        )}
        {!loading && error && (
          <div className="graph-overlay">
            <div className="error">{error}</div>
          </div>
        )}
        {!loading && !error && graphData && graphData.nodes.length === 0 && (
          <div className="graph-overlay">
            <EmptyState
              icon={<IconNetwork size={26} />}
              title="No reasoning steps captured yet"
              body="Use opencode in this project and the graph will fill in as sessions are distilled."
            />
          </div>
        )}

        {size.w > 0 && !loading && !error && graphData && graphData.nodes.length > 0 && (
          <>
            <div className="graph-hint">drag to pan · scroll to zoom · click a node</div>
            {hoverNode && (
              <div className="graph-tooltip">
                <span className={`badge kind-${hoverNode.kind}`}>{hoverNode.kind ? KIND_LABELS[hoverNode.kind] ?? hoverNode.kind : hoverNode.type}</span>
                <span>{hoverNode.label}</span>
              </div>
            )}
            {selected && (
              <div className="graph-side">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                  <h3 style={{ margin: 0, ...labelStyle }}>{selected.type === "file" ? "File" : "Reasoning step"}</h3>
                  <button type="button" className="btn" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => setSelected(null)}>
                    Close
                  </button>
                </div>
                {selected.type === "file" ? (
                  <>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, wordBreak: "break-all", color: "var(--text)" }}>{selected.label}</div>
                    <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 8 }}>
                      Degree {selected.degree} · {neighborCount} connected step{neighborCount === 1 ? "" : "s"}
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                      {selected.kind && <span className={`badge kind-${selected.kind}`}>{KIND_LABELS[selected.kind] ?? selected.kind}</span>}
                      <span className="chip">degree {selected.degree}</span>
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text)", marginBottom: 8 }}>{selected.label}</div>
                    {(metaEntries.length > 0 || sessionId) && (
                      <div style={{ marginBottom: 8 }}>
                        <h3 style={labelStyle}>Meta</h3>
                        {metaEntries.map(([key, value]) => (
                          <div key={key} style={{ display: "flex", gap: 8, fontSize: 11.5, marginBottom: 4 }}>
                            <span style={{ color: "var(--text-faint)", minWidth: 90, flexShrink: 0 }}>{key}</span>
                            <span style={{ color: "var(--text-dim)", wordBreak: "break-all" }}>{fmtMetaValue(value)}</span>
                          </div>
                        ))}
                        {sessionId && (
                          <div style={{ display: "flex", gap: 8, fontSize: 11.5, marginBottom: 4 }}>
                            <span style={{ color: "var(--text-faint)", minWidth: 90, flexShrink: 0 }}>sessionId</span>
                            <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{sessionId}</span>
                          </div>
                        )}
                      </div>
                    )}
                    <h3 style={labelStyle}>Links ({selectedLinks.length})</h3>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {selectedLinks.map((link) => (
                        <div key={link.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, flexWrap: "wrap" }}>
                          <span className={`badge origin-${link.origin}`}>{link.relation}</span>
                          <span className="chip">{link.origin}</span>
                          <span style={{ color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>{link.source === selected.id ? link.target : link.source}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {sessionId && (
                  <button type="button" className="btn primary" style={{ marginTop: 12 }} onClick={() => onOpenSession(sessionId)}>
                    Open in Archives
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
