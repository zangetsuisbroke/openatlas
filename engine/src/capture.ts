import { extractFileRefs, toolFileKind } from "./refs";
import { debugLog, logError } from "./debug";
import type { Ledger } from "./ledger";
import type { LogStore } from "./logstore";

export interface CaptureContext {
  agent?: string | null;
  model?: string | null;
  source?: string | null;
}

interface TextPart {
  type: "text";
  text: string;
}

function textOf(parts: unknown[] | undefined): string {
  if (!Array.isArray(parts)) return "";
  return (parts.filter((p): p is TextPart => {
    const o = p as Record<string, unknown> | null;
    return !!o && o.type === "text" && typeof o.text === "string";
  }) as TextPart[])
    .map((p) => p.text)
    .join("\n");
}

function payloadOf(event: Record<string, unknown>): Record<string, any> {
  return (event.properties ?? event.data ?? {}) as Record<string, any>;
}

interface ToolPartState {
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string | Record<string, unknown>;
}

interface PartShape {
  type?: string;
  id?: string;
  messageID?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: ToolPartState;
}

const READ_TOOLS = new Set(["read", "search", "glob", "grep"]);
const TARGET_TOOLS = new Set(["edit", "write", "bash", "patch", "apply_patch", "bunx"]);
const TEST_PATTERN = /\b(bun test|npm test|npm run test|pytest|go test|cargo test|jest|vitest|tsc --noEmit)\b/i;

export class Capturer {
  private ledger: Ledger;
  private logstore: LogStore | null;
  private ctx: CaptureContext;
  private knownSessions = new Set<string>();
  private curAssistant = new Map<string, string>();
  private taskByMessage = new Map<string, string>();
  private messageRole = new Map<string, string>();
  private seenMessages = new Set<string>();
  private seenTexts = new Set<string>();
  private seenReasonings = new Set<string>();
  private openTools = new Map<string, { stepId: string; tool: string }>();
  private openBash = new Map<string, string>();
  private lastErrorStep = new Map<string, string>();
  private unknownSeen = new Map<string, number>();
  private seenEvents = new Set<string>();

  constructor(ledger: Ledger, opts: { logstore?: LogStore | null; ctx?: CaptureContext } = {}) {
    this.ledger = ledger;
    this.logstore = opts.logstore ?? null;
    this.ctx = opts.ctx ?? {};
  }

  ingest(event: unknown): void {
    const ev = (event ?? {}) as Record<string, any>;
    const d = payloadOf(ev);
    if (this.logstore && d.sessionID) {
      this.logstore.append(String(d.sessionID), event);
    }
    try {
      this.route(ev);
    } catch (err) {
      logError("capture.error", `type=${String(ev.type ?? "?")}`, err);
      /* capture must never break the host */
    }
  }

