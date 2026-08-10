const ws = new WebSocket("ws://localhost:4819/ws");
let termId = null;
const log = [];
let events = 0;
let graphs = 0;
let pulses = 0;

const timer = setTimeout(() => {
  console.log("SUMMARY", JSON.stringify({ termId, events, graphs, pulses }));
  console.log("LAST_LOG", JSON.stringify(log.slice(-30)));
  ws.close();
  process.exit(0);
}, 15000);

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "term:create" }));
};

function send(cmd) {
  setTimeout(() => {
    ws.send(JSON.stringify({ type: "term:input", id: termId, data: cmd + "\r" }));
  }, 300);
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "hello") log.push("HELLO nodes=" + msg.data.nodes.length);
  if (msg.type === "term:create") {
    termId = msg.data.id;
    log.push("TERM=" + msg.data.shell);
    send("ls");
  }
  if (msg.type === "term:data" && msg.data.id === termId) {
    const d = msg.data.data;
    if (d.includes("\n") || d.includes("$ ")) log.push("OUT:" + JSON.stringify(d.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").slice(0, 60)));
    if (d.includes("atlas demo")) send("atlas demo");
  }
  if (msg.type === "event") {
    events++;
    if (events <= 4 || events % 5 === 0) log.push("EVT:" + msg.data.channel + ":" + msg.data.kind);
  }
  if (msg.type === "graph") {
    graphs += msg.data.nodes.length;
    log.push("GRAPH+nodes=" + msg.data.nodes.length);
  }
  if (msg.type === "pulse") pulses++;
};
