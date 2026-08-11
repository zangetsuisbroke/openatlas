import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import { ASSETS as EMBEDDED_ASSETS } from "./embedded-assets";
import { log } from "./log";

export interface TermCallbacks {
  onData: (id: string, data: string) => void;
  onExit: (id: string) => void;
  onCommand: (id: string, cmd: string) => void;
}

export interface ISession {
  id: string;
  shell: string;
  title: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

const IS_COMPILED = import.meta.path.endsWith(".exe");
const APP_DIR = process.env.ATLAS_APP_DIR ?? (IS_COMPILED ? dirname(process.execPath) : join(import.meta.dir, ".."));

export function appRoot(): string {
  return APP_DIR;
}

function extractEmbedded(embedded: Record<string, string>, prefix: string, destRoot: string): boolean {
  let any = false;
  for (const [k, raw] of Object.entries(embedded)) {
    if (!k.startsWith(prefix)) continue;
    const rel = k.slice(prefix.length);
    const out = join(destRoot, rel);
    mkdirSync(dirname(out), { recursive: true });
    const body = raw.startsWith("data:") ? Buffer.from(raw.split(",")[1], "base64") : Buffer.from(raw);
    writeFileSync(out, body);
    any = true;
  }
  return any;
}

// Resolve the PTY host script and runtime node-pty: env resource (desktop), dev
// (server/ + vendor/), or extracted from embedded assets in fat-exe mode.
const { HOST_SCRIPT, NODE_PTY_INDEX } = (() => {
  let host = "";
  let p = join(APP_DIR, "server", "pty-host.mjs");
  if (existsSync(p)) {
    log.info("pty", `host script: ${p}`);
    host = p;
  } else if (!IS_COMPILED) {
    p = join(import.meta.dir, "pty-host.mjs");
    if (existsSync(p)) host = p;
  }

  const embedded = EMBEDDED_ASSETS;
  const iso = join(APP_DIR, ".atlas");
  if (!host && embedded && embedded["__internal/pty-host.mjs"]) {
    mkdirSync(iso, { recursive: true });
    const out = join(iso, "pty-host.mjs");
    if (!existsSync(out)) {
      const raw = embedded["__internal/pty-host.mjs"];
      writeFileSync(out, raw.startsWith("data:") ? Buffer.from(raw.split(",")[1], "base64") : Buffer.from(raw));
      log.info("pty", `extracted pty-host.mjs -> ${out}`);
    }
    host = out;
  }

  // node-pty: desktop resource -> next to app -> embedded (in that order). Using the
  // resource copy avoids materializing a 60MB+ base64 string table in this heap.
  let pty = process.env.ATLAS_NODE_PTY && existsSync(process.env.ATLAS_NODE_PTY) ? process.env.ATLAS_NODE_PTY : "";
  if (!pty) pty = nodePtyPath();
  if (!pty && embedded && embedded["__vendor/node-pty/lib/index.js"] && !existsSync(join(APP_DIR, "vendor", "node-pty"))) {
    mkdirSync(iso, { recursive: true });
    const ptyDest = join(iso, "vendor", "node-pty");
    if (extractEmbedded(embedded, "__vendor/node-pty/", ptyDest)) {
      pty = join(ptyDest, "lib", "index.js");
      log.info("pty", `extracted node-pty -> ${ptyDest}`);
    }
  }
  if (embedded && embedded["__vendor/opencode/bin/opencode.exe"] && !existsSync(join(APP_DIR, "vendor", "opencode", "bin", "opencode.exe"))) {
    mkdirSync(iso, { recursive: true });
    if (extractEmbedded(embedded, "__vendor/opencode/bin/", join(APP_DIR, "vendor", "opencode", "bin"))) {
      log.info("pty", "extracted vendored opencode binary");
    }
  }
  // The embedded vendor/internal blobs (opencode.exe alone is ~170MB) are base64
  // strings living in this module's heap. Everything they decode to is now on disk,
  // so drop the references and let the GC reclaim that private memory. The small
  // dist/ keys stay for static serving.
  for (const k of Object.keys(embedded)) {
    if (k.startsWith("__vendor/") || k.startsWith("__internal/")) delete embedded[k];
  }
  if (!host) log.error("pty", "no pty-host.mjs source — PTY host unavailable");
  return { HOST_SCRIPT: host, NODE_PTY_INDEX: pty };
})();

function nodePtyPath(): string {
  const local = join(APP_DIR, "vendor", "node-pty", "lib", "index.js");
  return existsSync(local) ? local : "";
}

// Directory containing the opencode binary, or "" if none is available.
export function opencodeDir(): string {
  const env = process.env.ATLAS_OPENCODE_DIR;
  if (env && existsSync(env)) return env;
  const local = join(APP_DIR, "vendor", "opencode", "bin");
  return existsSync(local) ? local : "";
}

// ---------- environment for app-owned terminals ----------
export function appEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env };
  const prepend: string[] = [];
  const opencodeBin = opencodeDir();
  if (opencodeBin) prepend.push(opencodeBin);
  if (prepend.length) env.PATH = prepend.join(";") + ";" + (env.PATH ?? "");
  const isolated = join(APP_DIR, ".atlas");
  env.XDG_CONFIG_HOME = join(isolated, "opencode-config");
  env.XDG_DATA_HOME = join(isolated, "opencode-data");
  env.XDG_CACHE_HOME = join(isolated, "opencode-cache");
  env.OPENCODE_CONFIG_DIR = env.XDG_CONFIG_HOME;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

