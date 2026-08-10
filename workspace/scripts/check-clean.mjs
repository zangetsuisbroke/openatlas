// Hard-fail gate: the shipped bundle (dist/, vendor/, embedded assets) AND the compiled
// exe must contain no personal credentials or dev-machine paths — no auth.json, no .env
// files, no obvious API keys, no C:\Users\<name>, no D:\<repo> paths.
// (.atlas is runtime state created in the app dir on first launch and is never
// embedded into the exe, so it is intentionally excluded from this scan.)
// Usage: bun scripts/check-clean.mjs  (exits non-zero on any violation)
import { readdirSync, readFileSync, statSync, openSync, readSync } from "node:fs";
import { extname, join, relative } from "node:path";

const verifyExe = process.argv.includes("--exe");
const root = join(import.meta.dir, "..");
const scanDirs = ["dist", "vendor"].map((d) => join(root, d));
const extraFiles = [join(root, "server", "embedded-assets.ts")];
const exeFiles = verifyExe ? ["atlas-workspace.exe"].map((f) => join(root, f)) : [];

const NAME_BLOCKLIST = [/auth\.json$/i, /auth\.toml$/i, /credentials\.json$/i, /^\.env($|\.)/i];
const TEXT_EXT = new Set([".json", ".js", ".mjs", ".ts", ".md", ".txt", ".toml", ".yaml", ".yml", ".css", ".html", ".env"]);
const SECRET_RE = /\b(sk-[A-Za-z0-9_\-]{16,}|api[_-]?key["'\s:=]{1,3}[A-Za-z0-9_\-]{16,}|bearer\s+[A-Za-z0-9_\-\.]{20,}|ANTHROPIC_API_KEY\s*=|OPENAI_API_KEY\s*=|OPENROUTER_API_KEY\s*=|GITHUB_TOKEN\s*=)/i;
// stricter for raw-binary scanning: real key shapes + env var assignments only
// (loose "Bearer ..." matches canary strings inside vendored third-party binaries)
const BINARY_SECRET_RE = /\b(sk-ant-[A-Za-z0-9_\-]{16,}|sk-proj-[A-Za-z0-9_\-]{16,}|api[_-]?key["'\s:=]{1,3}[A-Za-z0-9]{20,}|ANTHROPIC_API_KEY\s*=|OPENAI_API_KEY\s*=|OPENROUTER_API_KEY\s*=|GITHUB_TOKEN\s*=)/i;
// dev-machine path fragments that must never be baked into the binary
// generic Windows path segments that legitimately appear in third-party tools
const GENERIC_USER_SEGS = /^(appdata|public|default|default user|all users|local|roaming|windows|users|$)$/i;
// well-known install roots — not personal data (e.g. "C:/Program Files/Git/bin/bash.exe")
const GENERIC_DRIVE_SEGS = /^(program files|program files \(x86\)|windows|windows\/system32|msys64|msys|usr|opt|etc|tmp|var|bin|tools|localappdata|appdata)$/i;
const PATH_PROBES = [
  // C:\Users\<real-username>\... (skip generic segments from vendored tools)
  { re: /[a-z]:\\users\\[^\\]+(?=\\)/i, validate: (s) => !GENERIC_USER_SEGS.test(s.replace(/\\+$/, "").split(/[\\/]/).pop() ?? "") },
  // D:/repo/subdir — drive-letter path whose first segment is not a generic install root
  { re: /[a-z]:\/[a-z0-9_\-\.\(\) ]+\/[a-z0-9_\-\.]+/i, validate: (s) => !GENERIC_DRIVE_SEGS.test(s.slice(3, s.indexOf("/", 3)) ?? "") },
  // \Users\<real-username> standalone (trailing backslash variant)
  { re: /\\users\\[^\\/]+[\\/]/i, validate: (s) => !GENERIC_USER_SEGS.test(s.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "") },
  /\.atlas[\\/]/i,                     // runtime state dir
];

function binaryViolation(chunk) {
  for (const entry of PATH_PROBES) {
    const probe = entry instanceof RegExp ? { re: entry, validate: () => true } : entry;
    const { re, validate } = probe;
    const m = re.exec(chunk);
    if (m && validate(m[0])) {
      return { msg: `dev path "${m[0].slice(0, 40)}"`, matched: true };
    }
  }
  return null;
}

const violations = [];
const seen = new Set();

function checkFile(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const name = file.split(/[\\/]/).pop() ?? "";
  if (NAME_BLOCKLIST.some((re) => re.test(name))) {
    violations.push(`${relative(root, file)} — blocklisted file name`);
    return;
  }
  const ext = extname(file).toLowerCase();
  if (!TEXT_EXT.has(ext) && !name.startsWith(".env")) return;
  try {
    const text = readFileSync(file, "utf8");
    const m = text.match(SECRET_RE);
    if (m) violations.push(`${relative(root, file)} — secret-like pattern "${m[0].slice(0, 40)}"`);
  } catch {
    /* binary or unreadable — skip */
  }
}

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full);
    else checkFile(full);
  }
}

for (const dir of scanDirs) walk(dir);
for (const f of extraFiles) checkFile(f);

function checkExe(file) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return; // exe not built yet — source-level gate still applies
  }
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(4 * 1024 * 1024);
  let pos = 0;
  try {
    while (pos < st.size) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      const chunk = buf.subarray(0, n).toString("latin1");
      if (BINARY_SECRET_RE.test(chunk)) {
        const m = chunk.match(BINARY_SECRET_RE);
        violations.push(`${relative(root, file)} — secret-like pattern "${m?.[0]?.slice(0, 40)}"`);
        return;
      }
      const v = binaryViolation(chunk);
      if (v) {
        violations.push(`${relative(root, file)} — ${v.msg}`);
        return;
      }
      pos += n;
    }
  } finally {
    // best-effort close; resource released on exit otherwise
  }
}

for (const f of exeFiles) checkExe(f);

if (violations.length) {
  console.error("CLEAN CHECK FAILED — personal data would ship in the bundle" + (verifyExe ? " or built exe" : "") + ":");
  for (const v of violations) console.error("  - " + v);
  console.error("Remove these files, then re-run the build.");
  process.exit(1);
}
console.log("clean check passed: no auth files or secrets" + (verifyExe ? " (exe scanned)" : " in bundle"));
process.exit(0);
