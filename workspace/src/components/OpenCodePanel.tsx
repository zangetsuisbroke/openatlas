import { useEffect } from "react";
import { useSyncExternalStore } from "react";

type Tile = { key: number; url: string; title: string; failed: boolean };

let nextKey = 1;
let tilesStore: Tile[] = [{ key: 0, url: "", title: "OpenCode", failed: false }];
let layoutStore: "stack" | "split" = "stack";
const listeners = new Set<() => void>();
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function emit() {
  for (const l of listeners) l();
}
function getTiles() {
  return tilesStore;
}
function getLayout() {
  return layoutStore;
}

async function ensureFirst(): Promise<void> {
  if (tilesStore[0].url) return;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch("/api/opencode/start", { method: "POST", signal: ctl.signal });
    const d = await r.json();
    if (d.running && d.url) tilesStore = [{ ...tilesStore[0], url: d.url }];
    else tilesStore = [{ ...tilesStore[0], failed: true }];
  } catch {
    tilesStore = [{ ...tilesStore[0], failed: true }];
  } finally {
    clearTimeout(t);
  }
  emit();
}

export async function newChat(): Promise<void> {
  let url = "";
  let title = "Chat";
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch("/api/opencode/session", { method: "POST", signal: ctl.signal });
    const d = await r.json();
    if (d.ok && d.url) {
      url = d.url;
      title = "Chat";
    }
  } catch {
    /* fall through */
  }
  clearTimeout(t);
  if (!url) {
    try {
      const r = await fetch("/api/opencode/start", { method: "POST" });
      const d = await r.json();
      if (d.running && d.url) url = d.url;
    } catch {
      /* give up */
    }
  }
  tilesStore = [...tilesStore, { key: nextKey++, url, title, failed: !url }];
  emit();
}

function removeChat(key: number): void {
  const next = tilesStore.filter((t) => t.key !== key);
  if (next.length === 0) next.push({ key: 0, url: "", title: "OpenCode", failed: false });
  tilesStore = next;
  emit();
}

export default function OpenCodePanel() {
  const tiles = useSyncExternalStore(subscribe, getTiles);
  const layout = useSyncExternalStore(subscribe, getLayout);

  useEffect(() => {
    ensureFirst();
  }, []);

  return (
    <div className="panel opencode-panel">
      <div className="opencode-header">
        <span className="opencode-title">
          <span className="opencode-dot" /> OpenCode Web
          <span className="graph-count">{tiles.length}</span>
        </span>
        <div className="stream-actions">
          <button
            className={`chip ${layout === "split" ? "active" : ""}`}
            onClick={() => setLayout(layout === "stack" ? "split" : "stack")}
            title="toggle tiled layout"
          >
            {layout === "stack" ? "stacked" : "split"}
          </button>
          <button className="accent-btn" onClick={newChat}>
            + New Chat
          </button>
        </div>
      </div>
      <div className={`oc-tiles ${layout}`}>
        {tiles.map((t) => (
          <div className="oc-tile" key={t.key}>
            <div className="oc-tile-head">
              <span className="term-dot" style={{ background: "#d62f22" }} />
              <span className="term-title">{t.title}</span>
              <div className="term-tab-actions">
                {t.url && (
                  <a className="opencode-link" href={t.url} target="_blank" rel="noreferrer">
                    ↗
                  </a>
                )}
                <button className="icon-btn" title="close" onClick={() => removeChat(t.key)}>
                  ×
                </button>
              </div>
            </div>
            <div className="oc-tile-body">
              {t.failed && (
                <div className="opencode-state error">
                  <span>opencode unavailable</span>
                </div>
              )}
              {t.url && <iframe className="opencode-frame" src={t.url} title={t.title} />}
              {!t.url && !t.failed && (
                <div className="opencode-state">
                  <i className="opencode-spin" /> starting…
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function setLayout(m: "stack" | "split"): void {
  if (layoutStore === m) return;
  layoutStore = m;
  emit();
}
