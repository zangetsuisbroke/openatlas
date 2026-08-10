import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmtBytes, fmtWhen, plural, type LogEntry, type Scope, type SessionSummary } from "../api";

interface Props {
  scope: Scope;
}

interface Viewer {
  sessionId: string;
  text: string;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function SessionsView({ scope }: Props) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const [viewerId, setViewerId] = useState<string | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const fetchSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setLogsLoading(true);
    setSessionsLoading(true);
    api
      .logs()
      .then((r) => {
        if (cancelled) return;
        setLogs(r.logs);
        setLogsError(null);
      })
      .catch((e) => {
        if (!cancelled) setLogsError(errMsg(e));
      })
      .finally(() => {
        if (!cancelled) setLogsLoading(false);
      });
    api
      .sessions(scope)
      .then((r) => {
        if (cancelled) return;
        setSessions(r.sessions);
        setSessionsError(null);
      })
      .catch((e) => {
        if (!cancelled) setSessionsError(errMsg(e));
      })
      .finally(() => {
        if (!cancelled) setSessionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const loadTranscript = useCallback(async (sessionId: string) => {
    const seq = ++fetchSeq.current;
    setViewerId(sessionId);
    setViewer(null);
    setViewerError(null);
    setViewerLoading(true);
    try {
      const res = await api.log(sessionId);
      if (seq !== fetchSeq.current) return;
      setViewer({ sessionId: res.sessionId, text: res.text });
    } catch (e) {
      if (seq !== fetchSeq.current) return;
      setViewerError(`No transcript for ${sessionId}: ${errMsg(e)}`);
    } finally {
      if (seq === fetchSeq.current) setViewerLoading(false);
    }
  }, []);

  const clearSelection = useCallback(() => {
    fetchSeq.current += 1;
    setViewerId(null);
    setViewer(null);
    setViewerError(null);
    setViewerLoading(false);
  }, []);

  const copy = useCallback(async () => {
    if (!viewer) return;
    try {
      await navigator.clipboard.writeText(viewer.text);
    } catch {
      // clipboard unavailable — ignore
    }
  }, [viewer]);

  const withTranscripts = useMemo(() => new Set(logs.map((l) => l.sessionId)), [logs]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 16, alignItems: "start" }}>
      <div>
        <div className="panel">
          <h3>Transcripts</h3>
          {logsLoading ? (
            <div className="loading">Loading transcripts…</div>
          ) : logsError ? (
            <div className="error">{logsError}</div>
          ) : logs.length === 0 ? (
            <div className="empty">No transcripts found</div>
          ) : (
            logs.map((log) => (
              <div
                key={log.sessionId}
                className="list-item"
                style={viewerId === log.sessionId ? { borderColor: "var(--accent)" } : undefined}
                onClick={() => void loadTranscript(log.sessionId)}
              >
                <div className="grow">
                  <div className="title mono">{log.sessionId}</div>
                  <div className="sub">
                    {fmtBytes(log.size)} · {fmtWhen(log.updatedAt)}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="panel">
          <h3>Sessions</h3>
          {sessionsLoading ? (
            <div className="loading">Loading sessions…</div>
          ) : sessionsError ? (
            <div className="error">{sessionsError}</div>
          ) : sessions.length === 0 ? (
            <div className="empty">No sessions found</div>
          ) : (
            sessions.map((s) => {
              const hasLog = withTranscripts.has(s.id);
              return (
                <div
                  key={s.id}
                  className="list-item"
                  style={{
                    ...(viewerId === s.id ? { borderColor: "var(--accent)" } : undefined),
                    ...(hasLog ? {} : { opacity: 0.55, cursor: "default" }),
                  }}
                  onClick={hasLog ? () => void loadTranscript(s.id) : undefined}
                  title={hasLog ? undefined : "No raw transcript recorded for this session"}
                >
                  <div className="grow">
                    <div className="title">{s.title || "(untitled)"}</div>
                    <div className="sub">
                      {fmtWhen(s.startedAt)} · {plural(s.stepCount, "step")} · {plural(s.fileCount, "file")}
                      {hasLog ? "" : " · no transcript"}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="panel">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          {viewerId ? (
            <>
              <span
                className="mono"
                style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {viewerId}
              </span>
              <button className="btn" disabled={!viewer} onClick={() => void copy()}>
                Copy
              </button>
              <button className="btn" onClick={clearSelection}>
                Clear selection
              </button>
            </>
          ) : (
            <h3>Transcript</h3>
          )}
        </div>
        {viewerLoading ? (
          <div className="loading">Loading transcript…</div>
        ) : viewerError ? (
          <div className="error">{viewerError}</div>
        ) : viewer ? (
          <div className="log-view">{viewer.text}</div>
        ) : (
          <div className="empty">Select a session or transcript</div>
        )}
      </div>
    </div>
  );
}
