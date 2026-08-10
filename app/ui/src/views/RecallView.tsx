import { useCallback, useEffect, useState } from "react";
import {
  api,
  KIND_LABELS,
  type RecallChain,
  type RecallStep,
  type Scope,
} from "../api";
import { EmptyState, IconBook, IconSearch, IconWarn } from "../components";

interface Props {
  scope: Scope;
  initialQuery: string;
  onConsumeQuery: () => void;
  onOpenSession: (id: string) => void;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function kindTone(kind: string): string {
  if (kind === "error") return "danger";
  if (kind === "fix") return "ok";
  if (kind === "lesson") return "accent";
  return "";
}

function StepRow({ step }: { step: RecallStep }) {
  const [open, setOpen] = useState(false);
  const text = (step.content ?? "").trim();
  if (!text) return null;
  const preview = text.length > 180 ? text.slice(0, 180) + "…" : text;
  return (
    <div className={`recall-step ${open ? "open" : ""}`} onClick={() => setOpen((v) => !v)} role="button">
      <span className={`badge kind-${step.kind}`}>{KIND_LABELS[step.kind] ?? step.kind}</span>
      <span className={`recall-step-text ${kindTone(step.kind)}`}>{open ? text : preview}</span>
    </div>
  );
}

function ChainCard({ chain, onOpenSession }: { chain: RecallChain; onOpenSession: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  const sessionId = chain.steps.find((s) => s.sessionId)?.sessionId ?? null;
  const summary =
    chain.outcome ??
    chain.lessons[0]?.content ??
    (chain.steps.length > 0 ? chain.steps[0]?.content : null);
  return (
    <div className="panel recall-chain">
      <div className="recall-chain-head">
        <div className="recall-query">{chain.query}</div>
        <span className="badge recall-score" title="recall score">score {Math.round(chain.score * 100)}%</span>
        <button className="btn ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Collapse" : "Expand"}
        </button>
      </div>
      {summary && <div className="recall-summary">{summary.length > 220 ? summary.slice(0, 220) + "…" : summary}</div>}
      {open && (
        <>
          <div className="recall-meta">
            {chain.files.length > 0 && (
              <span className="chip" title="files touched">
                {chain.files.length} file{chain.files.length === 1 ? "" : "s"}
              </span>
            )}
            {chain.rootCauses.length > 0 && (
              <span className="flag bad">{chain.rootCauses.length} root cause{chain.rootCauses.length === 1 ? "" : "s"}</span>
            )}
            {chain.lessons.length > 0 && (
              <span className="flag ok">{chain.lessons.length} lesson{chain.lessons.length === 1 ? "" : "s"}</span>
            )}
          </div>
          <div className="recall-steps">
            {chain.steps.map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
          </div>
          {chain.rootCauses.length > 0 && (
            <div className="recall-block">
              <span className="recall-block-label">
                <IconWarn size={13} /> Root causes
              </span>
              {chain.rootCauses.map((rc) => (
                <div key={rc.id} className="recall-block-line">{rc.content}</div>
              ))}
            </div>
          )}
          {chain.lessons.length > 0 && (
            <div className="recall-block">
              <span className="recall-block-label">
                <IconBook size={13} /> Lessons
              </span>
              {chain.lessons.map((l) => (
                <div key={l.id} className="recall-block-line">{l.content}</div>
              ))}
            </div>
          )}
        </>
      )}
      {sessionId && (
        <button className="btn primary recall-open" onClick={() => onOpenSession(sessionId)}>
          Open in Archives
        </button>
      )}
    </div>
  );
}

export default function RecallView({ scope, initialQuery, onConsumeQuery, onOpenSession }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [submitted, setSubmitted] = useState(initialQuery);
  const [chains, setChains] = useState<RecallChain[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onConsumeQuery();
  }, [onConsumeQuery]);

  useEffect(() => {
    setQuery(initialQuery);
    setSubmitted(initialQuery);
    setChains(null);
  }, [initialQuery, scope]);

  const run = useCallback(async (q: string) => {
    const text = q.trim();
    setSubmitted(text);
    setError(null);
    if (!text) {
      setChains([]);
      return;
    }
    setLoading(true);
    setChains(null);
    try {
      const res = await api.recall(text, "", 5, scope);
      setChains(res.chains);
    } catch (e: unknown) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [scope]);

  return (
    <div className="search-view">
      <div className="recall-card">
        <div className="recall-title">
          <IconSearch size={17} />
          <span>Search your reasoning archive</span>
        </div>
        <div className="recall-row">
          <input
            type="search"
            autoFocus
            placeholder="Ask anything about past sessions — e.g. “why did the build fail”"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run(query);
            }}
          />
          <button className="btn primary" disabled={!query.trim() || loading} onClick={() => void run(query)}>
            {loading ? "Searching…" : "Search"}
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="loading">Retracing reasoning chains…</div>}
      {!loading && !error && chains !== null && chains.length === 0 && (
        <div className="panel">
          <EmptyState
            tone="warn"
            icon={<IconSearch size={24} />}
            title="No matches found"
            body="Try different wording, or search for a file or tool name you remember."
          />
        </div>
      )}
      {!loading && !error && chains !== null && chains.length > 0 && (
        <div className="recall-list">
          {chains.map((c, i) => (
            <ChainCard key={`${c.anchorStepId ?? i}`} chain={c} onOpenSession={onOpenSession} />
          ))}
        </div>
      )}
    </div>
  );
}
