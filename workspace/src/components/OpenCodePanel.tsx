import { useEffect, useState } from "react";

type State =
  | { phase: "starting" }
  | { phase: "ready"; url: string }
  | { phase: "error"; msg: string };

export default function OpenCodePanel() {
  const [st, setSt] = useState<State>({ phase: "starting" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSt({ phase: "starting" });
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30000);
    fetch("/api/opencode/start", { method: "POST", signal: ctl.signal })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.running && d.url) setSt({ phase: "ready", url: d.url });
        else setSt({ phase: "error", msg: d.error || "failed to start" });
      })
      .catch((e) => {
        if (!cancelled) setSt({ phase: "error", msg: String(e) });
      })
      .finally(() => clearTimeout(t));
    return () => {
      cancelled = true;
      ctl.abort();
      clearTimeout(t);
    };
  }, [attempt]);

  return (
    <div className="panel opencode-panel">
      <div className="opencode-header">
        <span className="opencode-title">
          <span className="opencode-dot" /> OpenCode Web
        </span>
        {st.phase === "ready" && (
          <a className="opencode-link" href={st.url} target="_blank" rel="noreferrer">
            open in new tab ↗
          </a>
        )}
      </div>
      <div className="opencode-body">
        {st.phase === "starting" && (
          <div className="opencode-state">
            <i className="opencode-spin" /> starting opencode server…
          </div>
        )}
        {st.phase === "error" && (
          <div className="opencode-state error">
            <span>{st.msg}</span>
            <button className="ghost-btn" onClick={() => setAttempt((a) => a + 1)}>
              retry
            </button>
          </div>
        )}
        {st.phase === "ready" && <iframe className="opencode-frame" src={st.url} title="OpenCode Web" />}
      </div>
    </div>
  );
}
