import * as fs from "node:fs";
import * as path from "node:path";
import { openAtlas, finalizeSession } from "../engine/src/index.ts";
import type { Atlas, Ledger, StepKind, Role } from "../engine/src/index.ts";

const projectDir = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "..", ".demo"));

function resetArchive(dir: string): void {
  const archiveDir = path.join(dir, ".openatlas");
  try {
    for (const f of fs.readdirSync(archiveDir)) {
      if (f.startsWith("archive.db")) fs.rmSync(path.join(archiveDir, f), { force: true });
    }
  } catch {
    /* no existing archive yet */
  }
}

interface SeedStepOpts {
  parentId?: string | null;
  meta?: Record<string, unknown> | null;
  refs?: Array<[string, "target" | "read" | "mention"]>;
  payloads?: Array<[string, string]>;
}

function addStep(
  ledger: Ledger,
  sessionId: string,
  kind: StepKind,
  role: Role,
  content: string,
  opts: SeedStepOpts = {}
): { id: string; stepId: string; sessionId: string; kind: StepKind; content: string | null } {
  const step = ledger.addStep({ sessionId, kind, role, content, parentId: opts.parentId ?? null, meta: opts.meta ?? null });
  for (const [p, k] of opts.refs ?? []) ledger.addFileRef(step.id, p, k);
  for (const [kindName, data] of opts.payloads ?? []) ledger.addPayload(step.id, kindName, data);
  return { id: step.id, stepId: step.id, sessionId, kind, content: step.content };
}

function makeSession(atlas: Atlas, title: string): string {
  const session = atlas.archive.createSession({ agent: "opencode", model: "demo", title });
  return session.id;
}