function runnerShell(): string {
  if (process.platform === "win32") {
    const candidates = [
      process.env.ProgramFiles && join(process.env.ProgramFiles, "Git/bin/bash.exe"),
      process.env.ProgramFiles && join(process.env.ProgramFiles, "Git/bin/sh.exe"),
      "C:/Program Files/Git/bin/bash.exe",
      "C:/Program Files (x86)/Git/bin/bash.exe",
    ].filter(Boolean) as string[];
    for (const p of candidates) if (existsSync(p)) return p;
    return "cmd.exe";
  }
  return "/bin/bash";
}

// Extract a typed command from a terminal input line: strip ANSI/OSC sequences,
// handle backspaces, drop control chars.
function cleanCommand(s: string): string {
  let t = s.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const out: string[] = [];
  for (const ch of t) {
    if (ch === "\b" || ch === "\x7f") out.pop();
    else if (ch >= " " && ch !== "\x7f") out.push(ch);
  }
  return out.join("").trim();
}

// ---------- node-pty host ----------
const C = {
  green: "\x1b[38;2;89;221;166m",
  amber: "\x1b[38;2;224;175;104m",
  cyan: "\x1b[38;2;111;157;241m",
  dim: "\x1b[38;2;139;146;157m",
  red: "\x1b[38;2;247;118;142m",
  reset: "\x1b[0m",
};

export class PtyHost {
  private proc: Subprocess | null = null;
  private lineBuf = "";
  ready = false;
  ok = false;
  spawned = false;
  onReady: (() => void) | null = null;
  exited: Promise<number | null> = Promise.resolve(null);
  private cb: TermCallbacks;

