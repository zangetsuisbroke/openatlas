import * as path from "node:path";
import * as fs from "node:fs";
import type { FileRefInput } from "./types";

const NOISE_SEGMENTS = ["node_modules", ".git", ".cache", "vendor", "coverage", ".next", ".nuxt"];
const KNOWN_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|css|scss|sass|less|html|htm|md|mdx|py|go|rs|rb|php|java|kt|kts|swift|c|cc|cpp|cxx|h|hpp|cs|sql|yml|yaml|toml|ini|cfg|conf|sh|bat|ps1|cmd|lock|vue|svelte|dart|zig|ex|exs|gradle|xml|svg|png|jpg|jpeg|gif|webp|woff2|ttf|eot|map|d.ts|proto|env|gitignore)$/i;

function sanitize(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^["'`(]+/, "").replace(/["'`),.;:]+$/, "");
  s = s.replace(/\\/g, "/");
  if (s.startsWith("file://")) s = s.slice("file://".length);
  if (s.includes("://")) return "";
  if (s.startsWith("#") || s.startsWith("@")) return "";
  s = s.replace(/:\d+(?::\d+)?$/g, "");
  return s;
}

export function canonicalize(raw: string, root: string): string | null {
  const s = sanitize(raw);
  if (!s || s === "." || s === "/") return null;
  const abs = path.isAbsolute(s) ? s : path.resolve(root, s);
  const rel = path.relative(root, abs).replace(/\\/g, "/");
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (!rel || rel === "." || rel === "..") return null;
  if (rel.startsWith(".git") || rel.split("/").includes(".git")) return null;
  if (rel.split("/").some((seg) => NOISE_SEGMENTS.includes(seg))) return null;
  if (!KNOWN_EXT.test(rel)) {
    try {
      if (!fs.statSync(abs).isFile()) return null;
    } catch {
      return null;
    }
  }
  return rel;
}

function candidatesFromText(text: string): string[] {
  const out: string[] = [];
  const windowsAbs = /[A-Za-z]:[\/\\][^ \t\n"'<>|?*\\]+(?:\.[a-zA-Z0-9]+)?/g;
  let m: RegExpExecArray | null;
  while ((m = windowsAbs.exec(text)) !== null) out.push(m[0]);
  const relish = /(?:\.{1,2}[\/\\])?[A-Za-z0-9_@][A-Za-z0-9_@.\-]*(?:[\/\\][A-Za-z0-9_@.\-]+)+/g;
  while ((m = relish.exec(text)) !== null) {
    out.push(m[0].replace(/[,.;:)\]}>]+$/, ""));
  }
  return out;
}

function candidatesFromDiff(diff: string): string[] {
  const out: string[] = [];
  const re = /^(?:^|[ \t])(?:\+\+\+|---) [ab]\/?(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    const p = m[1]?.trim();
    if (p && p !== "/dev/null") out.push(p);
  }
  return out;
}

function candidatesFromArgs(args: unknown): string[] {
  if (args === null || typeof args === "undefined") return [];
  const out: string[] = [];
  if (typeof args === "object") {
    const obj = args as Record<string, unknown>;
    for (const key of ["filePath", "file", "path", "target", "pattern", "include", "workdir"]) {
      const v = obj[key];
      if (typeof v === "string") {
        if (key === "pattern") out.push(...candidatesFromText(v));
        else out.push(v);
      }
    }
  }
  try {
    out.push(...candidatesFromText(JSON.stringify(args)));
  } catch {
    /* ignore */
  }
  return out;
}

export function extractFileRefs(input: FileRefInput, root: string): string[] {
  const seen = new Set<string>();
  const add = (raw: string) => {
    const c = canonicalize(raw, root);
    if (c) seen.add(c);
  };
  if (input.filePath) add(input.filePath);
  if (input.diff) for (const c of candidatesFromDiff(input.diff)) add(c);
  if (input.text) for (const c of candidatesFromText(input.text)) add(c);
  if (input.args !== undefined) for (const c of candidatesFromArgs(input.args)) add(c);
  return [...seen].slice(0, 100);
}

export function toolFileKind(tool: string): "target" | "read" | "mention" {
  if (["edit", "write", "bash", "patch"].includes(tool)) return "target";
  if (["read", "search", "glob", "grep"].includes(tool)) return "read";
  return "mention";
}
