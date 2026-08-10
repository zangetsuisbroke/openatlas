import { useEffect, useRef, useState } from "react";
import { graphReset, newTerm, runDemo, store } from "../ws";

export type LayoutMode = "split" | "graph" | "terminal" | "opencode";

const ACCENTS: Array<{ name: string; a: string; a2: string }> = [
  { name: "graphite", a: "#59dda6", a2: "#2f9f74" },
  { name: "cyan", a: "#4fd8e8", a2: "#2b8aa8" },
  { name: "amber", a: "#e8b35a", a2: "#b07a2b" },
];

export default function TopBar({
  layout,
  onLayout,
  accent,
  onAccent,
}: {
  layout: LayoutMode;
  onLayout: (m: LayoutMode) => void;
  accent: string;
  onAccent: (name: string) => void;
}) {
  const connected = useStore((s) => s.connected);
  const activeCount = useStore((s) => s.events.length);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);

  const cycleLayout = () => {
    const order: LayoutMode[] = ["split", "terminal", "graph", "opencode"];
    const next = order[(order.indexOf(layout) + 1) % order.length];
    onLayout(next);
  };

  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!wrap.current?.contains(t)) {
        setSettingsOpen(false);
        setProfileOpen(false);
      }
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, []);

  return (
    <div ref={wrap} className="topbar">
      <div className="tb-brand">
        <svg className="atlas-logo" width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M12 2 21 7v10l-9 5-9-5V7z" stroke="var(--accent)" strokeWidth="1.6" fill="rgba(89,221,166,0.08)" />
          <circle cx="12" cy="12" r="3.4" stroke="var(--accent)" strokeWidth="1.4" />
        </svg>
        <span className="tb-logo-text">atlas</span>
        <span className="tb-sep" />
        <span className="tb-word">WORKSPACE</span>
      </div>

      <div className="tb-center">
        <span className="tb-active">
          <i className={connected ? "ok" : ""} />
          ACTIVE {connected ? "· LIVE" : "· CONNECTING"}
        </span>
        <span className="tb-count">{activeCount}</span>
      </div>

      <div className="tb-actions">
        <button className="tb-btn accent" onClick={newTerm}>
          + New Terminal
        </button>
        <button className="tb-btn" onClick={cycleLayout} title="cycle layout">
          {layout === "split" ? "≡ Layout" : layout === "graph" ? "◫ Graph" : layout === "opencode" ? "⌘ Code" : "▭ Terminal"}
        </button>
        <button className="tb-btn" onClick={() => onLayout(layout === "opencode" ? "split" : "opencode")} title="OpenCode web UI">
          ⌘ OpenCode
        </button>
        <button className={`tb-btn ${settingsOpen ? "active" : ""}`} onClick={() => { setSettingsOpen(!settingsOpen); setProfileOpen(false); }}>
          ⚙ Settings
        </button>
        <button className={`tb-btn ${profileOpen ? "active" : ""}`} onClick={() => { setProfileOpen(!profileOpen); setSettingsOpen(false); }}>
          ◎ Profile
        </button>
      </div>

      {settingsOpen && (
        <div className="tb-dropdown settings-drop">
          <div className="dd-label">accent</div>
          <div className="dd-accents">
            {ACCENTS.map((a) => (
              <button
                key={a.name}
                className={`dd-accent ${accent === a.name ? "active" : ""}`}
                title={a.name}
                onClick={() => onAccent(a.name)}
              >
                <i style={{ background: a.a }} />
                {a.name}
              </button>
            ))}
          </div>
          <div className="dd-label">graph</div>
          <div className="dd-actions">
            <button className="ghost-btn" onClick={runDemo}>run demo sweep</button>
            <button className="ghost-btn danger" onClick={graphReset}>reset graph</button>
          </div>
        </div>
      )}

      {profileOpen && (
        <div className="tb-dropdown profile-drop">
          <div className="dd-profile-row">
            <span className="dd-avatar">A</span>
            <div>
              <div className="dd-name">atlas-core</div>
              <div className="dd-sub">local workspace agent</div>
            </div>
          </div>
          <div className="dd-stats" onClick={() => { setStatsOpen(!statsOpen); }}>
            <div className="dd-stat"><b>{activeCount}</b><span>events</span></div>
            <div className="dd-stat"><b>{store.nodes.size}</b><span>nodes</span></div>
            <div className="dd-stat"><b>{store.links.size}</b><span>links</span></div>
          </div>
          {statsOpen && (
            <div className="dd-stats-detail">
              <div className="dd-label">connection</div>
              <div className="dd-sub" style={{ margin: "4px 0" }}>
                ws {connected ? "connected" : "offline"} · port 4819
              </div>
              <div className="dd-label">client</div>
              <div className="dd-sub" style={{ margin: "4px 0" }}>
                {navigator.userAgent.includes("Playwright") ? "playwright" : "browser"} · {Math.round(performance.now())}ms uptime
              </div>
            </div>
          )}
          <div className="dd-actions">
            <button className="ghost-btn" onClick={() => newTerm()}>spawn terminal</button>
            <button className="ghost-btn" onClick={runDemo}>run demo</button>
          </div>
        </div>
      )}
    </div>
  );
}

function useStore<T>(sel: (s: typeof store) => T): T {
  const [v, setV] = useState(() => sel(store));
  useEffect(() => store.subscribe(() => setV(sel(store))), []);
  return v;
}