  constructor(cb: TermCallbacks, opts: { node: string; hostScript: string; cwd: string; env: Record<string, string> }) {
    this.cb = cb;
    try {
      this.proc = Bun.spawn({
        cmd: [opts.node, opts.hostScript],
        cwd: opts.cwd,
        env: opts.env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      console.error("[pty-host] spawn failed:", e);
      log.error("pty", `host spawn failed: ${String(e)}`);
      return;
    }
    this.spawned = true;
    this.exited = this.proc.exited;
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      try {
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.lineBuf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = this.lineBuf.indexOf("\n")) >= 0) {
            const line = this.lineBuf.slice(0, nl);
            this.lineBuf = this.lineBuf.slice(nl + 1);
            if (line) this.handle(line);
          }
        }
      } catch {
        /* closed */
      }
    };
    void pump(this.proc.stdout);
    this.pumpErr(this.proc.stderr);
    this.proc.exited.then((code) => {
      const wasOk = this.ok;
      this.ok = false;
      this.ready = false;
      if (wasOk) {
        console.error("[pty-host] process exited");
        log.warn("pty", `host process exited unexpectedly (code=${code})`);
      } else {
        log.warn("pty", `host process exited before ready (code=${code})`);
      }
    });
  }

  private pumpErr(stream: ReadableStream<Uint8Array>) {
    const dec = new TextDecoder();
    const read = async () => {
      try {
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const s = dec.decode(value, { stream: true });
          if (s.trim()) console.error("[pty-host:err]", s.trim().slice(0, 400));
        }
      } catch {
        /* closed */
      }
    };
    void read();
  }

  private handle(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    switch (msg.type) {
      case "ready":
        this.ok = true;
        this.ready = true;
        this.onReady?.();
        break;
      case "create":
        break;
      case "data":
        this.cb.onData(msg.id, msg.data);
        break;
      case "exit":
        this.cb.onExit(msg.id);
        break;
      case "error":
        console.error("[pty-host]", msg.id ?? "", msg.message ?? msg);
        log.error("pty", `host error ${msg.id ?? ""} ${msg.message ?? JSON.stringify(msg).slice(0, 200)}`);
        break;
    }
  }

  send(obj: unknown): void {
    if (!this.proc || !this.proc.stdin) return;
    try {
      this.proc.stdin.write(JSON.stringify(obj) + "\n");
    } catch (e) {
      console.error("[pty-host] send failed:", e);
    }
  }

  close(): void {
    try {
      if (this.proc?.pid && process.platform === "win32") {
        // kill the whole tree so node-pty's child shells don't get orphaned
        const { execSync } = require("node:child_process") as typeof import("node:child_process");
        execSync(`taskkill /F /T /PID ${this.proc.pid}`, { stdio: "ignore" });
      } else {
        this.proc?.kill();
      }
    } catch {
      try {
        this.proc?.kill();
      } catch {
        /* dead */
      }
    }
  }
}

class PtySession implements ISession {
  readonly id: string;
  readonly shell = "bash";
  title = "bash";
  private cols = 80;
  private rows = 24;

  constructor(
    private host: PtyHost,
    shell: string,
    cwd: string,
    env: Record<string, string>
  ) {
    this.id = randomUUID();
    this.title = shell;
    this.host.send({ cmd: "create", id: this.id, shell, args: ["-i"], cwd, cols: this.cols, rows: this.rows, env });
  }

  write(data: string): void {
    this.host.send({ cmd: "input", id: this.id, data });
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.host.send({ cmd: "resize", id: this.id, cols, rows });
  }

  close(): void {
    this.host.send({ cmd: "kill", id: this.id });
  }
}

// ---------- virtual fallback shell ----------
export class VirtualShell implements ISession {
  readonly id: string;
  readonly shell = "virtual";
  title = "virtual";
  cwd: string;
  private buf = "";
  private escState: 0 | 1 | 2 = 0;
  private history: string[] = [];
  private histIdx = 0;
  private closed = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor() {
    this.id = randomUUID();
    this.cwd = process.env.USERPROFILE ?? process.env.HOME ?? "C:/";
  }

  private setCb: (cb: TermCallbacks) => void = () => {};
  private cb: TermCallbacks | null = null;
  attach(cb: TermCallbacks) {
    this.cb = cb;
    this.render(`\x1b[?25h`);
    this.render(`\r\n${C.dim}atlas workspace shell · type ${C.green}help${C.dim} for commands · ${C.dim}atlas demo${C.dim} for a sweep\r\n`);
    this.prompt();
  }

