import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, type Scope } from "./api";
import DashboardView from "./views/DashboardView";
import RecallView from "./views/RecallView";
import GraphView from "./views/GraphView";
import ArchivesView from "./views/ArchivesView";
import HabitsView from "./views/HabitsView";
import SessionsView from "./views/SessionsView";
import ChatView from "./views/ChatView";
import { IconArchive, IconChart, IconChat, IconClock, IconNetwork, IconSearch, IconSpark } from "./components";

type Tab = "dashboard" | "search" | "chat" | "graph" | "archives" | "habits" | "logs";

const NAV: Array<{ id: Tab; label: string; icon: (p: { size?: number }) => ReactNode }> = [
  { id: "dashboard", label: "Home", icon: IconChart },
  { id: "search", label: "Search", icon: IconSearch },
  { id: "chat", label: "Chat", icon: IconChat },
  { id: "graph", label: "Reasoning Graph", icon: IconNetwork },
  { id: "archives", label: "Archives", icon: IconArchive },
  { id: "habits", label: "Habits", icon: IconSpark },
  { id: "logs", label: "Sessions & Logs", icon: IconClock },
];

const TAB_TITLES: Record<Tab, string> = {
  dashboard: "Home",
  search: "Search",
  chat: "Chat",
  graph: "Reasoning Graph",
  archives: "Archives",
  habits: "Habits",
  logs: "Sessions & Logs",
};

export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [scope, setScope] = useState<Scope>("project");
  const [pendingSession, setPendingSession] = useState<string | null>(null);
  const [pendingQuery, setPendingQuery] = useState<string>("");
  const [version, setVersion] = useState<string>("");
  const [harness, setHarness] = useState(false);
  const [health, setHealth] = useState<string>("connecting…");

  const checkHealth = useCallback(() => {
    api
      .health()
      .then((h) => {
        setVersion(h.version);
        setHarness(!!h.harness?.started);
        setHealth("connected");
      })
      .catch(() => {
        setHealth("offline");
        setHarness(false);
      });
  }, []);

  useEffect(() => {
    checkHealth();
    const t = setInterval(checkHealth, 15000);
    return () => clearInterval(t);
  }, [checkHealth]);

  const openSession = useCallback((id: string) => {
    setPendingSession(id);
    setTab("archives");
  }, []);

  const openSearch = useCallback((query: string) => {
    setPendingQuery(query);
    setTab("search");
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          open<span>atlas</span>
        </div>
        <div className="nav-scroll">
          {NAV.map((n) => {
            const Icon = n.icon;
            return (
              <button key={n.id} className={`nav-item ${tab === n.id ? "active" : ""}`} onClick={() => setTab(n.id)} title={n.label}>
                <span className="nav-icon"><Icon size={15} /></span>
                {n.label}
              </button>
            );
          })}
        </div>
        <div className="spacer" />
        <div className="foot">
          <span className={`health-dot ${health === "connected" ? (harness ? "ok" : "warn") : "off"}`} />
          <span>{health === "connected" ? (harness ? "connected" : "opencode offline") : health}</span>
          {version && ` · v${version}`}
        </div>
      </aside>

      <header className="topbar">
        <div className="topbar-title">
          <h1>{TAB_TITLES[tab]}</h1>
          <span className="topbar-scope">
            {scope === "project" ? "this project's reasoning" : "cross-project distilled memory"}
          </span>
        </div>
        <div className="topbar-right">
          <div className="seg" role="tablist" aria-label="scope">
            <button className={scope === "project" ? "active" : ""} onClick={() => setScope("project")}>
              Project
            </button>
            <button className={scope === "general" ? "active" : ""} onClick={() => setScope("general")}>
              General
            </button>
          </div>
        </div>
      </header>

      <main className="content">
        {tab === "dashboard" && (
          <DashboardView scope={scope} harness={harness} version={version} onOpenSession={openSession} onSearch={openSearch} />
        )}
        {tab === "search" && (
          <RecallView scope={scope} initialQuery={pendingQuery} onConsumeQuery={() => undefined} onOpenSession={openSession} />
        )}
        {tab === "chat" && <ChatView scope={scope} />}
        {tab === "graph" && <GraphView scope={scope} onOpenSession={openSession} />}
        {tab === "archives" && (
          <ArchivesView scope={scope} pendingSession={pendingSession} onConsumePending={() => setPendingSession(null)} />
        )}
        {tab === "habits" && <HabitsView scope={scope} />}
        {tab === "logs" && <SessionsView scope={scope} />}
      </main>
    </div>
  );
}
