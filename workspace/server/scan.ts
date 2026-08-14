// Bounded real-workspace scan that feeds real entities into the knowledge graph:
// files, folders, package deps, git status, and file-to-file import links.
// Runs async at startup, then lazy-refreshes (mtime-based) when stale.
import { readdir, stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
const execFile = (file: string, args: string[], opts: Record<string, unknown>): Promise<{ stdout: string }> =>
  new Promise((resolve, reject) =>
    execFileCb(file, args, opts as import("node:child_process").ExecFileOptions, (err, stdout) =>
      err ? reject(err) : resolve({ stdout: String(stdout) })
    )
  );
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { log } from "./log";
import { appRoot } from "./shell";
import type { GNode, GLink } from "../src/types";

const SKIP_DIRS = new Set(["node_modules", "vendor", ".atlas", ".git", "dist", ".opencode", ".agents", ".claude", "logs", "__pycache__", ".venv", "out", "coverage", "public"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".json", ".yml", ".yaml", ".toml", ".md", ".css", ".html"]);
const MAX_FILES = 4000;
const MAX_DEPTH = 14;
const STALE_MS = 30_000;

interface ScanResult {
  nodes: GNode[];
  links: GLink[];
  files: number;
  folders: number;
  ms: number;
  rescanFiles: string[];
}

let lastScan = 0;
let lastMtimes = new Map<string, number>();
let lastResult: ScanResult | null = null;

function isCode(rel: string): boolean {
  return CODE_EXT.has(extname(rel).toLowerCase());
}

const yieldEvery = 200;
let yielded = 0;
function maybeYield(): Promise<void> {
  if (++yielded >= yieldEvery) {
    yielded = 0;
    return new Promise((r) => setImmediate(r));
  }
  return Promise.resolve();
}

async function walk(root: string, rel: string, depth: number, acc: { files: string[]; folders: string[]; mtimes: Map<string, number> }): Promise<void> {
  if (depth > MAX_DEPTH || acc.files.length > MAX_FILES) return;
  let entries: string[];
  try {
    entries = await readdir(join(root, rel));
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(root, rel, name);
    const r = rel ? `${rel}${sep}${name}` : name;
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      acc.folders.push(r);
      await walk(root, r, depth + 1, acc);
    } else if (st.isFile() && isCode(r) && !name.endsWith(".lock")) {
      acc.files.push(r);
      acc.mtimes.set(r, st.mtimeMs);
    }
    await maybeYield();
  }
}

// Very light import scanner: finds relative + bare package imports in TS/JS.
const IMPORT_RE = /(?:import|from|require\()\s*["']([^"']+)["']/g;

function importsOf(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(text))) out.push(m[1]);
  return out;
}

function resolveImport(fromFile: string, spec: string, files: Set<string>): string | null {
  if (!spec.startsWith(".")) return null; // bare package — skip (not a file link)
  let p = spec.replace(/^\.\//, "");
  p = p.replace(/\\/g, "/");
  const dir = dirname(fromFile);
  const candidates = [join(dir, p), join(dir, p, "index"), join(dir, p + ".ts"), join(dir, p + ".tsx"), join(dir, p + ".js"), join(dir, p + ".mjs")];
  for (const c of candidates) {
    const norm = c.split("/").join(sep);
    if (files.has(norm)) return norm;
  }
  return null;
}

export function stale(): boolean {
  return Date.now() - lastScan > STALE_MS;
}

export function lastScanAt(): number {
  return lastScan;
}

export async function scanNow(): Promise<ScanResult> {
  const t0 = performance.now();
  // ATLAS_WORKSPACE lets a desktop shell point the scan at a chosen folder
  // independent of the install/app-data dir.
  const root = process.env.ATLAS_WORKSPACE || appRoot();
  const acc = { files: [] as string[], folders: [] as string[], mtimes: new Map<string, number>() };
  yielded = 0;
  await walk(root, "", 0, acc);

  const now = Date.now();
  const changed: string[] = [];
  for (const f of acc.files) {
    const mt = acc.mtimes.get(f);
    if (mt !== undefined && mt !== lastMtimes.get(f)) changed.push(f);
  }
  // If nothing changed since last scan, reuse the cached result.
  if (lastResult && changed.length === 0 && acc.files.length === lastResult.files) {
    lastScan = now;
    lastResult.rescanFiles = [];
    return lastResult;
  }

  const nodes: GNode[] = [];
  const links: GLink[] = [];
  const fileSet = new Set(acc.files);
  const nodeId = (rel: string) => `w:${rel.split(sep).join("/")}`;

  for (const f of acc.files) {
    const label = f.split(/[\\/]/).slice(-2).join("/");
    nodes.push({ id: nodeId(f), label, type: "file", val: 0.6, created: now, lastActive: now });
    const folder = dirname(f);
    if (folder !== ".") links.push({ source: nodeId(f), target: nodeId(folder), relation: "contains", strength: 1 });
  }
  for (const d of acc.folders) {
    nodes.push({ id: nodeId(d), label: basename(d), type: "folder", val: 0.4, created: now, lastActive: now });
  }

  // git status
  try {
    // cheap pre-check: only invoke git if a .git dir exists within a few parent levels
    let dir = root;
    let isRepo = false;
    for (let i = 0; i < 5; i++) {
      if (existsSync(join(dir, ".git"))) { isRepo = true; break; }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (isRepo) {
      const { stdout } = await execFile("git", ["branch", "--show-current"], {
        cwd: root, encoding: "utf8", timeout: 3000, windowsHide: true,
      });
      const branch = stdout.trim();
      if (branch) {
        nodes.push({ id: "git:branch", label: `branch ${branch}`, type: "branch", val: 1.4, created: now, lastActive: now });
      }
    }
  } catch {
    /* not a git repo */
  }

  // package deps
  try {
    const pkgPath = join(root, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    const deps: Record<string, string> = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const name of Object.keys(deps)) {
      const id = `dep:${name}`;
      nodes.push({ id, label: name, type: "package", val: 0.5, created: now, lastActive: now });
      links.push({ source: id, target: "w:package.json", relation: "depends", strength: 1 });
    }
  } catch {
    /* no package.json */
  }

  // imports (only for changed files to stay cheap)
  let importCount = 0;
  let i = 0;
  const rescanFiles: string[] = [];
  for (const f of changed.slice(0, 500)) {
    if (!/\.(ts|tsx|js|jsx|mjs)$/i.test(f)) continue;
    rescanFiles.push(f);
    try {
      const size = (await stat(join(root, f))).size;
      if (size > 1_000_000) continue; // skip huge generated/bundle files
      const text = await readFile(join(root, f), "utf8");
      for (const spec of importsOf(text)) {
        const target = resolveImport(f, spec, fileSet);
        if (target) {
          links.push({ source: nodeId(f), target: nodeId(target), relation: "imports", strength: 1 });
          importCount++;
        }
      }
    } catch {
      /* skip unreadable */
    }
    if (++i % yieldEvery === 0) await new Promise((r) => setImmediate(r));
  }

  lastMtimes = acc.mtimes;
  lastScan = now;
  lastResult = {
    nodes,
    links,
    files: acc.files.length,
    folders: acc.folders.length,
    ms: performance.now() - t0,
    rescanFiles,
  };
  log.info("scan", `scan complete: ${acc.files.length} files, ${acc.folders.length} folders, ${importCount} imports in ${lastResult.ms.toFixed(0)}ms`);
  return lastResult;
}
