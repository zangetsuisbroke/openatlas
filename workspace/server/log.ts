// Structured logger: tagged, timestamped, bounded file + console mirror.
// No secrets ever logged — callers must not pass tokens/keys.
import { mkdirSync, createWriteStream, statSync, openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const LOG_DIR = process.env.ATLAS_LOG_DIR ?? join(ROOT, "logs");
const MAX_BYTES = 5 * 1024 * 1024;

export type Tag = "http" | "ws" | "pty" | "serve" | "scan" | "mcp" | "graph" | "boot" | "app";
type Level = "info" | "warn" | "error";

let stream: ReturnType<typeof createWriteStream> | null = null;
let bytes = 0;

function ensureStream(): void {
  if (stream) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const file = join(LOG_DIR, "atlas.log");
    try {
      const st = statSync(file);
      bytes = st.size;
      if (bytes > MAX_BYTES) {
        const fd = openSync(file, "r");
        const buf = Buffer.alloc(MAX_BYTES);
        const n = readSync(fd, buf, 0, MAX_BYTES, bytes - MAX_BYTES);
        closeSync(fd);
        writeFileSync(file, buf.subarray(0, n));
        bytes = n;
      }
    } catch {
      bytes = 0;
    }
    stream = createWriteStream(file, { flags: "a" });
  } catch {
    stream = null;
  }
}

function write(level: Level, tag: Tag, msg: string): void {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${tag}] ${msg}`;
  if (process.env.ATLAS_LOG_CONSOLE !== "0") console.log(line);
  ensureStream();
  if (!stream) return;
  bytes += line.length + 1;
  if (bytes > MAX_BYTES) {
    try {
      stream.end();
    } catch {
      /* ignore */
    }
    stream = null;
    bytes = 0;
  }
  try {
    stream.write(line + "\n");
  } catch {
    /* ignore */
  }
}

export const log = {
  info(tag: Tag, msg: string): void {
    write("info", tag, msg);
  },
  warn(tag: Tag, msg: string): void {
    write("warn", tag, msg);
  },
  error(tag: Tag, msg: string): void {
    write("error", tag, msg);
  },
  time(tag: Tag, label: string): () => void {
    const t0 = performance.now();
    return () => write("info", tag, `${label} ${(performance.now() - t0).toFixed(1)}ms`);
  },
};