  private route(ev: Record<string, any>): void {
    const type: string = ev.type ?? "";
    const d = payloadOf(ev);
    if (!d.sessionID || typeof d.sessionID !== "string") {
      if (type) debugLog("capture.skip", `type=${type} reason=no-sessionID`);
      return;
    }
    debugLog("capture.event", `type=${type} session=${d.sessionID}`);
    const sessionID = d.sessionID;
    // Idempotency fast-path: opencode event ids are stable across SSE replays,
    // so a replayed event (reconnect, duplicate delivery) is dropped before it
    // can double-apply. The durable backstop lives in the ledger's
    // (session_id, source_id) / (session_id, message_id) unique indexes.
    if (typeof ev.id === "string" && ev.id) {
      const ekey = `${sessionID}:${ev.id}`;
      if (this.seenEvents.has(ekey)) return;
      this.seenEvents.add(ekey);
    }

    switch (type) {
      case "session.created": {
        this.ensureSession(d.sessionID, d.info ?? d.session ?? {});
        break;
      }
      case "message.updated": {
        const sessionID = d.sessionID;
        const info = d.info ?? d.message ?? {};
        const role: string = info.role ?? "user";
        const mid = info.id ? String(info.id) : null;
        if (mid) this.messageRole.set(`${sessionID}:${mid}`, role);
        const dedupKey = mid ? `${sessionID}:${mid}` : null;
        if (dedupKey) {
          if (this.seenMessages.has(dedupKey)) break;
          this.seenMessages.add(dedupKey);
        }
        this.ensureSession(sessionID, info);
        const text = textOf(info.parts);
        if (role === "user") {
          this.recordTask(sessionID, mid, text, ev.id);
        } else if (role === "assistant" && text) {
          this.recordAssistantText(sessionID, mid, text, ev.id);
        }
        break;
      }
      case "message.part.updated": {
        const sessionID = d.sessionID;
        this.ensureSession(sessionID);
        this.ingestPart(sessionID, (d.part ?? {}) as PartShape);
        break;
      }
      case "session.next.text.ended": {
        const sessionID = String(d.sessionID);
        if (d.text) this.attachText(sessionID, d.textID ? String(d.textID) : null, String(d.text), d.assistantMessageID ? String(d.assistantMessageID) : null);
        break;
      }
      case "session.next.reasoning.ended": {
        const sessionID = String(d.sessionID);
        if (d.text) this.attachReasoning(sessionID, d.reasoningID ? String(d.reasoningID) : null, String(d.text));
        break;
      }
      case "session.next.tool.called": {
        const sessionID = d.sessionID;
        const callID = d.callID ? String(d.callID) : null;
        if (!callID) break;
        this.ensureSession(sessionID);
        this.ensureToolStep(sessionID, callID, String(d.tool ?? ""), (d.input ?? {}) as Record<string, unknown>, d.assistantMessageID ? String(d.assistantMessageID) : null, ev.id);
        break;
      }
      case "session.next.tool.success": {
        this.toolSucceeded(d.sessionID, d.callID ? String(d.callID) : null, { content: d.content, structured: d.structured });
        break;
      }
      case "session.next.tool.failed": {
        this.toolFailed(d.sessionID, d.callID ? String(d.callID) : null, d.error, d.result, ev.id);
        break;
      }
      case "session.next.step.ended": {
        const sessionID = String(d.sessionID);
        const parent = this.curAssistant.get(sessionID);
        if (parent && Array.isArray(d.files)) {
          for (const f of d.files) {
            const refs = extractFileRefs({ filePath: f }, this.ledger.root);
            for (const r of refs) this.ledger.addFileRef(parent, r, "target");
          }
        }
        if (d.finish === "error") {
          const errStep = this.ledger.addStep({
            sessionId: sessionID,
            kind: "error",
            role: "assistant",
            content: "assistant step failed to complete",
            meta: { finish: "error", assistantMessageID: d.assistantMessageID },
            sourceId: ev.id,
          });
          this.lastErrorStep.set(sessionID, errStep.id);
        }
        break;
      }
      case "session.next.step.failed": {
        const sessionID = String(d.sessionID);
        const errText = d.error ? JSON.stringify(d.error) : "step failed";
        const errStep = this.ledger.addStep({
          sessionId: sessionID,
          kind: "error",
          role: "assistant",
          content: errText.slice(0, 2000),
          meta: { assistantMessageID: d.assistantMessageID },
          sourceId: ev.id,
        });
        this.lastErrorStep.set(sessionID, errStep.id);
        break;
      }
      case "session.error": {
        const sessionID = String(d.sessionID);
        if (!sessionID) break;
        this.ensureSession(sessionID);
        const errText = d.error ? JSON.stringify(d.error) : "session error";
        this.ledger.addStep({
          sessionId: sessionID,
          kind: "error",
          role: "system",
          content: errText.slice(0, 2000),
          meta: { source: "session.error" },
          sourceId: ev.id,
        });
        break;
      }
      case "file.edited": {
        const sessionID = String(d.sessionID);
        const parent = this.curAssistant.get(sessionID);
        if (parent && d.file) {
          const refs = extractFileRefs({ filePath: d.file }, this.ledger.root);
          for (const r of refs) this.ledger.addFileRef(parent, r, "target");
        }
        break;
      }
      case "session.diff": {
        const sessionID = String(d.sessionID);
        const parent = this.curAssistant.get(sessionID);
        if (!parent || !Array.isArray(d.diff)) break;
        for (const diff of d.diff) {
          const patch = diff.patch ?? "";
          if (patch) this.ledger.addPayload(parent, "diff", patch);
          const refs = extractFileRefs({ diff: patch, filePath: diff.file }, this.ledger.root);
          for (const r of refs) this.ledger.addFileRef(parent, r, "target");
        }
        break;
      }
      case "command.executed": {
        const sessionID = String(d.sessionID);
        if (!sessionID) break;
        this.ensureSession(sessionID);
        const cmd = d.command
          ? String(d.command)
          : [d.name, d.arguments].filter((x) => typeof x === "string" && x).join(" ") || null;
        this.ledger.addStep({
          sessionId: sessionID,
          kind: "action",
          role: "system",
          content: cmd,
          meta: { source: "command.executed", name: d.name ?? null },
          sourceId: ev.id,
        });
        break;
      }
      case "session.compacted":
      case "session.next.compaction.ended": {
        const sessionID = String(d.sessionID);
        if (!sessionID) break;
        this.ensureSession(sessionID);
        this.ledger.addStep({
          sessionId: sessionID,
          kind: "insight",
          role: "system",
          content: "context compacted",
          meta: { source: "compaction" },
          sourceId: ev.id,
        });
        break;
      }
      case "session.idle": {
        // Lifecycle is owned by the caller: the plugin hook and the app harness
        // both invoke finalizeSession (atlas.finalizeSession) on session.idle.
        // The Capturer stays a pure ingest pipeline so finalize runs exactly
        // once per session per caller.
        debugLog("capture.idle", `session=${String(d.sessionID)} (finalize driven by caller)`);
        break;
      }
      default:
        const n = (this.unknownSeen.get(type) ?? 0) + 1;
        this.unknownSeen.set(type, n);
        if (n === 1) debugLog("capture.unknown-type", `type=${type} session=${sessionID} (first occurrence; will log only once)`);
        else if (n === 100) debugLog("capture.unknown-type", `type=${type} seen ${n} times total`);
        break;
    }
  }

