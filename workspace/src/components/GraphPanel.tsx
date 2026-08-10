import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { store } from "../ws";
import { graphBridge } from "../graphBridge";
import Map2D, { type Map2DHandle } from "./Map2D";
import { nodeColor, TYPE_ORDER } from "../graph/visuals";
import type { GNode, NodeType } from "../types";

function useStore<T>(sel: (s: typeof store) => T): T {
  const [v, setV] = useState(() => sel(store));
  useEffect(() => store.subscribe(() => setV(sel(store))), []);
  return v;
}

export default function GraphPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map2DHandle>(null);

  const graphVersion = useStore((s) => s.graphVersion);
  const pulsesVersion = useStore((s) => s.pulsesVersion);
  const pulses = useMemo(() => new Map(store.pulses), [pulsesVersion]);
  const [filter, setFilter] = useState<"all" | NodeType>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<GNode | null>(null);
  const [stats, setStats] = useState({ nodes: 0, links: 0 });

  const { nodes, links } = useMemo(() => {
    const { nodes, links } = store.graphSnapshot();
    const filteredNodes = filter === "all" ? nodes : nodes.filter((n) => n.type === filter);
    const ids = new Set(filteredNodes.map((n) => n.id));
    return {
      nodes: filteredNodes,
      links: links.filter((l) => ids.has(l.source as string) && ids.has(l.target as string)),
    };
  }, [graphVersion, filter]);

  useEffect(() => {
    graphBridge.focusNode = (id: string) => {
      mapRef.current?.focusNode(id);
      store.pulse(id, Date.now());
      const n = store.nodes.get(id);
      if (n) setSelected(n);
    };
    return () => {
      graphBridge.focusNode = null;
    };
  }, []);

  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of store.nodes.values()) m.set(n.type, (m.get(n.type) ?? 0) + 1);
    return m;
  }, [graphVersion]);

  const onStats = useCallback((s: { nodes: number; links: number }) => setStats(s), []);

  function doSearch() {
    const q = search.trim().toLowerCase();
    if (!q) return;
    const hit = nodes.find((n) => n.label.toLowerCase().includes(q));
    if (hit) graphBridge.focusNode?.(hit.id);
  }

  function zoom(dir: number) {
    mapRef.current?.zoom(dir);
  }

  function resetView() {
    mapRef.current?.fitView(600);
  }

  function toggleFullscreen() {
    const el = containerRef.current!;
    try {
      if (document.fullscreenElement) document.exitFullscreen()?.catch(() => {});
      else el.requestFullscreen()?.catch(() => {});
    } catch {
      /* fullscreen denied — ignore */
    }
  }

  return (
    <div className="graph-panel panel" ref={containerRef}>
      <div className="graph-toolbar">
        <div className="graph-title">
          <span className="graph-live" />
          KNOWLEDGE GRAPH
          <span className="graph-count">
            {stats.nodes} nodes · {stats.links} links
          </span>
        </div>
        <div className="graph-controls">
          <input
            className="graph-search"
            placeholder="search nodes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doSearch()}
          />
          <select value={filter} onChange={(e) => setFilter(e.target.value as any)}>
            <option value="all">all types</option>
            {TYPE_ORDER.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button className="icon-btn" title="zoom in" onClick={() => zoom(1)}>
            +
          </button>
          <button className="icon-btn" title="zoom out" onClick={() => zoom(-1)}>
            −
          </button>
          <button className="icon-btn" title="fit graph" onClick={resetView}>
            ⟲
          </button>
          <button className="icon-btn" title="fullscreen" onClick={toggleFullscreen}>
            ⛶
          </button>
        </div>
      </div>

      <Map2D
        ref={mapRef}
        nodes={nodes}
        links={links}
        pulses={pulses}
        onSelect={setSelected}
        onStats={onStats}
      />

      <div className="graph-legend">
        {TYPE_ORDER.map((t) => (
          <span
            key={t}
            className={`legend-item ${filter === t ? "active" : ""}`}
            style={{ color: nodeColor(t) }}
            onClick={() => setFilter(filter === t ? "all" : t)}
          >
            <i style={{ background: nodeColor(t) }} />
            {t}
            <b>{typeCounts.get(t) ?? 0}</b>
          </span>
        ))}
      </div>

      {selected && (
        <div className="graph-inspector">
          <div className="inspector-head">
            <span style={{ color: nodeColor(selected.type) }}>
              {selected.type.toUpperCase()}
            </span>
            <button className="icon-btn" onClick={() => setSelected(null)}>
              ×
            </button>
          </div>
          <div className="inspector-label">{selected.label}</div>
          <div className="inspector-meta">
            id: <code>{selected.id}</code>
            <br />
            val: {selected.val.toFixed(2)} · last active:{" "}
            {new Date(selected.lastActive).toLocaleTimeString()}
          </div>
        </div>
      )}
    </div>
  );
}
