import { describe, expect, test, afterAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { Ledger, archivePathFor, generalMemoryPath } from "../src/ledger";
import { LogStore } from "../src/logstore";
import { openAtlas, finalizeSession } from "../src/atlas";
import type { Atlas } from "../src/atlas";

process.env.OPENATLAS_MEMORY_DIR = path.join(os.tmpdir(), "openatlas-hardening-memory", Math.random().toString(36).slice(2));

afterAll(() => {
  delete process.env.OPENATLAS_MEMORY_DIR;
});

function tmpDir(tag: string): string {
  return path.join(os.tmpdir(), "openatlas-hardening", `${tag}-${Math.random().toString(36).slice(2)}`);
}

describe("LogStore id validation (path traversal defense)", () => {
  const dir = tmpDir("logstore");
  const store = new LogStore(dir);

  test("safe ids are accepted", () => {
    for (const id of ["s_abc123", "session-1.foo_bar", "a", "12345"]) {
      expect(store.pathFor(id)).toBe(path.join(dir, `${id}.jsonl`));
    }
  });

  test("traversal ids are rejected", () => {
    for (const id of ["..", "../..", "..\\..", "a/../../etc/passwd", "a\\..\\..\\win.ini", "", "a b", "a/b", "a\\b", "s;DROP"]) {
      expect(store.pathFor(id)).toBeNull();
    }
  });

  test("append/read refuse traversal and never touch files outside the dir", () => {
    const victim = path.join(dir, "..", `victim-${Math.random().toString(36).slice(2)}.jsonl`);
    store.append("../victim", { evil: true });
    expect(fs.existsSync(victim)).toBe(false);
    expect(store.read("../victim")).toBe("");
    expect(store.list().every((e) => e.sessionId === path.basename(e.path, ".jsonl"))).toBe(true);
  });

  test("legit append/read roundtrip works", () => {
    const id = "s_roundtrip";
    store.append(id, { a: 1 });
    expect(store.read(id)).toContain('"a":1');
    expect(store.list().some((e) => e.sessionId === id)).toBe(true);
  });
});

describe("incremental distillation", () => {
  test("finalizeSession distills new steps on each call, idempotently", () => {
    const dir = tmpDir("atlas");
    const atlas = openAtlas(dir);
    const s = atlas.archive.createSession({ title: "t" });
    atlas.archive.addStep({ sessionId: s.id, kind: "error", role: "assistant", content: "err1" });
    atlas.archive.addStep({ sessionId: s.id, kind: "lesson", role: "assistant", content: "lesson1" });

    finalizeSession(atlas, s.id);
    expect(atlas.general.listSteps(s.id).map((x) => x.kind).sort()).toEqual(["error", "lesson"]);

    atlas.archive.addStep({ sessionId: s.id, kind: "fix", role: "assistant", content: "fix1" });
    finalizeSession(atlas, s.id);
    expect(atlas.general.listSteps(s.id).map((x) => x.kind).sort()).toEqual(["error", "fix", "lesson"]);

    atlas.archive.addStep({ sessionId: s.id, kind: "lesson", role: "assistant", content: "lesson2" });
    finalizeSession(atlas, s.id);
    const kinds = atlas.general.listSteps(s.id).map((x) => x.kind).sort();
    expect(kinds).toEqual(["error", "fix", "lesson", "lesson"]);

    finalizeSession(atlas, s.id);
    expect(atlas.general.listSteps(s.id)).toHaveLength(4);

    expect(atlas.general.getSession(s.id)).toBeDefined();
    atlas.archive.close();
    atlas.general.close();
  });

  test("non-distill kinds are never distilled, even across calls", () => {
    const dir = tmpDir("atlas2");
    const atlas = openAtlas(dir);
    const s = atlas.archive.createSession({ title: "t" });
    atlas.archive.addStep({ sessionId: s.id, kind: "task", role: "user", content: "do the thing" });
    atlas.archive.addStep({ sessionId: s.id, kind: "action", role: "tool", content: "edit" });
    finalizeSession(atlas, s.id);
    finalizeSession(atlas, s.id);
    expect(atlas.general.listSteps(s.id)).toHaveLength(0);
    atlas.archive.close();
    atlas.general.close();
  });
});

describe("graph batching with many steps", () => {
  test("graph() survives >CHUNK steps (batched IN clauses)", () => {
    const dir = tmpDir("graph");
    const ledger = new Ledger(archivePathFor(dir), { root: dir, label: "graph" });
    const s = ledger.createSession({});
    const ids: string[] = [];
    for (let i = 0; i < 500; i++) {
      const st = ledger.addStep({ sessionId: s.id, kind: "action", role: "tool", content: `step ${i}` });
      ids.push(st.id);
      if (i % 2 === 0) ledger.addFileRef(st.id, `src/f${i % 10}.ts`, "target");
    }
    for (let i = 0; i + 1 < ids.length; i += 2) {
      ledger.link({ sourceStepId: ids[i]!, targetStepId: ids[i + 1]!, relation: "EXTENDS", origin: "auto" });
    }
    const g = ledger.graph();
    expect(g.nodes.length).toBe(500 + 5);
    expect(g.links.length).toBe(250 + 250);
    ledger.close();
  });

  test("graph() keeps links whose endpoints span different batches", () => {
    const dir = tmpDir("graph-xchunk");
    const ledger = new Ledger(archivePathFor(dir), { root: dir, label: "graph" });
    const s = ledger.createSession({});
    const ids: string[] = [];
    for (let i = 0; i < 900; i++) {
      const st = ledger.addStep({ sessionId: s.id, kind: "action", role: "tool", content: `step ${i}` });
      ids.push(st.id);
    }
    ledger.link({ sourceStepId: ids[0]!, targetStepId: ids[899]!, relation: "FIXES", origin: "auto" });
    ledger.link({ sourceStepId: ids[450]!, targetStepId: ids[1]!, relation: "BASED_ON", origin: "auto" });
    const g = ledger.graph();
    expect(g.links.some((l) => l.source === ids[0] && l.target === ids[899])).toBe(true);
    expect(g.links.some((l) => l.source === ids[450] && l.target === ids[1])).toBe(true);
    ledger.close();
  });
});

describe("distillation preserves source project attribution", () => {
  test("distilled steps carry sourceProject meta", () => {
    const dir = tmpDir("srcproj");
    const atlas = openAtlas(dir);
    const s = atlas.archive.createSession({ title: "t" });
    atlas.archive.addStep({ sessionId: s.id, kind: "lesson", role: "assistant", content: "l" });
    finalizeSession(atlas, s.id);
    const step = atlas.general.listSteps(s.id)[0]!;
    expect(step.meta?.sourceProject).toBe(atlas.archive.projectId);
    atlas.archive.close();
    atlas.general.close();
  });
});