  private render(text: string) {
    if (this.cb && !this.closed) this.cb.onData(this.id, text);
  }

  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.closed) fn();
    }, ms);
    this.timers.add(t);
  }

  private prompt() {
    const dir = this.cwd.replace(/[\\/]+$/, "").replace(/^.*[\\/]([^\\/]*)/, "$1") || "/";
    this.render(`\r\n${C.green}atlas${C.reset} ${C.dim}@${C.reset} ${C.amber}${dir}${C.reset} ${C.green}$${C.reset} `);
  }

  write(data: string): void {
    if (this.closed) return;
    for (const ch of data) this.feed(ch);
  }

  private feed(ch: string) {
    const c = ch.charCodeAt(0);
    if (this.escState === 1) {
      if (ch === "[" || ch === "]") this.escState = 2;
      else this.escState = 0;
      return;
    }
    if (this.escState === 2) {
      const final = (c >= 64 && c <= 126) || c === 126;
      if (final) this.escState = 0;
      return;
    }
    if (c === 27) {
      this.escState = 1;
      return;
    }
    if (c === 13 || c === 10) {
      const cmd = this.buf.trim();
      this.buf = "";
      if (cmd) {
        this.history.push(cmd);
        this.histIdx = this.history.length;
        this.render("\r\n");
        this.exec(cmd);
      } else {
        this.render("\r\n");
        this.prompt();
      }
      return;
    }
    if (c === 3 || c === 12) {
      this.buf = "";
      this.render(`\r\n^C`);
      this.prompt();
      return;
    }
    if ((c === 8 || c === 127) && this.buf.length) {
      this.buf = this.buf.slice(0, -1);
      this.render("\x08 \x08");
      return;
    }
    if (c === 0) return;
    this.buf += ch;
    this.render(ch);
  }

  private async exec(cmd: string) {
    this.cb?.onCommand(this.id, cmd);
    const parts = cmd.trim().split(/\s+/);
    const name = parts[0].toLowerCase();

    switch (name) {
      case "cd": {
        const arg = parts[1] ?? "~";
        let next = arg === "~" ? (process.env.USERPROFILE ?? "C:/") : arg;
        if (!/^[A-Za-z]:/.test(next)) next = this.cwd.replace(/[\\/]+$/, "") + "/" + next;
        if (existsSync(next)) {
          this.cwd = next.replace(/[\\/]+$/, "") || "/";
        } else {
          this.render(`${C.red}cd: no such directory: ${arg}${C.reset}\r\n`);
        }
        this.prompt();
        return;
      }
      case "pwd":
        this.render(this.cwd);
        this.prompt();
        return;
      case "clear":
        this.render("\x1b[2J\x1b[H");
        this.prompt();
        return;
      case "echo":
        this.render(parts.slice(1).join(" "));
        this.prompt();
        return;
      case "help":
        this.render(
          `\r\n${C.green}atlas shell${C.reset} — real commands run via bash under the hood.\r\n` +
            `  ${C.cyan}ls${C.reset}, ${C.cyan}cat${C.reset}, ${C.cyan}git${C.reset}, ${C.cyan}bun${C.reset}, ${C.cyan}node${C.reset}, ${C.cyan}python${C.reset} ...  run normally\r\n` +
            `  ${C.green}atlas demo${C.reset}   stream a synthetic agent sweep through the graph\r\n` +
            `  ${C.green}atlas clear${C.reset}  reset the knowledge graph\r\n` +
            `  ${C.green}opencode${C.reset}    simulate an agent session\r\n`
        );
        this.prompt();
        return;
      case "atlas":
        if (parts[1] === "demo") {
          this.demoStream();
          return;
        }
        if (parts[1] === "clear") {
          this.render(`${C.dim}graph reset requested…${C.reset}`);
          this.prompt();
          return;
        }
        this.render(`${C.dim}atlas: try ${C.green}atlas demo${C.dim} or ${C.green}atlas clear${C.reset}`);
        this.prompt();
        return;
      case "opencode":
        this.opencodeSession();
        return;
      default:
        await this.runReal(cmd, name);
        this.prompt();
    }
  }

  private async runReal(cmd: string, name: string) {
    const shell = runnerShell();
    let proc: Subprocess;
    try {
      proc = Bun.spawn({
        cmd: shell.includes("cmd") ? [shell, "/d", "/c", cmd] : [shell, "-c", cmd],
        cwd: this.cwd,
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
    } catch (e) {
      this.render(`${C.red}${name}: ${String(e)}${C.reset}`);
      return;
    }
    const decoder = new TextDecoder();
    const out: string[] = [];
    const push = (s: string) => out.push(s);
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      try {
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          let s = decoder.decode(value);
          const used = out.reduce((n, x) => n + x.length, 0);
          if (used >= 24000) break;
          if (used + s.length > 24000) s = s.slice(0, 24000 - used);
          push(s);
        }
      } catch {
        /* closed */
      }
    };
    const pumps = [pump(proc.stdout), pump(proc.stderr)];
    const timeout = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
    }, 12000);
    try {
      await proc.exited;
      await Promise.all(pumps);
    } catch {
      /* killed */
    }
    clearTimeout(timeout);
    const text = out.join("");
    if (text) {
      const sanitized = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").slice(0, 24000);
      this.render(sanitized);
    } else if (proc.exitCode === 0) {
      this.render(`${C.dim}✓ ${name} — no output${C.reset}`);
    } else {
      this.render(`${C.red}✕ ${name} exited with code ${proc.exitCode ?? "?"}${C.reset}`);
    }
  }

  private demoStream() {
    const lines = [
      [0, `${C.green}● atlas-core${C.reset} ${C.dim}scanning session graph${C.reset}`],
      [450, `${C.dim}  memory.retrieved ${C.cyan}auth stack context${C.reset}`],
      [900, `${C.dim}  tool.started ${C.cyan}redis-cli${C.reset} — TTL:revocation:blocklist`],
      [1400, `${C.dim}  file.modified ${C.cyan}src/db/cache.ts${C.reset} +12 -3`],
      [1900, `${C.green}✓ decision${C.reset} JWT over opaque tokens`],
      [2400, `${C.green}✓ decision${C.reset} lazy revocation via blacklist`],
      [2900, `${C.dim}  tool.started ${C.cyan}bun test${C.reset}`],
      [3500, `${C.green}✓ tool.completed ${C.cyan}bun test${C.reset} 42 passed`],
      [4000, `${C.green}● atlas-core${C.reset} ${C.dim}sweep complete — 6 nodes updated${C.reset}`],
    ] as Array<[number, string]>;
    for (const [ms, line] of lines) this.later(ms, () => this.render(`\r\n${line}`));
    this.later(4300, () => this.prompt());
  }

  private opencodeSession() {
    const lines = [
      [0, `${C.green}opencode 0.8.0${C.reset} ${C.dim}· workspace session${C.reset}`],
      [350, `${C.dim}● loading context: 2 memories, 1 task${C.reset}`],
      [700, `${C.green}●${C.reset} ${C.dim}task:${C.reset} wire refresh flow`],
      [1100, `${C.dim}  reading ${C.cyan}src/auth/jwt.ts${C.reset} …`],
      [1600, `${C.green}✓${C.reset} wrote ${C.cyan}src/auth/jwt.ts${C.reset} ${C.dim}+18 -4${C.reset}`],
      [2100, `${C.dim}  verifying with ${C.cyan}bun test${C.reset} …`],
      [2700, `${C.green}✓${C.reset} 42 tests passed · session complete${C.reset}`],
    ] as Array<[number, string]>;
    for (const [ms, line] of lines) this.later(ms, () => this.render(`\r\n${line}`));
    this.later(3000, () => this.prompt());
  }

  resize(_cols: number, _rows: number): void {
    /* virtual shell ignores dimensions */
  }

  close() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

