import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";

type LedgerModule = typeof import("../src/ledger");
type CaptureModule = typeof import("../src/capture");
type AtlasModule = typeof import("../src/atlas");

let led: LedgerModule;
let capm: CaptureModule;
let atlasm: AtlasModule;
const saveDebug = process.env.OPENATLAS_DEBUG;
const saveLogFile = process.env.OPENATLAS_LOG_FILE;

beforeAll(async () => {
  process.env.OPENATLAS_DEBUG = "1";
  delete process.env.OPENATLAS_LOG_FILE;
  [led, capm, atlasm] = await Promise.all([import("../src/ledger"), import("../src/capture"), import("../src/atlas")]);
});

afterAll(() => {
  if (saveDebug === undefined) delete process.env.OPENATLAS_DEBUG;
  else process.env.OPENATLAS_DEBUG = saveDebug;
  if (saveLogFile === undefined) delete process.env.OPENATLAS_LOG_FILE;
  else process.env.OPENATLAS_LOG_FILE = saveLogFile;
});

function tmpDir(tag: string): string {
  return path.join(os.tmpdir(), "openatlas-capture-finalize", `${tag}-${Math.random().toString(36).slice(2)}`);
}

function ev(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return { id: `ev_${Math.random()}`, type, data };
}

describe("capturer.finalizeSession on the archive session", () => {
  test("sets title/summary but leaves endedAt null", () => {
    const dir = tmpDir("archive");
    const ledger = new led.Ledger(led.archivePathFor(dir), { root: dir, label: "cap-finalize" });
    const cap = new capm.Capturer(ledger);
    cap.ingest(
      ev("message.updated", {
        sessionID: "archive_session",
        info: { id: "m1", role: "user", parts: [{ type: "text", text: "fix login bug in src/auth.ts" }] },
      })
    );
    cap.finalizeSession("archive_session");
    const s = ledger.getSession("archive_session");
    expect(s?.endedAt).toBeNull();
    expect(s?.title).toContain("login bug");
    expect(s?.summary).toBeTruthy();
    ledger.close();
  });

  test("repeated finalize keeps endedAt null so later turns still record", () => {
    const dir = tmpDir("archive2");
    const ledger = new led.Ledger(led.archivePathFor(dir), { root: dir });
    const cap = new capm.Capturer(ledger);
    cap.ingest(
      ev("message.updated", {
        sessionID: "archive_session_2",
        info: { id: "m1", role: "user", parts: [{ type: "text", text: "do the thing" }] },
      })
    );
    cap.finalizeSession("archive_session_2");
    cap.finalizeSession("archive_session_2");
    expect(ledger.getSession("archive_session_2")?.endedAt).toBeNull();
    ledger.close();
  });
});

describe("atlas finalizeSession distillation", () => {
  test("general copy session gets endedAt set while archive stays null", () => {
    const dir = tmpDir("atlas");
    const atlas = atlasm.openAtlas(dir);
    const s = atlas.archive.createSession({ title: "t" });
    atlas.archive.addStep({ sessionId: s.id, kind: "error", role: "assistant", content: "err1" });
    atlasm.finalizeSession(atlas, s.id);
    expect(atlas.general.getSession(s.id)?.endedAt).not.toBeNull();
    expect(atlas.archive.getSession(s.id)?.endedAt).toBeNull();
    atlas.archive.close();
    atlas.general.close();
  });
});

describe("unknown event type logging", () => {
  test("logs each unknown type once, plus a 100th-occurrence count", () => {
    const dir = tmpDir("unknown");
    const ledger = new led.Ledger(led.archivePathFor(dir), { root: dir });
    const cap = new capm.Capturer(ledger);
    const sid = "unknown_session";
    const calls: string[] = [];
    const orig = console.log;
    console.log = (msg: unknown) => {
      calls.push(String(msg));
    };
    try {
      cap.ingest(ev("session.created", { sessionID: sid }));
      for (let i = 0; i < 50; i++) cap.ingest(ev("message.part.delta", { sessionID: sid }));
      for (let i = 0; i < 150; i++) cap.ingest(ev("session.status", { sessionID: sid }));
    } finally {
      console.log = orig;
    }
    const deltas = calls.filter((c) => c.includes("capture.unknown-type") && c.includes("type=message.part.delta"));
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toContain("first occurrence");
    const status = calls.filter((c) => c.includes("capture.unknown-type") && c.includes("type=session.status"));
    expect(status).toHaveLength(2);
    expect(status.some((c) => c.includes("seen 100 times total"))).toBe(true);
    ledger.close();
  });
});
