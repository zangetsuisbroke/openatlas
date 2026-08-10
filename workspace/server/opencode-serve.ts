// Manages a background `opencode serve` process powering the in-app OpenCode web UI.
// The server is spawned lazily on first request, bound to 127.0.0.1, isolated via
// appEnv() (XDG dirs under <APP_DIR>/.atlas), and killed with the app.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appEnv, appRoot } from "./shell";
import { log } from "./log";

export interface OpenCodeServeStatus {
  running: boolean;
  url?: string;
  port?: number;
  pid?: number;
  started?: boolean;
  error?: string;
}

const PORTS = [4099, 4100, 4101, 4102, 4103];
let child: ChildProcess | null = null;
let port = 0;
let started = false;
let active = false;
let stopping = false;
let startPromise: Promise<OpenCodeServeStatus> | null = null;

function bin(): string {
  const root = appRoot();
  const name = process.platform === "win32" ? "opencode.exe" : "opencode";
  const candidates = [join(root, "vendor", "opencode", "bin", name), join(root, "vendor", "opencode", "bin", "opencode")];
  return candidates.find((p) => existsSync(p)) ?? "";
}

async function probe(p: number): Promise<"opencode" | "busy" | "free"> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  try {
    const res = await fetch(`http://127.0.0.1:${p}/`, { signal: ctl.signal });
    const text = await res.text().catch(() => "");
    return text.includes("OpenCode") ? "opencode" : "busy";
  } catch (e) {
    // aborted (timed out) is ambiguous — treat as busy, not free
    return ctl.signal.aborted ? "busy" : "free";
  } finally {
    clearTimeout(t);
  }
}

export function status(): OpenCodeServeStatus {
  if (active) {
    return { running: true, url: `http://127.0.0.1:${port}`, port, pid: child?.pid, started };
  }
  return { running: false };
}

function killTree(proc: ChildProcess): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill();
    }
  } catch {
    /* already dead */
  }
}

export async function start(): Promise<OpenCodeServeStatus> {
  if (active) return status();
  if (startPromise) return startPromise;
  startPromise = doStart().finally(() => {
    startPromise = null;
  });
  return startPromise;
}

async function doStart(): Promise<OpenCodeServeStatus> {
  stopping = false;
  if (active) return status();
  const b = bin();
  if (!b) {
    log.error("serve", "opencode binary not found — web UI unavailable");
    return { running: false, error: "opencode binary not found" };
  }

  for (const p of PORTS) {
    if (stopping) return { running: false };
    const st = await probe(p);
    if (st === "opencode") {
      port = p;
      started = false;
      active = true;
      log.info("serve", `reusing existing opencode on http://127.0.0.1:${p}`);
      return { running: true, url: `http://127.0.0.1:${p}`, port: p, started: false };
    }
    if (st === "busy") continue;

    log.info("serve", `spawning opencode serve on port ${p}`);
    const t0 = performance.now();
    let proc: ChildProcess;
    try {
      proc = spawn(b, ["serve", "--port", String(p), "--hostname", "127.0.0.1"], {
        cwd: appRoot(),
        env: appEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      log.error("serve", `spawn failed on port ${p}: ${String(e)}`);
      continue;
    }
    proc.on("error", (e) => {
      if (child === proc) {
        child = null;
        active = false;
        log.error("serve", `opencode serve process error: ${String(e)}`);
      }
    });
    proc.stdout?.on("data", (d) => log.info("serve", `out: ${String(d).trim().slice(0, 300)}`));
    proc.stderr?.on("data", (d) => log.info("serve", `err: ${String(d).trim().slice(0, 300)}`));
    proc.on("exit", (code) => {
      if (child === proc) {
        child = null;
        active = false;
        log.info("serve", `opencode serve exited (code ${code})`);
      }
    });
    child = proc;
    port = p;
    started = false;
    active = true;

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (stopping || child !== proc) break;
      const now = await probe(p);
      if (now === "opencode") {
        started = true;
        log.info("serve", `opencode serve ready on port ${p} in ${(performance.now() - t0).toFixed(0)}ms`);
        return { running: true, url: `http://127.0.0.1:${p}`, port: p, pid: proc.pid, started: true };
      }
    }
    if (!stopping) log.error("serve", `opencode serve did not come up on port ${p} — trying next`);
    killTree(proc);
    child = null;
    active = false;
  }
  log.error("serve", "opencode serve failed on all ports");
  return { running: false, error: "could not start opencode serve on any port" };
}

export async function stop(): Promise<void> {
  stopping = true;
  if (child) {
    log.info("serve", "stopping opencode serve");
    const proc = child;
    child = null;
    active = false;
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null) return resolve();
      const t = setTimeout(() => {
        killTree(proc);
        resolve();
      }, 3000);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      killTree(proc);
    });
  }
  active = false;
}
