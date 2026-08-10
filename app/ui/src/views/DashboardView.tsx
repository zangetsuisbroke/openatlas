import { useCallback, useEffect, useState } from "react";
import {
  api,
  fmtWhen,
  plural,
  KIND_LABELS,
  type Scope,
  type SessionSummary,
  type Stats,
} from "../api";
import { EmptyState, IconArchive, IconArrow, IconChart, IconPulse, IconSearch, IconSpark, Stat } from "../components";

interface Props {
  scope: Scope;
  harness: boolean;
  version: string;
  onOpenSession: (id: string) => void;
  onSearch: (query: string) => void;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function DashboardView({ scope, harness, version, onOpenSession, onSearch }: Props) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [query, setQuery] = useState("");
  const [projectLabel, setProjectLabel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api.stats(scope), api.sessions(scope), scope === "project" ? api.projects() : null])
      .then(([s, sess, proj]) => {
        if (cancelled) return;
        setStats(s.stats);
        setSessions(sess.sessions ?? []);
        if (proj) {
          const current = proj.projects.find((p) => p.projectId === proj.current);
          setProjectLabel(current?.label ?? proj.current);
        }
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(errMsg(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const submitSearch = useCallback(() => {
    const q = query.trim();
    if (q) onSearch(q);
  }, [query, onSearch]);

  const recent = [...(sessions ?? [])].sort((a, b) => b.startedAt - a.startedAt).slice(0, 6);

  if (loading) return <div className="loading">Loading dashboard…</div>;
  if (error) return <div className="error">{error}</div>;

  const empty = !stats || stats.sessions === 0;

  return (
    <div className="dash">
      <div className="dash-hero">
        <div className="dash-title">
          <div className="dash-eyebrow">{scope === "project" ? (projectLabel ? `Project · ${projectLabel}` : "Project") : "General · cross-project memory"}</div>
          <h1>Your reasoning, archived.</h1>
          <p>
            openatlas watches your opencode sessions and distills them into a searchable graph — steps,
            files, errors, fixes and lessons you can revisit anytime.
          </p>
        </div>
        <div className={`status-pill ${harness ? "up" : "down"}`} title={harness ? "opencode is connected" : "opencode is not connected"}>
          <IconPulse size={15} />
          <span>{harness ? "opencode connected" : "opencode offline"}</span>
          {version && <span className="status-ver">v{version}</span>}
        </div>
      </div>

      {!harness && !empty && (
        <div className="notice warn">
          <strong>opencode is offline.</strong> openatlas still shows everything captured so far. To keep
          capturing, make sure the opencode server openatlas watches is reachable (OPENATLAS_OC_URL).
        </div>
      )}

      <div className="recall-card">
        <div className="recall-title">
          <IconSearch size={17} />
          <span>Search your reasoning archive</span>
        </div>
        <div className="recall-row">
          <input
            type="search"
            placeholder="Try: why did the tests fail, how was X fixed, anything about Y…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitSearch();
            }}
          />
          <button className="btn primary" disabled={!query.trim()} onClick={submitSearch}>
            Search
          </button>
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="Sessions" value={stats?.sessions ?? 0} />
        <Stat label="Active (24h)" value={stats?.activeSessions24h ?? 0} />
        <Stat label="Steps" value={stats?.steps ?? 0} />
        <Stat label="Files touched" value={stats?.files ?? 0} />
        <Stat label="Errors" value={stats?.errors ?? 0} tone={(stats?.errors ?? 0) > 0 ? "danger" : "ok"} />
        <Stat label="Fixes" value={stats?.fixes ?? 0} tone="accent" />
        <Stat label="Lessons" value={stats?.lessons ?? 0} tone="accent" />
        <Stat label="Links" value={stats?.links ?? 0} />
      </div>

      {stats && (stats.stepsByKind ? Object.keys(stats.stepsByKind).length > 0 : false) && (
        <div className="panel kind-strip">
          <h3>Reasoning by kind</h3>
          <div className="kind-bars">
            {Object.entries(stats.stepsByKind)
              .sort((a, b) => b[1] - a[1])
              .map(([kind, count]) => (
                <div className="kind-bar" key={kind}>
                  <span className="kind-bar-label">{KIND_LABELS[kind] ?? kind}</span>
                  <span className="kind-bar-count">{count}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {empty ? (
        <div className="panel">
          <EmptyState
            tone="ok"
            icon={<IconSpark size={26} />}
            title="Nothing captured yet — that's expected."
            body={
              <div className="onboard-steps">
                <div className="onboard-step">
                  <span className="onboard-num">1</span>
                  <span>
                    Use <strong>opencode</strong> as you normally would in this project — the harness server
                    openatlas watches is already connected.
                  </span>
                </div>
                <div className="onboard-step">
                  <span className="onboard-num">2</span>
                  <span>
                    Each session is distilled into a <strong>reasoning graph</strong> of steps, decisions,
                    errors and fixes, with the files it touched.
                  </span>
                </div>
                <div className="onboard-step">
                  <span className="onboard-num">3</span>
                  <span>
                    Come back here to <strong>search</strong> the archive, review habits, and replay any
                    session transcript.
                  </span>
                </div>
              </div>
            }
          />
        </div>
      ) : (
        <div className="panel">
          <div className="panel-head">
            <h3>
              <IconArchive size={16} /> Recent sessions
            </h3>
            <span className="panel-hint">{stats?.sessions ?? 0} total</span>
          </div>
          {recent.length === 0 ? (
            <div className="empty">No sessions found</div>
          ) : (
            <div className="recent-list">
              {recent.map((s) => (
                <div key={s.id} className="recent-item" onClick={() => onOpenSession(s.id)} role="button">
                  <span className="recent-dot" style={{ background: s.errorCount > 0 ? "var(--danger)" : "var(--ok)" }} />
                  <div className="recent-body">
                    <div className="recent-title">{s.title || "(untitled session)"}</div>
                    <div className="recent-sub">
                      {fmtWhen(s.startedAt)} · {plural(s.stepCount, "step")} · {plural(s.fileCount, "file")}
                      {s.errorCount > 0 ? ` · ${plural(s.errorCount, "error")}` : ""}
                      {scope === "general" && s.projectLabel ? ` · ${s.projectLabel}` : ""}
                    </div>
                  </div>
                  <IconArrow size={14} className="recent-arrow" />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
