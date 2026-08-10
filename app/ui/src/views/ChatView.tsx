import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtWhen, type ChatMessage, type ChatPart, type ChatSession, type Scope } from "../api";
import { IconChat, IconWarn } from "../components";

interface Props {
  scope: Scope;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  return `${(n / 1024).toFixed(1)}KB`;
}

function partText(part: { type?: string; text?: string }): string {
  return part.text ?? "";
}

function ToolCall({ part }: { part: ChatPart }) {
  const [open, setOpen] = useState(false);
  const state = (part.state ?? {}) as { status?: string; input?: unknown; output?: unknown; error?: unknown; title?: string };
  const inputStr = state.input ? JSON.stringify(state.input) : "";
  const outputStr = state.output ? JSON.stringify(state.output) : "";
  const errStr = state.error ? JSON.stringify(state.error) : "";
  const preview = (inputStr || outputStr || errStr).slice(0, 90);
  return (
    <div className={`chat-tool ${state.status ?? ""}`} onClick={() => setOpen((v) => !v)} role="button">
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className="mono" style={{ color: "var(--accent)" }}>{part.tool ?? "tool"}</span>
        <span className="chip">{state.status ?? "pending"}</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--text-faint)", fontSize: 11 }}>{open ? "hide" : "show"}</span>
      </div>
      {!open && preview && <div className="mono" style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 4 }}>{preview}</div>}
      {open && (
        <div className="chat-tool-detail">
          {inputStr && (
            <>
              <div className="chat-tool-label">input</div>
              <pre className="log-view">{inputStr}</pre>
            </>
          )}
          {outputStr && (
            <>
              <div className="chat-tool-label">output</div>
              <pre className="log-view">{fmtSize(outputStr.length)} · {outputStr.slice(0, 2000)}</pre>
            </>
          )}
          {errStr && (
            <>
              <div className="chat-tool-label">error</div>
              <pre className="log-view">{errStr.slice(0, 2000)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.info.role === "user";
  const texts = msg.parts.filter((p) => p.type === "text").map(partText).join("\n");
  const reasoning = msg.parts.filter((p) => p.type === "reasoning").map(partText).join("\n");
  const tools = msg.parts.filter((p) => p.type === "tool");
  const [showReasoning, setShowReasoning] = useState(false);
  return (
    <div className={`chat-msg ${isUser ? "user" : "assistant"}`}>
      <div className="chat-role">{isUser ? "You" : msg.info.agent || "assistant"}</div>
      {reasoning && (
        <div className="chat-reasoning">
          <button className="btn" onClick={() => setShowReasoning((v) => !v)}>
            {showReasoning ? "Hide reasoning" : "Show reasoning"}
          </button>
          {showReasoning && <pre className="log-view">{reasoning}</pre>}
        </div>
      )}
      {texts && <div className="chat-text">{texts}</div>}
      {tools.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
          {tools.map((t, i) => (
            <ToolCall key={t.id ?? i} part={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function firstUserText(msg: ChatMessage): string {
  return msg.parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => (p.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

export default function ChatView({ scope }: Props) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [derived, setDerived] = useState<Record<string, string>>({});
  const [harnessUp, setHarnessUp] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const r = await api.chat.listSessions();
      setSessions(r.sessions);
      setHarnessUp(r.harnessUp);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    setLoadingMsgs(true);
    try {
      const r = await api.chat.messages(id);
      setMessages(r.messages);
      const firstUser = r.messages.find((m) => m.info.role === "user" && firstUserText(m).length > 0);
      if (firstUser) {
        const t = firstUserText(firstUser);
        setDerived((prev) => (prev[id] === t ? prev : { ...prev, [id]: t.length > 90 ? t.slice(0, 87) + "…" : t }));
      }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoadingMsgs(false);
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    if (!activeId) return;
    void loadMessages(activeId);
  }, [activeId, loadMessages, scope]);

  useEffect(() => {
    const off = api.chat.events((type, props) => {
      const sid = typeof props.sessionID === "string" ? props.sessionID : null;
      if (type === "session.created" || type === "session.updated" || type === "session.deleted") void refreshSessions();
      if (sid && sid === activeId && (type === "message.updated" || type === "message.part.updated" || type === "session.next.step.started" || type === "session.idle")) {
        void loadMessages(sid);
      }
    });
    return off;
  }, [activeId, refreshSessions, loadMessages]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loadingMsgs]);

  useEffect(() => {
    if (sending && !pollRef.current) {
      pollRef.current = setInterval(() => {
        if (activeId) void loadMessages(activeId);
      }, 1500);
    } else if (!sending && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [sending, activeId, loadMessages]);

  const newSession = async () => {
    try {
      setError(null);
      const r = await api.chat.createSession();
      const s = r.session;
      setSessions((prev) => [s, ...prev.filter((x) => x.id !== s.id)]);
      setActiveId(s.id);
      setMessages([]);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const selectSession = (id: string) => {
    setActiveId(id);
    setMessages([]);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !activeId || sending) return;
    setInput("");
    setSending(true);
    try {
      setError(null);
      await api.chat.send(activeId, text);
      await loadMessages(activeId);
      setTimeout(() => setSending(false), 3000);
    } catch (e) {
      setSending(false);
      setError(errMsg(e));
    }
  };

  return (
    <div className="chat" style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 16, height: "100%", minHeight: 0 }}>
      <div className="panel" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Sessions</h3>
          <button className="btn primary" disabled={!harnessUp} onClick={() => void newSession()}>
            + New chat
          </button>
        </div>
        {!harnessUp && (
          <div className="notice warn" style={{ marginBottom: 8 }}>
            <IconWarn size={14} />
            <span>
              opencode server not reachable. Start opencode with its server enabled, or check OPENATLAS_OC_URL /
              OPENATLAS_OC_PORT, then refresh.
            </span>
          </div>
        )}
        <div style={{ overflow: "auto", flex: 1 }}>
          {loadingList ? (
            <div className="loading">Loading sessions…</div>
          ) : error && sessions.length === 0 ? (
            <div className="error">{error}</div>
          ) : sessions.length === 0 ? (
            <div className="empty">
              {harnessUp ? (
                <>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                    <IconChat size={26} style={{ color: "var(--text-faint)" }} />
                    <div>No chats yet — start one</div>
                    <button className="btn primary" onClick={() => void newSession()}>+ New chat</button>
                  </div>
                </>
              ) : (
                <div>No chats found</div>
              )}
            </div>
          ) : (
            sessions.map((s) => {
              const derivedTitle = derived[s.id];
              const title = s.title || derivedTitle || "(untitled)";
              const created = s.time?.created;
              return (
                <div
                  key={s.id}
                  className="list-item"
                  style={activeId === s.id ? { borderColor: "var(--accent)" } : undefined}
                  onClick={() => selectSession(s.id)}
                >
                  <div className="grow">
                    <div className={`title ${s.title ? "" : "derived"}`} title={title}>{title}</div>
                    <div className="sub">
                      {created ? fmtWhen(created) : "recent"} · <span className="mono">{s.id.slice(0, 16)}…</span>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="panel" style={{ display: "flex", flexDirection: "column", minHeight: 0, padding: 0, overflow: "hidden" }}>
        {!activeId ? (
          <div className="empty" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {harnessUp ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                <IconChat size={30} style={{ color: "var(--text-faint)" }} />
                <div>Select a chat or create a new one</div>
              </div>
            ) : (
              "Connect opencode to start a chat"
            )}
          </div>
        ) : (
          <>
            <div className="chat-header">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="chat-title">{sessions.find((s) => s.id === activeId)?.title || derived[activeId] || "Chat"}</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>{activeId}</div>
              </div>
              <button className="btn" disabled={!sending} onClick={() => void api.chat.abort(activeId).then(() => setSending(false)).catch(() => undefined)}>
                Abort
              </button>
            </div>
            <div className="chat-thread" ref={threadRef}>
              {loadingMsgs && messages.length === 0 ? (
                <div className="loading">Loading messages…</div>
              ) : messages.length === 0 ? (
                <div className="empty">
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                    <IconChat size={26} style={{ color: "var(--text-faint)" }} />
                    <div>Send a message to get started</div>
                  </div>
                </div>
              ) : (
                messages.map((m) => <MessageBubble key={m.info.id} msg={m} />)
              )}
              {sending && <div className="chat-typing">working…</div>}
            </div>
            {error && <div className="error" style={{ padding: 8 }}>{error}</div>}
            <div className="chat-input">
              <textarea
                rows={2}
                value={input}
                placeholder="Ask opencode to do something…"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <button className="btn primary" disabled={!input.trim() || !activeId || sending} onClick={() => void send()}>
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
