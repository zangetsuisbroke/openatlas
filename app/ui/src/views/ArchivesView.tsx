import { useEffect, useMemo, useState } from "react";
import {
  api,
  fmtDur,
  fmtTime,
  fmtWhen,
  plural,
  KIND_COLORS,
  KIND_LABELS,
  type Scope,
  type SessionSummary,
  type StepDetail,
} from "../api";
import { EmptyState, IconArchive, IconDoc, IconSearch } from "../components";

interface Props {
  scope: Scope;
  pendingSession: string | null;
  onConsumePending: () => void;
}

export default function ArchivesView({ scope, pendingSession, onConsumePending }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [filter, setFilter] = useState("");
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [projectLabel, setProjectLabel] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ session: SessionSummary; steps: StepDetail[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSessionsLoading(true);
    setSessionsError(null);
    setSelectedId(null);
    api
      .sessions(scope)
      .then((res) => {
        if (!cancelled) {
          setSessions(res.sessions);
          setSessionsLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setSessionsError(err instanceof Error ? err.message : String(err));
          setSessionsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  useEffect(() => {
    let cancelled = false;
    if (scope !== "project") {
      setProjectLabel(null);
      return;
    }
    api
      .projects()
      .then((res) => {
        if (!cancelled) {
          const current = res.projects.find((p) => p.projectId === res.current);
          setProjectLabel(current?.label ?? res.current);
        }
      })
      .catch(() => {
        if (!cancelled) setProjectLabel(null);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  // Consume the pending id even when it matches the selection so a stale value
  // can't later yank the selection back after the user picks another session.
  useEffect(() => {
    if (pendingSession) {
      setSelectedId(pendingSession);
      onConsumePending();
    }
  }, [pendingSession, onConsumePending]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailLoading(false);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    api
      .session(selectedId, scope)
      .then((res) => {
        if (!cancelled) {
          setDetail(res);
          setDetailLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDetailError(err instanceof Error ? err.message : String(err));
          setDetailLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, scope]);

  const filteredSessions = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const sorted = [...sessions].sort((a, b) => b.startedAt - a.startedAt);
    if (!q) return sorted;
    return sorted.filter(
      (s) =>
        (s.title ?? "").toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        (s.summary ?? "").toLowerCase().includes(q),
    );
  }, [sessions, filter]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 16, alignItems: "start" }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
            {scope === "project" ? (projectLabel ? `Project: ${projectLabel}` : "Project archive") : "General archive"}
          </span>
        </div>
        <div className="recall-row" style={{ marginBottom: 12 }}>
          <IconSearch size={15} style={{ flexShrink: 0, color: "var(--text-faint)", alignSelf: "center" }} />
          <input
            type="search"
            placeholder="Filter sessions…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {sessionsLoading ? (
          <div className="loading">Loading sessions…</div>
        ) : sessionsError ? (
          <div className="error">{sessionsError}</div>
        ) : sessions.length === 0 ? (
          <div className="panel">
            <EmptyState
              icon={<IconArchive size={24} />}
              title="No sessions archived yet"
              body="As you use opencode, each session is distilled here with its full reasoning timeline."
            />
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="empty">No sessions match “{filter}”</div>
        ) : (
          filteredSessions.map((s) => {
            const selected = s.id === selectedId;
            return (
              <div
                key={s.id}
                className="list-item"
                style={selected ? { borderColor: "var(--accent)" } : undefined}
                onClick={() => setSelectedId(s.id)}
              >
                <div className="grow">
                  <div className="title">{s.title || "(untitled session)"}</div>
                  <div className="sub">
                    {fmtWhen(s.startedAt)} · {plural(s.stepCount, "step")} · {plural(s.errorCount, "error")}
                    {s.agent ? ` · ${s.agent}` : ""}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div>
        {detailLoading ? (
          <div className="loading">Loading session…</div>
        ) : detailError ? (
          <div className="error">{detailError}</div>
        ) : !detail ? (
          <div className="panel">
            <EmptyState
              icon={<IconDoc size={24} />}
              title="Select a session"
              body="Its full reasoning timeline — steps, files, errors and fixes — will appear here."
            />
          </div>
        ) : (
          <>
            <div className="panel">
              <h3>{detail.session.title || detail.session.id}</h3>
              {detail.session.summary ? (
                <p style={{ color: "var(--text-dim)", margin: "0 0 8px" }}>{detail.session.summary}</p>
              ) : null}
              <div style={{ color: "var(--text-dim)", marginBottom: 8 }}>
                {fmtTime(detail.session.startedAt)} — {fmtTime(detail.session.endedAt)}
              </div>
              <div className="step-meta" style={{ marginBottom: 12 }}>
                {detail.session.agent ? <span className="chip">{detail.session.agent}</span> : null}
                {detail.session.model ? <span className="chip">{detail.session.model}</span> : null}
              </div>
              <div className="stat-row">
                <div className="stat">
                  <div className="n">{detail.session.stepCount}</div>
                  <div className="l">Steps</div>
                </div>
                <div className="stat">
                  <div className="n">{detail.session.fileCount}</div>
                  <div className="l">Files</div>
                </div>
                <div className="stat">
                  <div className="n">{detail.session.errorCount}</div>
                  <div className="l">Errors</div>
                </div>
                {detail.session.endedAt != null ? (
                  <div className="stat">
                    <div className="n">{fmtDur(detail.session.endedAt - detail.session.startedAt)}</div>
                    <div className="l">Duration</div>
                  </div>
                ) : null}
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              {[...detail.steps]
                .sort((a, b) => a.seq - b.seq)
                .map((step) => {
                  const color = KIND_COLORS[step.kind] ?? "#8b93a3";
                  const kindLabel = KIND_LABELS[step.kind] ?? step.kind;
                  const oc = step.outcome?.toLowerCase();
                  const outcomeColor = oc
                    ? oc.includes("success")
                      ? "#22c55e"
                      : oc.includes("fail")
                        ? "#ef4444"
                        : undefined
                    : undefined;
                  const tool = typeof step.meta?.tool === "string" ? step.meta.tool : null;
                  const content = step.content?.trim() ? step.content : null;
                  return (
                    <div key={step.id} className="step" style={{ borderLeftColor: color }}>
                      <div className="step-head">
                        <span className="step-seq">#{step.seq}</span>
                        <span className={`badge kind-${step.kind}`}>{kindLabel}</span>
                        {step.role ? <span className="chip">{step.role}</span> : null}
                        {step.outcome ? (
                          <span
                            className="chip"
                            style={outcomeColor ? { color: outcomeColor, borderColor: outcomeColor } : undefined}
                          >
                            {step.outcome}
                          </span>
                        ) : null}
                        <span className="mono" style={{ marginLeft: "auto", color: "var(--text-faint)" }}>
                          {new Date(step.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="step-content" style={content ? undefined : { color: "var(--text-faint)" }}>
                        {content ?? "—"}
                      </div>
                      {step.files.length > 0 || step.links.length > 0 || tool ? (
                        <div className="step-meta">
                          {step.files.map((f, i) => (
                            <span key={`${i}-${f.path}`} className="chip">
                              {f.path} <span style={{ color: "var(--text-faint)" }}>({f.kind})</span>
                            </span>
                          ))}
                          {step.links.map((l, i) => (
                            <span key={`${i}-${l.relation}-${l.targetStepId}`} className="chip">
                              {l.relation} · {l.origin}
                            </span>
                          ))}
                          {tool ? <span className="chip">tool: {tool}</span> : null}
                        </div>
                      ) : null}
                      {step.payloads.map((p) => (
                        <details key={p.id} className="payload-block">
                          <summary>{p.kind}</summary>
                          <pre className="payload">{p.data}</pre>
                        </details>
                      ))}
                    </div>
                  );
                })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
