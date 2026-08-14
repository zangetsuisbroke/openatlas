import { useEffect, useState } from "react";
import TopBar, { type LayoutMode } from "./components/TopBar";
import GraphPanel from "./components/GraphPanel";
import EventStream from "./components/EventStream";
import TerminalsPanel from "./components/TerminalsPanel";
import OpenCodePanel from "./components/OpenCodePanel";
import { connect } from "./ws";

const ACCENT_VARS: Record<string, { a: string; a2: string }> = {
  ember: { a: "#d62f22", a2: "#7a120c" },
  cyan: { a: "#4fd8e8", a2: "#2b8aa8" },
  amber: { a: "#e8b35a", a2: "#b07a2b" },
};

export default function App() {
  const [layout, setLayout] = useState<LayoutMode>("split");
  const [accent, setAccent] = useState("ember");

  useEffect(() => {
    connect();
  }, []);

  useEffect(() => {
    const v = ACCENT_VARS[accent] ?? ACCENT_VARS.ember;
    const root = document.documentElement.style;
    root.setProperty("--accent", v.a);
    root.setProperty("--accent-2", v.a2);
  }, [accent]);

  return (
    <div className="app">
      <TopBar
        layout={layout}
        onLayout={setLayout}
        accent={accent}
        onAccent={setAccent}
      />
      {layout === "split" && (
        <div className="main split">
          <div className="col-left">
            <GraphPanel />
            <EventStream />
          </div>
          <div className="col-right">
            <TerminalsPanel />
          </div>
        </div>
      )}
      {layout === "graph" && (
        <div className="main graph-max">
          <div className="col-left">
            <GraphPanel />
            <EventStream />
          </div>
        </div>
      )}
      {layout === "terminal" && (
        <div className="main term-max">
          <TerminalsPanel />
        </div>
      )}
      {layout === "opencode" && (
        <div className="main opencode-max">
          <OpenCodePanel />
        </div>
      )}
    </div>
  );
}
