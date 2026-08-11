// Node PTY host — spawned by the Bun server to provide real terminals.
// Speaks newline-delimited JSON over stdio:
//   stdin:  {cmd:"create", id, shell, args, cwd, cols, rows, env} | {cmd:"input", id, data} | {cmd:"resize", id, cols, rows} | {cmd:"kill", id}
//   stdout: {type:"ready"} | {type:"create", id, shell} | {type:"data", id, data} | {type:"exit", id}
import { createInterface } from "node:readline";

process.stdin.on("close", () => {
  console.error("[host] stdin closed (EOF) — server pipe dropped; staying alive for respawn");
});
process.on("uncaughtException", (e) => {
  console.error("[host] uncaughtException:", e?.stack || String(e));
});
process.on("unhandledRejection", (e) => {
  console.error("[host] unhandledRejection:", String(e));
});

// Windows paths in env vars use backslashes, which Node's dynamic import() mangles
// (treats them as JS escapes). Normalize to a file:// URL so it always resolves.
const envPty = process.env.ATLAS_NODE_PTY;
const candidates = [
  envPty ? "file:///" + envPty.replace(/\\/g, "/") : "",
  "node-pty",
  new URL("../node_modules/node-pty/lib/index.js", import.meta.url).pathname,
  new URL("../vendor/node-pty/lib/index.js", import.meta.url).pathname,
  new URL("./vendor/node-pty/lib/index.js", import.meta.url).pathname,
];

let pty = null;
for (const c of candidates) {
  if (!c) continue;
  try {
    pty = (await import(c)).default ?? (await import(c));
    break;
  } catch {
    /* try next */
  }
}
if (!pty) {
  process.stdout.write(JSON.stringify({ type: "error", message: "node-pty unavailable" }) + "\n");
  process.exit(1);
}

const sessions = new Map();
const pendingInput = new Map();

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const rl = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  switch (msg.cmd) {
    case "create": {
      const id = msg.id;
      if (sessions.has(id)) return;
      let t;
      try {
        t = pty.spawn(msg.shell, msg.args ?? ["-i"], {
          name: "xterm-256color",
          cols: msg.cols ?? 80,
          rows: msg.rows ?? 24,
          cwd: msg.cwd,
          env: msg.env,
        });
      } catch (e) {
        emit({ type: "error", id, message: String(e) });
        return;
      }
      t.onData((data) => emit({ type: "data", id, data }));
      t.onExit(({ exitCode }) => {
        emit({ type: "exit", id });
        sessions.delete(id);
        pendingInput.delete(id);
      });
      sessions.set(id, t);
      emit({ type: "create", id, shell: msg.shell });
      const buffered = pendingInput.get(id);
      if (buffered) {
        pendingInput.delete(id);
        for (const d of buffered) t.write(d);
      }
      break;
    }
    case "input": {
      const t = sessions.get(msg.id);
      if (t) {
        t.write(msg.data);
      } else {
        const buf = pendingInput.get(msg.id) ?? [];
        buf.push(msg.data);
        if (buf.length > 128) buf.shift();
        pendingInput.set(msg.id, buf);
      }
      break;
    }
    case "resize": {
      const t = sessions.get(msg.id);
      if (t) t.resize(msg.cols, msg.rows);
      break;
    }
    case "kill": {
      const t = sessions.get(msg.id);
      if (t) {
        try {
          t.kill();
        } catch {
          /* already gone */
        }
      }
      break;
    }
  }
});

// Keep the event loop alive even if stdin closes unexpectedly, so the host
// never silently exits with code 0 and the server can respawn/recover.
setInterval(() => {}, 60_000);

// Memory guard. node-pty leaks a worker thread + isolate (~9MB) per force-killed
// session on Windows (the ConPTY pipe never closes, so the conout worker blocks in
// a native read and worker.terminate() hangs). It cannot be fixed in JS, so we
// bound it: when idle and over the cap, exit 0 so the server respawns a fresh
// host. Only fires with ZERO open sessions, so active terminals are never dropped.
const MEM_CAP = 350 * 1024 * 1024;
setInterval(() => {
  if (sessions.size === 0 && process.memoryUsage().rss > MEM_CAP) {
    emit({ type: "leak-restart", rssMB: Math.round(process.memoryUsage().rss / 1048576) });
    setTimeout(() => process.exit(0), 50);
  }
}, 15000);

emit({ type: "ready" });
