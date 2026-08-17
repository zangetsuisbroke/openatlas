import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import "@xterm/xterm/css/xterm.css";
import { killTerm, newTerm, store, termInput, termResize } from "../ws";

const DARK_BG = "#0c0b09";
const DARK_FG = "#cfc6b8";

export default function TerminalsPanel() {
  const sessions = useStore((s) => s.sessions);
  const [layout, setLayout] = useState<"stack" | "split">("stack");

  return (
    <div className="terminals-panel panel">
      <div className="terminals-head">
        <div className="stream-title">
          <span className="term-live" />
          TERMINALS
          <span className="graph-count">{sessions.length} active</span>
        </div>
        <div className="stream-actions">
          <button className={`chip ${layout === "split" ? "active" : ""}`} onClick={() => setLayout(layout === "stack" ? "split" : "stack")} title="toggle terminal layout">
            {layout === "stack" ? "stacked" : "split"}
          </button>
          <button className="accent-btn" onClick={newTerm}>
            + New Terminal
          </button>
        </div>
      </div>

      <div className={`term-canvases ${layout}`}>
        {sessions.length === 0 && (
          <div className="stream-empty">
            no terminals — <button className="ghost-btn" onClick={newTerm}>create one</button>
          </div>
        )}
        {sessions.map((s) => (
          <TermPane key={s.id} id={s.id} title={s.title} />
        ))}
      </div>
    </div>
  );
}

function TermPane({ id, title }: { id: string; title: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [running, setRunning] = useState(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'Consolas', monospace",
      fontSize: 12.5,
      lineHeight: 1.28,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 3000,
      theme: {
        background: DARK_BG,
        foreground: DARK_FG,
        cursor: "#d62f22",
        cursorAccent: "#0c0b09",
        selectionBackground: "rgba(214,47,34,0.25)",
        black: "#1b1814",
        red: "#d14a3a",
        green: "#7fd1a0",
        yellow: "#d9b268",
        blue: "#6f9df1",
        magenta: "#a892e0",
        cyan: "#6cc8e0",
        white: "#cfc6b8",
        brightBlack: "#6b6257",
        brightRed: "#f05646",
        brightGreen: "#9ede93",
        brightYellow: "#e8b35a",
        brightBlue: "#89b4fa",
        brightMagenta: "#bb9af7",
        brightCyan: "#7dcfff",
        brightWhite: "#f0eae0",
      },
    });
    const fit = new FitAddon();
    const canvas = new CanvasAddon();
    term.loadAddon(canvas);
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;

    const unsub = store.onTermData(id, (_id, data) => {
      term.write(data);
    });

    const ro = new ResizeObserver(() => {
      try {
        if (!host.clientWidth || !host.clientHeight) return;
        fit.fit();
        const d = fit.proposeDimensions();
        if (d) termResize(id, d.cols, d.rows);
      } catch {
        /* not visible yet */
      }
    });
    ro.observe(host);
    try {
      fit.fit();
      const d = fit.proposeDimensions();
      if (d) termResize(id, d.cols, d.rows);
    } catch {
      /* skip */
    }

    const disp = term.onData((data) => termInput(id, data));
    const focusTerm = () => term.focus();
    focusTerm();
    const raf = requestAnimationFrame(focusTerm);
    host.addEventListener("pointerdown", focusTerm);

    return () => {
      cancelAnimationFrame(raf);
      host.removeEventListener("pointerdown", focusTerm);
      disp.dispose();
      ro.disconnect();
      unsub();
      term.dispose();
    };
  }, [id]);

  useEffect(() => {
    const run = () => setRunning(store.sessions.some((s) => s.id === id));
    const un = store.subscribe(run);
    return un;
  }, [id]);

  return (
    <div className={`term-pane ${minimized ? "minimized" : ""}`}>
      <div className="term-tab">
        <span className="term-dot" style={{ background: running ? "#d62f22" : "#6b6257" }} />
        <span className="term-title">{title}</span>
        <span className="term-id">{id.slice(0, 8)}</span>
        <div className="term-tab-actions">
          <button className="icon-btn" title={minimized ? "expand" : "minimize"} onClick={() => setMinimized(!minimized)}>
            {minimized ? "▣" : "▁"}
          </button>
          <button
            className="icon-btn"
            title="close"
            onClick={() => {
              killTerm(id);
            }}
          >
            ×
          </button>
        </div>
      </div>
      <div className="term-body" style={{ display: minimized ? "none" : "flex" }}>
        <div className="term-host" ref={hostRef} />
      </div>
    </div>
  );
}

function useStore<T>(sel: (s: typeof store) => T): T {
  const [v, setV] = useState(() => sel(store));
  useEffect(() => store.subscribe(() => setV(sel(store))), []);
  return v;
}
