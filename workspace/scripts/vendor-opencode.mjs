// Vendors a self-contained opencode binary into vendor/opencode/bin so the shipped app
// never depends on (or leaks) the user's personal opencode install.
// Usage: bun scripts/vendor-opencode.mjs
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dstDir = join(root, "vendor", "opencode", "bin");
const dst = join(dstDir, "opencode.exe");

const exe = process.platform === "win32" ? "opencode.exe" : "opencode";
const candidates = [
  process.env.ATLAS_OPENCODE_BIN,
  "C:/Users/admin/AppData/Roaming/npm/node_modules/opencode-ai/bin/opencode.exe",
  "C:/Users/admin/AppData/Local/npm/node_modules/opencode-ai/bin/opencode.exe",
  "C:/Program Files/opencode/bin/opencode.exe",
  "/usr/local/bin/opencode",
  "/usr/bin/opencode",
].filter(Boolean);

let src = candidates.find((c) => existsSync(c));
if (!src) {
  console.warn("opencode binary not found — skipping vendor. opencode will not be on PATH.");
  process.exit(0);
}

mkdirSync(dstDir, { recursive: true });
copyFileSync(src, dst);
console.log(`vendored opencode ${exe} -> ${dst}`);

const check = (await import("node:child_process")).spawnSync(dst, ["--version"], { encoding: "utf8", timeout: 15000 });
console.log(`opencode version: ${(check.stdout || check.stderr || "").trim() || "?"}`);
if (check.status !== 0) {
  console.warn("vendored opencode binary failed to run — check the binary");
  process.exit(1);
}
process.exit(0);
