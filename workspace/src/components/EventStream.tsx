import { useEffect, useMemo, useState } from "react";
import { store } from "../ws";
import { graphBridge } from "../graphBridge";
import type { EventChannel, StreamEvent } from "../types";

const CHANNELS: Array<"all" | EventChannel> = ["all", "agent", "tool", "file", "system", "memory"];

const CHANNEL_BADGE: Record<EventChannel, string> = {
  agent: "agt",
  tool: "tool",
  file: "file",
  system: "sys",
  memory: "mem",
};

export default function EventStream() {
  const events = useStore((s) => s.events);
  const [filter, setFilter] = useState<"all" | EventChannel>("all");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<StreamEvent | null>(null);
  const [copied, setCopied] = useState(false);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events) m.set(e.channel, (m.get(e.channel) ?? 0) + 1);
    return m;
  }, [events]);

  const shown = useMemo(() => {
    let list = events;
    if (filter !== "all") list = list.filter((e) => e.channel === filter);
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      list = list.filter((e) => (e.subject + " " + e.kind + " " + (e.meta ?? "")).toLowerCase().includes(s));
    }
    return list;
  }, [events, filter, q]);

  function openDetail(e: StreamEvent) {
    setSelected(e);
    if (e.nodeId) graphBridge.focusNode?.(e.nodeId);
  }

  function copyJson(e: StreamEvent) {
    navigator.clipboard?.writeText(JSON.stringify(e, null, 2)).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {
        /* clipboard denied — ignore */
      }
    );
  }

  return (
    <div className="stream-panel panel">
      <div className="stream-head">
        <div className="stream-title">
          <span className="stream-live" />
          EVENT STREAM
          <span className="graph-count">{events.length} events</span>
        </div>
        <div className="stream-actions">
          <input className="graph-search" placeholder="filter stream…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="ghost-btn" onClick={() => setSelected(null)} disabled={!selected}>
            clear detail
          </button>
        </div>
      </div>

      <div className="stream-filters">
        {CHANNELS.map((c) => (
          <button
            key={c}
            className={`chip ${filter === c ? "active" : ""}`}
            onClick={() => setFilter(c)}
          >
            {c}
            {c !== "all" && <b>{counts.get(c) ?? 0}</b>}
          </button>
        ))}
      </div>

      <div className="stream-list">
        {shown.length === 0 && <div className="stream-empty">no events in this view</div>}
        {shown.map((e) => {
          const active = selected?.id === e.id;
          return (
            <button
              key={e.id}
              className={`event-row ${active ? "active" : ""} ${e.status === "fail" ? "fail" : ""}`}
              onClick={() => openDetail(e)}
            >
              <span className="event-time">{fmtTime(e.at)}</span>
              <span className={`event-badge ${e.channel}`}>{CHANNEL_BADGE[e.channel]}</span>
              <span className="event-status" title={e.status}>
                {e.status === "ok" ? "✓" : e.status === "fail" ? "✕" : e.status === "run" ? "●" : "·"}
              </span>
              <span className="event-kind">{e.kind}</span>
              <span className="event-subject">{e.subject}</span>
              {e.nodeId && <span className="event-node">◎</span>}
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="stream-detail">
          <div className="stream-detail-head">
            <span>{selected.kind}</span>
            <button className="icon-btn" onClick={() => setSelected(null)}>
              ×
            </button>
          </div>
          <div className="stream-detail-body">
            <div className="inspector-label">{selected.subject}</div>
            {selected.meta && (
              <div className="inspector-meta">
                <code>{selected.meta}</code>
              </div>
            )}
            <div className="inspector-meta">
              channel <b>{selected.channel}</b> · status <b>{selected.status}</b> · {fmtTime(selected.at)}
            </div>
            {selected.nodeId && (
              <div className="inspector-meta">
                node <code>{selected.nodeId}</code>
              </div>
            )}
            <div className="detail-actions">
              {selected.nodeId && (
                <button className="ghost-btn" onClick={() => graphBridge.focusNode?.(selected.nodeId!)}>
                  focus in graph
                </button>
              )}
              <button className="ghost-btn" onClick={() => copyJson(selected)}>
                {copied ? "copied" : "copy json"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function fmtTime(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function useStore<T>(sel: (s: typeof store) => T): T {
  const [v, setV] = useState(() => sel(store));
  useEffect(() => store.subscribe(() => setV(sel(store))), []);
  return v;
}
