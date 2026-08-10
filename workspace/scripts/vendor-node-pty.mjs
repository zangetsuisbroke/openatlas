// Copies the node-pty package into vendor/ so the standalone exe can run real PTY terminals.
// Usage: bun scripts/vendor-node-pty.mjs
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const src = join(root, "node_modules", "node-pty");
const dst = join(root, "vendor", "node-pty");

if (!existsSync(src)) {
  console.error("node_modules/node-pty not found — run `bun install` first");
  process.exit(1);
}
rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true });
const ok = existsSync(join(dst, "lib", "index.js"));
console.log(ok ? `vendored node-pty -> vendor/node-pty` : "ERROR: node-pty copy incomplete");
process.exit(ok ? 0 : 1);
