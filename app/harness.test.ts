import { describe, expect, test } from "bun:test";
import { parseEventStream } from "./harness.ts";

function sseResponse(text: string): Response {
  return new Response(new TextEncoder().encode(text));
}

async function collect(text: string): Promise<Array<{ type: string; data: unknown }>> {
  const out: Array<{ type: string; data: unknown }> = [];
  await parseEventStream(sseResponse(text), (type, data) => out.push({ type, data }));
  return out;
}

describe("harness SSE event parsing", () => {
  test("openCode /event payloads unwrap type + properties from the data object", async () => {
    const evs = await collect(
      'event: message\ndata: {"id":"evt1","type":"session.created","properties":{"sessionID":"s1","info":{"id":"s1"}},"time":123}\n\n'
    );
    expect(evs).toHaveLength(1);
    expect(evs[0]?.type).toBe("message");
    const obj = evs[0]!.data as { type: string; properties: Record<string, unknown> };
    expect(obj.type).toBe("session.created");
    expect(obj.properties.sessionID).toBe("s1");
  });

  test("the unwrap shape feeds capturer.ingest ({type, properties})", () => {
    const obj = { type: "message.part.updated", properties: { sessionID: "s1", part: { type: "text", text: "hi" } } };
    expect(obj.type).toBe("message.part.updated");
    expect(obj.properties.sessionID).toBe("s1");
  });

  test("[DONE] sentinels are dropped", async () => {
    const evs = await collect("event: message\ndata: [DONE]\n\nevent: message\ndata: {\"type\":\"session.idle\",\"properties\":{\"sessionID\":\"s1\"}}\n\n");
    expect(evs).toHaveLength(1);
  });

  test("multi-line data and bare event: lines keep the latest event name", async () => {
    const evs = await collect(
      'event: foo\n\nevent: message\ndata: {"type":"a","properties":{}}\n\n'
    );
    expect(evs).toHaveLength(1);
  });

  test("non-JSON data is passed through as raw", async () => {
    const evs = await collect("event: message\ndata: just-some-text\n\n");
    expect(evs[0]?.data).toBe("just-some-text");
  });

  test("chunked delivery across read boundaries is reassembled", async () => {
    const chunk = (t: string) => new TextEncoder().encode(t);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(chunk('event: message\ndata: {"type":"a","properties":{"n":'));
        c.enqueue(chunk('1},"time":1}\n\nevent: message\ndata: {"type":"b","pro'));
        c.enqueue(chunk('perties":{}}\n\n'));
        c.close();
      },
    });
    const out: Array<{ type: string; data: unknown }> = [];
    await parseEventStream(new Response(body), (type, data) => out.push({ type, data }));
    expect(out).toHaveLength(2);
    expect((out[0]!.data as { type: string }).type).toBe("a");
    expect((out[1]!.data as { type: string }).type).toBe("b");
  });
});