function main(): void {
  resetArchive(projectDir);
  const atlas = openAtlas(projectDir, { agent: "opencode", model: "demo" });
  const ledger = atlas.archive;

  const bigTestOutput = [
    "bun test v1.3.14",
    "src/auth.test.ts:",
    "  ✓ password check accepts a correct password",
    "  ✓ password check rejects a short password",
    "  ✓ password check rejects an empty password",
    "  ✓ password check rejects a password without a digit",
    "  ✓ login flow accepts a valid user",
    "  ✓ login flow rejects a wrong password (was: password check always returns true)",
    "src/validate.test.ts:",
    "  ✓ isStrongPassword returns false for length < 8",
    "  ✓ isStrongPassword accepts a strong password",
    "2 files, 12 tests, 12 pass, 0 fail",
    "measured time: 42ms (was 180ms before the fix)",
  ].join("\n");

  const s1 = makeSession(atlas, "Fix login bug — password check always returns true");
  const s1Task = addStep(ledger, s1, "task", "user", "Fix login bug — password check always returns true", {
    refs: [["src/auth.ts", "mention"]],
  });
  const s1Plan = addStep(ledger, s1, "plan", "assistant", "Plan: read src/auth.ts and src/lib/validate.ts to find why password checks always succeed, fix the validation, then run bun test to confirm.");
  const s1Read = addStep(ledger, s1, "action", "tool", "read", {
    parentId: s1Plan.id,
    meta: { tool: "read" },
    refs: [
      ["src/auth.ts", "read"],
      ["src/lib/validate.ts", "read"],
    ],
    payloads: [["args", JSON.stringify({ filePath: "src/auth.ts" }, null, 2)]],
  });
  const s1Error = addStep(ledger, s1, "error", "tool", "bun test fails: 2 tests failed — password check returns true for an invalid password", {
    parentId: s1Plan.id,
    meta: { tool: "bash" },
  });
  const s1Root = addStep(ledger, s1, "root_cause", "assistant", "Root cause: src/lib/validate.ts isStrongPassword() only checks that the password is non-empty; there is no length check, so any non-empty password passes before the hash compare in src/auth.ts.");
  const s1Fix = addStep(ledger, s1, "fix", "assistant", "Edit src/auth.ts to reject passwords shorter than 8 chars before hashing, and require a digit in validate.ts.", {
    refs: [
      ["src/auth.ts", "target"],
      ["src/lib/validate.ts", "target"],
    ],
  });
  const s1Verification = addStep(ledger, s1, "verification", "tool", "bun test", {
    outcome: "success",
    meta: { tool: "bash" },
    refs: [["src/auth.ts", "mention"]],
    payloads: [["output", bigTestOutput]],
  });
  const s1Lesson = addStep(ledger, s1, "lesson", "assistant", "Lesson: always validate password length and format before comparing hashes, and add regression tests for the empty and short-password cases.");
  ledger.link({ sourceStepId: s1Fix.id, targetStepId: s1Error.id, relation: "FIXES", origin: "agent" });
  ledger.link({ sourceStepId: s1Error.id, targetStepId: s1Plan.id, relation: "CAUSED_BY", origin: "auto" });
  ledger.link({ sourceStepId: s1Root.id, targetStepId: s1Error.id, relation: "CAUSED_BY", origin: "agent" });
  finalizeSession(atlas, s1);

  const s2 = makeSession(atlas, "Slow graph query in archives view");
  const s2Task = addStep(ledger, s2, "task", "user", "Slow graph query in archives view");
  const s2Plan = addStep(ledger, s2, "plan", "assistant", "Plan: read src/graph.ts and src/db.ts to locate the slow query, hypothesize a missing index, add it, and benchmark before and after.");
  const s2Read = addStep(ledger, s2, "action", "tool", "read", {
    parentId: s2Plan.id,
    meta: { tool: "read" },
    refs: [
      ["src/graph.ts", "read"],
      ["src/db.ts", "read"],
    ],
    payloads: [["args", JSON.stringify({ filePath: "src/graph.ts" }, null, 2)]],
  });
  const s2Hypo = addStep(ledger, s2, "hypothesis", "assistant", "Hypothesis: the graph query in src/graph.ts scans step_links entirely because step_links.source_step_id has no index; adding one should cut latency.", {
    parentId: s2Plan.id,
  });
  const s2Edit = addStep(ledger, s2, "action", "tool", "edit", {
    parentId: s2Hypo.id,
    meta: { tool: "edit" },
    refs: [["src/db.ts", "target"]],
    payloads: [["args", JSON.stringify({ filePath: "src/db.ts" }, null, 2)]],
  });
  const s2Verification = addStep(ledger, s2, "verification", "tool", "bun test", {
    outcome: "success",
    meta: { tool: "bash" },
    refs: [["src/graph.ts", "mention"]],
    payloads: [["output", "benchmark: graph query 120ms -> 9ms after adding index idx_step_links_source."]],
  });
  const s2Lesson = addStep(ledger, s2, "lesson", "assistant", "Lesson: foreign-key columns used in graph traversal should get dedicated indexes; always benchmark before and after schema changes.");
  ledger.link({ sourceStepId: s2Hypo.id, targetStepId: s2Read.id, relation: "BASED_ON", origin: "agent" });
  ledger.link({ sourceStepId: s2Edit.id, targetStepId: s2Hypo.id, relation: "REFINES", origin: "agent" });
  ledger.link({ sourceStepId: s2Verification.id, targetStepId: s2Edit.id, relation: "CAUSED_BY", origin: "auto" });
  finalizeSession(atlas, s2);

  const s3 = makeSession(atlas, "Refactor duplicate validation");
  const s3Task = addStep(ledger, s3, "task", "user", "Refactor duplicate validation logic in src/lib/validate.ts and src/auth.ts");
  const s3Plan = addStep(ledger, s3, "plan", "assistant", "Plan: extract the shared password-rule checks used by both files into one helper, update both call sites, then run bun test.");
  const s3EditValidate = addStep(ledger, s3, "action", "tool", "edit", {
    parentId: s3Plan.id,
    meta: { tool: "edit" },
    refs: [["src/lib/validate.ts", "target"]],
    payloads: [["args", JSON.stringify({ filePath: "src/lib/validate.ts" }, null, 2)]],
  });
  const s3EditAuth = addStep(ledger, s3, "action", "tool", "edit", {
    parentId: s3Plan.id,
    meta: { tool: "edit" },
    refs: [["src/auth.ts", "target"]],
    payloads: [["args", JSON.stringify({ filePath: "src/auth.ts" }, null, 2)]],
  });
  const s3Verification = addStep(ledger, s3, "verification", "tool", "bun test", {
    outcome: "success",
    meta: { tool: "bash" },
    refs: [
      ["src/lib/validate.ts", "mention"],
      ["src/auth.ts", "mention"],
    ],
    payloads: [["output", "bun test: 12 tests pass after the refactor."]],
  });
  const s3Decision = addStep(ledger, s3, "decision", "assistant", "Decision: extract a shared validateCredentials() helper in src/lib/validate.ts and call it from src/auth.ts to remove the duplicated length check.");
  ledger.link({ sourceStepId: s3Decision.id, targetStepId: s1Fix.id, relation: "BASED_ON", origin: "agent" });
  ledger.link({ sourceStepId: s3EditValidate.id, targetStepId: s1Fix.id, relation: "SHARES_FILE", origin: "file", meta: { file: "src/lib/validate.ts" } });
  finalizeSession(atlas, s3);

  const sessions = ledger.listSessions();
  for (const s of sessions) {
    fs.rmSync(atlas.logs.pathFor(s.id) ?? "", { force: true });
    atlas.logs.append(s.id, {
      id: `ev_demo_${s.id}`,
      type: "session.created",
      properties: { sessionID: s.id, info: { id: s.id, directory: projectDir } },
      ts: s.startedAt,
    });
    atlas.logs.append(s.id, {
      id: `ev_demo_task_${s.id}`,
      type: "message.part.updated",
      properties: {
        sessionID: s.id,
        part: { type: "text", text: s.title },
      },
      ts: s.startedAt + 1000,
    });
    for (const st of ledger.listSteps(s.id)) {
      atlas.logs.append(s.id, {
        id: `ev_demo_step_${st.id}`,
        type: "session.next.step.started",
        properties: {
          sessionID: s.id,
          stepID: st.id,
          model: { id: "demo", providerID: "demo" },
          agent: { id: "openatlas-demo", name: "openatlas demo" },
          tool: st.meta?.tool ? String(st.meta.tool) : undefined,
        },
        ts: st.createdAt,
      });
    }
    atlas.logs.append(s.id, {
      id: `ev_demo_done_${s.id}`,
      type: "session.idle",
      properties: { sessionID: s.id, idleSeconds: 0 },
      ts: Date.now(),
    });
  }

  const allSteps = sessions.flatMap((s) => ledger.listSteps(s.id));
  const links = ledger.listLinks();
  const fileRefs = allSteps.flatMap((s) => ledger.listFiles(s.id));
  const files = [...new Set(fileRefs.map((f) => f.path))].sort();
  const distilled = sessions.flatMap((s) => atlas.general.listSteps(s.id)).length;

  console.log(`Seeded demo archive at ${projectDir}`);
  console.log(`  sessions: ${sessions.length}`);
  for (const s of sessions) console.log(`    ${s.id}\t${s.title}`);
  console.log(`  steps: ${allSteps.length}`);
  console.log(`  links: ${links.length}`);
  console.log(`  file refs: ${fileRefs.length} (${files.length} unique paths)`);
  console.log(`  general memory distilled: ${distilled} steps`);

  atlas.archive.close();
  atlas.general.close();
}

try {
  main();
} catch (err) {
  console.error("seed failed:", err);
  process.exit(1);
}
