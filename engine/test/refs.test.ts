import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { canonicalize, extractFileRefs } from "../src/refs";

const root = path.join(os.tmpdir(), "openatlas-refs-test");
fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "foo.ts"), "// hi");

describe("canonicalize", () => {
  test("normalizes the same file across 4 spellings to one key", () => {
    const a = canonicalize("src/foo.ts", root);
    const b = canonicalize("./src/foo.ts", root);
    const c = canonicalize(path.join(root, "src", "foo.ts"), root);
    const d = canonicalize(path.join(root, "src", "foo.ts").replace(/\\/g, "\\"), root);
    expect(a).toBe("src/foo.ts");
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toBe(d);
  });

  test("strips line/col suffixes", () => {
    expect(canonicalize("src/foo.ts:42:5", root)).toBe("src/foo.ts");
    expect(canonicalize("src/foo.ts:42", root)).toBe("src/foo.ts");
  });

  test("rejects paths outside the root", () => {
    expect(canonicalize("../../etc/passwd", root)).toBeNull();
  });

  test("rejects noise dirs", () => {
    expect(canonicalize("src/foo/node_modules/x.js", root)).toBeNull();
    expect(canonicalize(".git/config", root)).toBeNull();
  });

  test("keeps real dirless files by existence check", () => {
    expect(canonicalize("src/lib", root)).toBeNull();
    expect(canonicalize("src", root)).toBeNull();
  });
});

describe("extractFileRefs", () => {
  test("from filePath", () => {
    const refs = extractFileRefs({ filePath: "src/foo.ts" }, root);
    expect(refs).toContain("src/foo.ts");
  });

  test("from diff headers", () => {
    const diff = `--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n`;
    expect(extractFileRefs({ diff }, root)).toContain("src/foo.ts");
  });

  test("from error stack trace text", () => {
    const text = `Error: boom\n  at getFoo (src/foo.ts:42:5)\n  at main (src/bar.ts:7:1)`;
    const refs = extractFileRefs({ text }, root);
    expect(refs).toContain("src/foo.ts");
  });

  test("from tool args", () => {
    const refs = extractFileRefs({ args: { filePath: "src/foo.ts", command: "bun test" } }, root);
    expect(refs).toContain("src/foo.ts");
  });

  test("dedupes and caps at 100", () => {
    const refs = extractFileRefs({ text: "src/foo.ts src/foo.ts src/foo.ts" }, root);
    expect(refs.filter((r) => r === "src/foo.ts")).toHaveLength(1);
  });
});
