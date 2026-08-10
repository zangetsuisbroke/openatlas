import type { ClientMsg, GLink, GNode, ServerMsg, StreamEvent } from "./types";

type TermHandler = (id: string, data: string) => void;

interface TermSessionInfo {
  id: string;
  shell: string;
  title: string;
}

class Store {
  connected = false;
  events: StreamEvent[] = [];
  nodes = new Map<string, GNode>();
  links = new Map<string, GLink>();
  sessions: TermSessionInfo[] = [];
  pulses = new Map<string, number>();
  pulsesVersion = 0;
  graphVersion = 0;
  eventVersion = 0;
  termHandlers = new Map<string, Set<TermHandler>>();
  termBuf = new Map<string, string[]>();

  private listeners = new Set<() => void>();
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  emit() {
    for (const l of this.listeners) l();
  }

  onTermData(id: string, fn: TermHandler) {
    let set = this.termHandlers.get(id);
    if (!set) {
      set = new Set();
      this.termHandlers.set(id, set);
    }
    set.add(fn);
    const buf = this.termBuf.get(id);
    if (buf) for (const chunk of buf) fn(id, chunk);
    return () => {
      set!.delete(fn);
    };
  }

  graphSnapshot(): { nodes: GNode[]; links: GLink[] } {
    return { nodes: [...this.nodes.values()], links: [...this.links.values()] };
  }

  applyGraph(nodes: GNode[], links: GLink[], replace = false) {
    const linkKey = (l: GLink) => `${l.source}→${l.target}#${l.relation}`;
    if (replace) {
      this.nodes = new Map();
      this.links = new Map();
    }
    for (const n of nodes) this.nodes.set(n.id, n);
    for (const l of links) this.links.set(linkKey(l), l);
    this.graphVersion++;
    this.emit();
  }

  pushEvent(ev: StreamEvent) {
    this.events = [ev, ...this.events].slice(0, 300);
    this.eventVersion++;
    this.emit();
  }

  pulse(nodeId: string, at: number) {
    if (this.pulses.size > 500) {
      const cutoff = Date.now() - 30000;
      for (const [id, t] of this.pulses) if (t < cutoff) this.pulses.delete(id);
    }
    this.pulses.set(nodeId, at);
    this.pulsesVersion++;
    this.emit();
  }

  addSession(info: TermSessionInfo) {
    if (!this.sessions.some((s) => s.id === info.id)) this.sessions = [...this.sessions, info];
    this.emit();
  }

  removeSession(id: string) {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.termHandlers.delete(id);
    this.termBuf.delete(id);
    this.emit();
  }

  syncSessions() {
    this.sessions = [];
    for (const id of [...this.termBuf.keys()]) this.termBuf.delete(id);
    this.emit();
  }

  bufferTermData(id: string, data: string) {
    let buf = this.termBuf.get(id);
    if (!buf) {
      buf = [];
      this.termBuf.set(id, buf);
    }
    buf.push(data);
    if (buf.length > 200) buf.splice(0, buf.length - 200);
  }
}

export const store = new Store();

let ws: WebSocket | null = null;
const outbox: ClientMsg[] = [];

export function send(msg: ClientMsg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else if (outbox.length < 100) {
    outbox.push(msg);
  }
}

function handle(msg: ServerMsg) {
  switch (msg.type) {
        case "hello":
      store.connected = true;
      store.applyGraph(msg.data.nodes, msg.data.links, true);
      store.syncSessions();
      break;    case "event":
      store.pushEvent(msg.data);
      break;
    case "graph":
      store.applyGraph(msg.data.nodes, msg.data.links);
      break;
    case "pulse":
      store.pulse(msg.data.nodeId, msg.data.at);
      break;
    case "term:create":
      store.addSession(msg.data);
      break;
    case "term:exit":
      store.removeSession(msg.data.id);
      break;
    case "term:data": {
      store.bufferTermData(msg.data.id, msg.data.data);
      const set = store.termHandlers.get(msg.data.id);
      if (set) for (const fn of set) fn(msg.data.id, msg.data.data);
      break;
    }
  }
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryMs = 500;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
const PULSE_MS = 25000;

export function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => {
    store.connected = true;
    retryMs = 500;
    store.emit();
    while (outbox.length) ws?.send(JSON.stringify(outbox.shift()));
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      send({ type: "ping" });
    }, PULSE_MS);
  };
  ws.onmessage = (ev) => {
    try {
      handle(JSON.parse(ev.data) as ServerMsg);
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => {
    store.connected = false;
    store.emit();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 15000) + Math.random() * 1000;
  };
  ws.onerror = () => {
    ws?.close();
  };
}

export function newTerm() {
  send({ type: "term:create" });
}
export function killTerm(id: string) {
  send({ type: "term:kill", id });
}
export function termInput(id: string, data: string) {
  send({ type: "term:input", id, data });
}
export function termResize(id: string, cols: number, rows: number) {
  send({ type: "term:resize", id, cols, rows });
}
export function graphReset() {
  send({ type: "graph:reset" });
}
export function runDemo() {
  send({ type: "demo:run" });
}