// ---------- manager ----------
export class TerminalManager {
  sessions = new Map<string, ISession>();
  private cb: TermCallbacks;
  private host: PtyHost | null = null;
  private node: string;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private respawnAttempts = 0;
  private closing = false;
  private ptBuf = new Map<string, string>();

  constructor(cb: TermCallbacks) {
    this.cb = cb;
    let nodePath = process.env.ATLAS_NODE ?? "";
    if (!nodePath) {
      if (process.platform === "win32") {
        const defaultWin = "C:/Program Files/nodejs/node.exe";
        if (existsSync(defaultWin)) {
          nodePath = defaultWin;
        } else {
          nodePath = "node";
        }
      } else {
        nodePath = "node";
      }
    }
    this.node = nodePath;
    this.initHost();
  }

  get usingRealPty(): boolean {
    return !!this.host && this.host.ok;
  }

  private initHost() {
    if (process.env.ATLAS_VIRTUAL_SHELL === "1") {
      log.warn("pty", "virtual shell forced via ATLAS_VIRTUAL_SHELL=1");
      return;
    }
    if (this.node.includes("/") || this.node.includes("\\")) {
      if (!existsSync(this.node)) {
        console.warn("[shell] node binary not found at", this.node, "— falling back to virtual shell");
        log.warn("pty", `node not found at ${this.node} — falling back to virtual shell`);
        return;
      }
    }
    if (!HOST_SCRIPT) {
      console.error("[shell] pty-host.mjs unavailable — falling back to virtual shell");
      log.error("pty", "pty-host.mjs unavailable — falling back to virtual shell");
      return;
    }
    const env = appEnv();
    if (NODE_PTY_INDEX) env.ATLAS_NODE_PTY = NODE_PTY_INDEX;
    const host = new PtyHost(this.cb, { node: this.node, hostScript: HOST_SCRIPT, cwd: APP_DIR, env });
    if (!host.spawned) return;
    this.host = host;
    host.onReady = () => {
      this.respawnAttempts = 0;
    };
    host.exited.then((code) => {
      if (this.closing || this.host !== host) return;
      // A graceful exit (code 0) is a deliberate self-restart (e.g. the memory
      // guard in pty-host.mjs bounding a node-pty worker leak) — it is expected
      // and must NOT count toward the crash-loop cap. Non-zero = crash: cap it.
      const graceful = code === 0;
      if (!graceful && this.respawnAttempts >= 5) {
        log.error("pty", `host died ${this.respawnAttempts} times — giving up on respawn`);
        return;
      }
      if (graceful) {
        log.warn("pty", `host self-restarted (exit 0) — respawning fresh host`);
      } else {
        console.error("[shell] pty host died — closing pty sessions, respawning");
        log.error("pty", `host died — closing pty sessions, respawning (attempt ${this.respawnAttempts + 1})`);
      }
      for (const [id, t] of [...this.sessions.entries()]) {
        if (t instanceof PtySession) {
          this.sessions.delete(id);
          this.ptBuf.delete(id);
          this.cb.onExit(id);
        }
      }
      const delay = graceful ? 500 : Math.min(2000 * 2 ** this.respawnAttempts, 10000);
      if (!graceful) this.respawnAttempts++;
      if (this.respawnTimer) clearTimeout(this.respawnTimer);
      this.respawnTimer = setTimeout(() => {
        if (this.closing || this.host !== host) return;
        this.host = null;
        log.info("pty", "respawn host");
        this.initHost();
      }, delay);
    });
  }

