import * as fs from "node:fs";
import * as path from "node:path";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVELS: Level[] = ["debug", "info", "warn", "error"];

let cachedFile: string | null = null;
let cachedEnv: string | undefined;

// Levels are read at call time (not import time) so tests that toggle
// OPENATLAS_DEBUG/OPENATLAS_LOG_LEVEL after load behave correctly, and the
// running process can change verbosity without a restart.
function currentLevel(): number {
  const forced = process.env.OPENATLAS_DEBUG === "1" || process.env.OPENATLAS_DEBUG === "true";
  const raw = process.env.OPENATLAS_LOG_LEVEL;
  const lvl = typeof raw === "string" ? (LEVELS.find((l) => raw === l) ?? null) : null;
  if (forced) return ORDER.debug;
  return lvl ? ORDER[lvl] : ORDER.info;
}

function resolveLogFile(): string | null {
  const p = process.env.OPENATLAS_LOG_FILE;
  if (p === cachedEnv) return cachedFile;
  cachedEnv = p;
  if (!p) {
    cachedFile = null;
    return null;
  }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    cachedFile = p;
  } catch {
    cachedFile = null;
  }
  return cachedFile;
}

function emit(lvl: Level, area: string, args: unknown[]): void {
  if (ORDER[lvl] < currentLevel()) return;
  const line = `[${new Date().toISOString()}] [${lvl.toUpperCase()}] [openatlas:${area}] ${args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ")}`;
  const file = resolveLogFile();
  if (file) {
    try {
      fs.appendFileSync(file, line + "\n");
    } catch {
      /* logging must never break the host */
    }
  } else if (lvl === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

/** Debug-level, gated on OPENATLAS_DEBUG=1/true or OPENATLAS_LOG_LEVEL=debug. */
export function debugLog(area: string, ...args: unknown[]): void {
  emit("debug", area, args);
}

/** Informational, default on. */
export function logInfo(area: string, ...args: unknown[]): void {
  emit("info", area, args);
}

/** Warnings, always emitted unless level > warn. */
export function logWarn(area: string, ...args: unknown[]): void {
  emit("warn", area, args);
}

/** Errors, always emitted. */
export function logError(area: string, ...args: unknown[]): void {
  emit("error", area, args);
}

function safeJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? String(value) : s;
  } catch {
    return "[unserializable]";
  }
}
