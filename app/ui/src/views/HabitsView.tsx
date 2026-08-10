import { useEffect, useRef, useState } from "react";
import { api, fmtDur, type HabitReport, type Scope } from "../api";

function fmtRate(rate: number): string {
  const pct = Math.min(1, Math.max(0, rate));
  return `${(pct * 100).toFixed(1)}%`;
}

function flagClass(flag: string): string {
  if (flag.startsWith("rework:") || flag.startsWith("highErrorRate:")) return "bad";
  if (flag.startsWith("noTests")) return "warn";
  return "ok";
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="n">{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

function TopRow({ entry, max }: { entry: [string, number]; max: number }) {
  const [name, count] = entry;
  if (name == null || count == null) return null;
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="mono" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
        <span style={{ color: "var(--text-dim)" }}>{count}</span>
      </div>
      <div className="bar">
        <div style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function TopList({ label, entries }: { label: string; entries: Array<[string, number]> }) {
  const max = entries.reduce((m, e) => Math.max(m, e[1] ?? 0), 0);
  return (
    <div className="panel">
      <h3>{label}</h3>
      {entries.length === 0 ? (
        <div style={{ color: "var(--text-faint)" }}>—</div>
      ) : (
        entries.map((entry, i) => <TopRow key={i} entry={entry} max={max} />)
      )}
    </div>
  );
}

export default function HabitsView({ scope }: { scope: Scope }) {
  const [report, setReport] = useState<HabitReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<string | null>(null);
  const [summaryDim, setSummaryDim] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [sumError, setSumError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSummary(null);
    setSummaryDim(false);
    setSumError(null);
    api
      .habits(scope)
      .then((r) => {
        if (cancelled) return;
        setReport(r);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const summarizeSeq = useRef(0);

  const runSummary = async () => {
    const seq = ++summarizeSeq.current;
    setSummarizing(true);
    setSumError(null);
    try {
      const res = await api.summarize(scope);
      if (seq !== summarizeSeq.current) return;
      setSummary(res.summary);
      setSummaryDim(res.summary.startsWith("summarize unavailable"));
    } catch (e: unknown) {
      if (seq !== summarizeSeq.current) return;
      setSumError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === summarizeSeq.current) setSummarizing(false);
    }
  };

  if (loading) return <div className="loading">Loading habits…</div>;
  if (error) return <div className="error">{error}</div>;
  if (!report) return <div className="empty">No data</div>;

  const agg = report.aggregate;

  return (
    <>
      <header style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Habits</h2>
        <span className="badge" style={{ background: "#fbbf2422", color: "#fbbf24" }}>
          {scope === "project" ? "Project" : "General"}
        </span>
        <span className="chip">{report.sessionCount} sessions</span>
      </header>

      <div className="stat-row" style={{ marginBottom: agg.flags.length > 0 ? 12 : 16 }}>
        <Stat label="Sessions" value={String(report.sessionCount)} />
        <Stat label="Steps" value={String(agg.stepCount)} />
        <Stat label="Tool calls" value={String(agg.toolCount)} />
        <Stat label="Errors" value={String(agg.errorCount)} />
        <Stat label="Error rate" value={fmtRate(agg.errorRate)} />
      </div>

      {agg.flags.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
          <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.5px", color: "var(--text-faint)" }}>
            top flags
          </span>
          {agg.flags.map((f) => (
            <span key={f} className={`flag ${flagClass(f)}`}>
              {f}
            </span>
          ))}
        </div>
      )}

      <div className="panel" style={{ marginBottom: 16 }}>
        <h3>Signals</h3>
        {agg.flags.length === 0 ? (
          <span className="flag ok">no red flags</span>
        ) : (
          agg.flags.map((f) => (
            <span key={f} className={`flag ${flagClass(f)}`}>
              {f}
            </span>
          ))
        )}
      </div>

      <div className="grid-2" style={{ marginBottom: 16 }}>
        <TopList label="Top tools" entries={agg.topTools} />
        <TopList label="Top files" entries={agg.topFiles} />
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <h3>Summarize</h3>
        <button className="btn primary" onClick={runSummary} disabled={summarizing}>
          {summarizing ? "…" : "Summarize habits (opencode model)"}
        </button>
        {sumError && <div style={{ color: "var(--danger)", marginTop: 10 }}>{sumError}</div>}
        {summary && (
          <pre
            style={{
              whiteSpace: "pre-wrap",
              margin: "12px 0 0",
              background: "#0d0f11",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              padding: 12,
              color: summaryDim ? "var(--text-dim)" : "#c9d1d9",
            }}
          >
            {summary}
          </pre>
        )}
      </div>

      <div className="panel">
        <h3>Sessions</h3>
        {report.signals.length === 0 ? (
          <div className="empty">No sessions analyzed yet</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Steps</th>
                  <th>Tools</th>
                  <th>Errors</th>
                  <th>Err %</th>
                  <th>Tests</th>
                  <th>Rework files</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {report.signals.map((s) => (
                  <tr key={s.sessionId}>
                    <td>
                      <span className="mono" style={{ color: "var(--text-dim)" }}>
                        {s.title || s.sessionId}
                      </span>
                    </td>
                    <td>{s.stepCount}</td>
                    <td>{s.toolCount}</td>
                    <td>{s.errorCount}</td>
                    <td>{fmtRate(s.errorRate)}</td>
                    <td>{s.testsRun.length > 0 ? s.testsRun.join(", ") : "—"}</td>
                    <td>{s.reworkFiles.length > 0 ? s.reworkFiles.join(", ") : "—"}</td>
                    <td className="mono">{fmtDur(s.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