  dispose(): void {
    this.closing = true;
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.killAll();
    if (this.host) {
      this.host.close();
      this.host = null;
    }
  }

  create(): ISession {
    if (this.host && this.host.ok) {
      const t = new PtySession(this.host, runnerShell(), APP_DIR, appEnv());
      this.sessions.set(t.id, t);
      return t;
    }
    const t = new VirtualShell();
    t.attach(this.cb);
    this.sessions.set(t.id, t);
    return t;
  }

  write(id: string, data: string): void {
    const t = this.sessions.get(id);
    if (!t) return;
    if (t instanceof PtySession) {
      const prev = this.ptBuf.get(id) ?? "";
      const lines = (prev + data).split(/\r\n|\r|\n/);
      const rest = lines.pop() ?? "";
      for (const line of lines) {
        const cmd = cleanCommand(line);
        if (cmd) this.cb.onCommand(id, cmd);
      }
      this.ptBuf.set(id, rest);
    }
    t.write(data);
  }

  private forget(id: string): void {
    this.ptBuf.delete(id);
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.resize(cols, rows);
  }

  kill(id: string): void {
    const t = this.sessions.get(id);
    if (!t) return;
    t.close();
    this.sessions.delete(id);
    this.forget(id);
    // PtySession's exit is reported by the host's "exit" event (avoid double-fire);
    // VirtualShell has no host event, so signal onExit directly.
    if (t instanceof VirtualShell) this.cb.onExit(id);
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  list(): ISession[] {
    return [...this.sessions.values()];
  }
}
