import * as path from "node:path";
import * as fs from "node:fs";

export interface LogEntry {
  sessionId: string;
  path: string;
  size: number;
  updatedAt: number;
}

export class LogStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  isSafeId(sessionId: string): boolean {
    return typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId);
  }

  pathFor(sessionId: string): string | null {
    if (!this.isSafeId(sessionId)) return null;
    return path.join(this.dir, `${sessionId}.jsonl`);
  }

  append(sessionId: string, event: unknown): void {
    const p = this.pathFor(sessionId);
    if (!p) return;
    fs.appendFileSync(p, JSON.stringify(event) + "\n");
  }

  read(sessionId: string): string {
    const p = this.pathFor(sessionId);
    if (!p) return "";
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return "";
    }
  }

  list(): LogEntry[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
    const out: LogEntry[] = [];
    for (const f of names) {
      const p = path.join(this.dir, f);
      try {
        const st = fs.statSync(p);
        out.push({ sessionId: f.slice(0, -".jsonl".length), path: p, size: st.size, updatedAt: st.mtimeMs });
      } catch {
        // file vanished between listing and stat — skip
      }
    }
    return out;
  }
}