  finalizeSession(sessionId: string): void {
    const session = this.ledger.getSession(sessionId);
    if (!session) return;
    const steps = this.ledger.listSteps(sessionId);
    const tasks = steps.filter((s) => s.kind === "task").map((s) => s.content ?? "").filter(Boolean);
    const title = session.title ?? (tasks[0] ? tasks[0].slice(0, 120) : null);
    const errorSteps = steps.filter((s) => s.kind === "error");
    const lessonSteps = steps.filter((s) => s.kind === "lesson");
    debugLog(
      "capture.finalize",
      `session=${sessionId} steps=${steps.length} errors=${errorSteps.length} lessons=${lessonSteps.length} title=${JSON.stringify(title)}`
    );
    const summary =
      [title, `${steps.length} steps`, errorSteps.length ? `${errorSteps.length} errors` : "no errors", lessonSteps.length ? `${lessonSteps.length} lessons` : ""]
        .filter(Boolean)
        .join(" · ") || null;
    // session.idle fires BETWEEN turns of a live session, not just at end; keep
    // the archive session open (ended_at untouched) so later turns still record.
    // The distilled general-memory copy in engine/src/atlas.ts still gets a
    // proper ended_at because it calls finishSession with the default markEnded:true.
    this.ledger.finishSession(sessionId, { title, summary, markEnded: false });
    this.ledger.linkSharedFiles(sessionId);
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1]!;
      const cur = steps[i]!;
      this.ledger.link({ sourceStepId: prev.id, targetStepId: cur.id, relation: "EXTENDS", origin: "auto", confidence: 0.35 });
    }
    this.curAssistant.delete(sessionId);
    this.knownSessions.add(sessionId);
    // Prune per-session state so a long-running harness never grows these
    // maps unboundedly. The archive DB retains the durable record; dedup sets
    // only guard against replay within an active session.
    const prefix = `${sessionId}:`;
    for (const key of this.seenMessages) if (key.startsWith(prefix)) this.seenMessages.delete(key);
    for (const key of this.seenTexts) if (key.startsWith(prefix)) this.seenTexts.delete(key);
    for (const key of this.seenReasonings) if (key.startsWith(prefix)) this.seenReasonings.delete(key);
    for (const key of this.seenEvents) if (key.startsWith(prefix)) this.seenEvents.delete(key);
    for (const [key] of this.messageRole) if (key.startsWith(prefix)) this.messageRole.delete(key);
    for (const [key] of this.taskByMessage) if (key.startsWith(prefix)) this.taskByMessage.delete(key);
    for (const [key] of this.openTools) if (key.startsWith(prefix)) this.openTools.delete(key);
    for (const [key] of this.openBash) if (key.startsWith(prefix)) this.openBash.delete(key);
    for (const [key] of this.lastErrorStep) if (key.startsWith(prefix)) this.lastErrorStep.delete(key);
  }

  private ensureSession(sessionID: string, info?: Record<string, unknown>): void {
    if (this.knownSessions.has(sessionID)) return;
    if (this.ledger.getSession(sessionID)) {
      this.knownSessions.add(sessionID);
      return;
    }
    let agent = this.ctx.agent ?? null;
    let model = this.ctx.model ?? null;
    if (info) {
      const sessionMeta = (info.session as Record<string, unknown> | undefined)?.agent ?? info.agent;
      if (typeof sessionMeta === "string") agent = sessionMeta;
      if (typeof info.model === "object" && info.model && "modelID" in info.model) model = String((info.model as { modelID: unknown }).modelID);
      if (typeof info.model === "string") model = info.model;
    }
    this.ledger.createSession({ id: sessionID, agent, model, source: this.ctx.source ?? "opencode" });
    this.knownSessions.add(sessionID);
  }

  private ingestPart(sessionID: string, part: PartShape): void {
    if (!part || typeof part.type !== "string") return;
    if (part.type === "text" && typeof part.text === "string") {
      const mid = part.messageID ? String(part.messageID) : null;
      const role = mid ? this.messageRole.get(`${sessionID}:${mid}`) : null;
      if (role === "user") {
        this.recordTask(sessionID, mid, part.text);
      } else {
        this.attachText(sessionID, part.id ? String(part.id) : null, part.text, mid);
      }
      return;
    }
    if (part.type === "reasoning" && typeof part.text === "string") {
      this.attachReasoning(sessionID, part.id ? String(part.id) : null, part.text);
      return;
    }
    if (part.type === "tool") {
      const callID = part.callID ? String(part.callID) : null;
      if (!callID) return;
      const tool = String(part.tool ?? "");
      const state = part.state ?? {};
      switch (state.status) {
        case "pending":
        case "running":
          this.ensureToolStep(sessionID, callID, tool, state.input ?? {}, part.messageID ? String(part.messageID) : null);
          break;
        case "completed":
          this.toolSucceeded(sessionID, callID, { output: state.output });
          break;
        case "error":
          this.ensureToolStep(sessionID, callID, tool, state.input ?? {}, part.messageID ? String(part.messageID) : null);
          this.toolFailed(sessionID, callID, state.error, null);
          break;
      }
    }
  }

  private attachText(sessionID: string, id: string | null, text: string, messageId: string | null): void {
    const dedup = id ?? messageId;
    if (dedup) {
      const key = `${sessionID}:${dedup}`;
      if (this.seenTexts.has(key)) return;
      this.seenTexts.add(key);
    }
    this.recordAssistantText(sessionID, messageId, text);
  }

  private attachReasoning(sessionID: string, id: string | null, text: string): void {
    if (id) {
      const key = `${sessionID}:${id}`;
      if (this.seenReasonings.has(key)) return;
      this.seenReasonings.add(key);
    }
    this.attachToAssistant(sessionID, "reasoning", text);
  }

  private recordTask(sessionID: string, messageId: string | null, text: string, sourceId?: string | null): string {
    if (messageId) {
      const key = `${sessionID}:${messageId}`;
      const existing = this.taskByMessage.get(key);
      if (existing) {
        const cur = this.ledger.getStep(existing);
        if (cur && text && !cur.content) {
          this.ledger.updateStep(existing, { content: text.slice(0, 2000) });
          const refs = extractFileRefs({ text }, this.ledger.root);
          for (const r of refs) this.ledger.addFileRef(existing, r, "mention");
        }
        this.curAssistant.set(sessionID, existing);
        return existing;
      }
      const step = this.ledger.addStep({ sessionId: sessionID, messageId, kind: "task", role: "user", content: text || null, sourceId: sourceId ?? null });
      this.taskByMessage.set(key, step.id);
      if (text) {
        const refs = extractFileRefs({ text }, this.ledger.root);
        for (const r of refs) this.ledger.addFileRef(step.id, r, "mention");
      }
      this.curAssistant.set(sessionID, step.id);
      return step.id;
    }
    const step = this.ledger.addStep({ sessionId: sessionID, kind: "task", role: "user", content: text || null, sourceId: sourceId ?? null });
    if (text) {
      const refs = extractFileRefs({ text }, this.ledger.root);
      for (const r of refs) this.ledger.addFileRef(step.id, r, "mention");
    }
    this.curAssistant.set(sessionID, step.id);
    return step.id;
  }

  private recordAssistantText(sessionID: string, messageId: string | null, text: string, sourceId?: string | null): void {
    const parent = this.curAssistant.get(sessionID);
    if (parent) {
      const parentStep = this.ledger.getStep(parent);
      if (parentStep?.kind === "task") {
        const step = this.ledger.addStep({ sessionId: sessionID, messageId, parentId: parent, kind: "plan", role: "assistant", content: text.slice(0, 2000), sourceId: sourceId ?? null });
        this.curAssistant.set(sessionID, step.id);
        return;
      }
      this.ledger.addPayload(parent, "text", text);
      return;
    }
    const step = this.ledger.addStep({ sessionId: sessionID, messageId, kind: "plan", role: "assistant", content: text.slice(0, 2000), sourceId: sourceId ?? null });
    this.curAssistant.set(sessionID, step.id);
  }

  private ensureToolStep(sessionID: string, callID: string, tool: string, input: Record<string, unknown>, messageId: string | null, sourceId?: string | null): void {
    const key = `${sessionID}:${callID}`;
    if (this.openTools.has(key)) return;
    this.ensureSession(sessionID);
    const parent = this.curAssistant.get(sessionID) ?? null;
    const step = this.ledger.addStep({
      sessionId: sessionID,
      messageId,
      parentId: parent,
      kind: TEST_PATTERN.test(String((input as { command?: unknown })?.command ?? "")) ? "verification" : "action",
      role: "tool",
      content: tool,
      meta: { tool, callID },
      sourceId: sourceId ?? null,
    });
    if (input && typeof input === "object") this.ledger.addPayload(step.id, "args", JSON.stringify(input, null, 2));
    this.addFileRefsFromArgs(step.id, tool, input, sessionID);
    this.openTools.set(key, { stepId: step.id, tool });
    if (tool === "bash") this.openBash.set(key, step.id);
  }

  private toolSucceeded(sessionID: string, callID: string | null, payload: { content?: unknown; structured?: unknown; output?: unknown }): void {
    if (!callID) return;
    const key = `${sessionID}:${callID}`;
    const open = this.openTools.get(key);
    this.openTools.delete(key);
    this.openBash.delete(key);
    const stepId = open?.stepId ?? this.findStepByCallId(sessionID, callID);
    if (!stepId) return;
    this.ledger.updateStep(stepId, { outcome: "success" });
    const content = Array.isArray(payload.content)
      ? payload.content
          .map((c: any) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : JSON.stringify(c)))
          .join("\n")
      : typeof payload.output === "string"
        ? payload.output
        : "";
    if (content) this.ledger.addPayload(stepId, "output", content);
    if (payload.structured && payload.structured !== null && payload.structured !== undefined) {
      this.ledger.addPayload(stepId, "result", JSON.stringify(payload.structured, null, 2));
    }
    this.addFileRefsFromText(stepId, content, sessionID);
  }

  private toolFailed(sessionID: string, callID: string | null, error: unknown, _result: unknown, sourceId?: string | null): void {
    if (!callID) return;
    const key = `${sessionID}:${callID}`;
    const open = this.openTools.get(key);
    this.openTools.delete(key);
    this.openBash.delete(key);
    const stepId = open?.stepId ?? this.findStepByCallId(sessionID, callID);
    if (stepId) this.ledger.updateStep(stepId, { outcome: "failed" });
    const errText = error ? (typeof error === "string" ? error : JSON.stringify(error)) : "";
    if (stepId && errText) this.ledger.addPayload(stepId, "error", errText);
    const errorStep = this.ledger.addStep({
      sessionId: sessionID,
      kind: "error",
      role: "tool",
      content: errText.slice(0, 2000) || `${open?.tool ?? "tool"} failed`,
      meta: { tool: open?.tool ?? null, callID },
      sourceId: sourceId ?? null,
    });
    if (stepId) this.ledger.link({ sourceStepId: errorStep.id, targetStepId: stepId, relation: "CAUSED_BY", origin: "auto", confidence: 1 });
    this.lastErrorStep.set(sessionID, errorStep.id);
  }

  private findStepByCallId(sessionID: string, callID: string): string | null {
    const steps = this.ledger.listSteps(sessionID);
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i]?.meta?.callID === callID) return steps[i]!.id;
    }
    return null;
  }

  private attachToAssistant(sessionID: string, kind: string, text: string): void {
    const parent = this.curAssistant.get(sessionID);
    if (parent) {
      this.ledger.addPayload(parent, kind, text);
    } else {
      const step = this.ledger.addStep({
        sessionId: sessionID,
        kind: kind === "reasoning" ? "hypothesis" : "insight",
        role: "assistant",
        content: text.slice(0, 2000),
      });
      this.curAssistant.set(sessionID, step.id);
    }
  }

  private addFileRefsFromArgs(stepId: string, tool: string, input: unknown, sessionID: string): void {
    void sessionID;
    const refs = extractFileRefs({ args: input }, this.ledger.root);
    const kind = toolFileKind(tool);
    for (const r of refs) this.ledger.addFileRef(stepId, r, kind);
  }

  private addFileRefsFromText(stepId: string, text: string, sessionID: string): void {
    void sessionID;
    const refs = extractFileRefs({ text }, this.ledger.root);
    for (const r of refs) this.ledger.addFileRef(stepId, r, "mention");
  }
}
