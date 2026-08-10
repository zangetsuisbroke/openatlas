import { describe, expect, test } from "bun:test";
import { SseHub } from "./sseHub.ts";
import { emitOpenCodeEvent } from "./harness.ts";

const GUARD_MS = 3000;

async function readChunks(stream: ReadableStream<Uint8Array>, count: number): Promise<string[]> {
  const reader = stream.getReader();
  const out: string[] = [];
  try {
    while (out.length < count) {
      const next = Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("read timeout")), GUARD_MS)),
      ]);
      const { done, value } = await next;
      if (done) break;
      out.push(new TextDecoder().decode(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out;
}

describe("SseHub (B1)", () => {
  test("one harness subscription fans out to every client", async () => {
    const hub = new SseHub();
    const c1 = hub.connect();
    const c2 = hub.connect();
    expect(hub.clientCount).toBe(2);

    emitOpenCodeEvent({ type: "session.next.tool.called", properties: { sessionID: "s1", callID: "c1" } });
    emitOpenCodeEvent({ type: "session.error", properties: { sessionID: "s1" } });

    const got1 = await readChunks(c1, 2);
    const got2 = await readChunks(c2, 2);
    expect(got1.length).toBe(2);
    expect(got2.length).toBe(2);
    expect(got1[0]).toContain("event: session.next.tool.called");
    expect(got1[0]).toContain('"callID":"c1"');
    expect(got1[1]).toContain("event: session.error");
  });

  test("cancelling one client removes only it; the others keep receiving", async () => {
    const hub = new SseHub();
    const c1 = hub.connect();
    const c2 = hub.connect();
    expect(hub.clientCount).toBe(2);

    await c1.cancel();
    expect(hub.clientCount).toBe(1);

    emitOpenCodeEvent({ type: "session.next.tool.success", properties: { sessionID: "s1" } });
    const got2 = await readChunks(c2, 1);
    expect(got2[0]).toContain("event: session.next.tool.success");
    expect(hub.clientCount).toBe(0);
  });

  test("abort signal removes the client without an explicit cancel", () => {
    const hub = new SseHub();
    const ac = new AbortController();
    hub.connect(ac.signal);
    expect(hub.clientCount).toBe(1);
    ac.abort();
    expect(hub.clientCount).toBe(0);
  });

  test("dropping the last client unsubscribes from the harness bus", async () => {
    const hub = new SseHub();
    const c1 = hub.connect();
    expect(hub.clientCount).toBe(1);
    expect((hub as unknown as { off: (() => void) | null }).off).not.toBeNull();
    await c1.cancel();
    expect(hub.clientCount).toBe(0);
    expect((hub as unknown as { off: (() => void) | null }).off).toBeNull();
  });
});
