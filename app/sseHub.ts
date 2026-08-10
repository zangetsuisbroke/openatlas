import { onOpenCodeEvent } from "./harness.ts";

interface HubClient {
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  aborted: boolean;
  pending: Uint8Array[];
}

const MAX_PENDING = 256;
// ReadableStreamDefaultController's desiredSize = highWaterMark - queueSize,
// with a default highWaterMark of 1. A fresh client sits at 0/-1 until it
// reads once, so dropping at <= 0 would discard legitimate early events. Only
// start dropping once the queue is genuinely backed up (a stuck/slow client).
const MAX_QUEUE = 64;
const MIN_DESIRED_SIZE = -(MAX_QUEUE - 1);

/**
 * Refcounted multicast hub for the live reasoning feed.
 *
 * One subscription to the harness event bus is shared by every connected SSE
 * client, so fan-out is O(clients) per event instead of O(clients^2) (the old
 * design registered one harness handler per client, each iterating all
 * controllers). A slow client (desiredSize <= 0) is skipped rather than buffered
 * forever, and a dead/cancelled client removes only itself. The harness
 * subscription is torn down when the last client disconnects.
 */
export class SseHub {
  private clients = new Set<HubClient>();
  private off: (() => void) | null = null;
  private enc = new TextEncoder();

  private unsubscribe(): void {
    this.off?.();
    this.off = null;
  }

  private broadcast(ev: { type: string; properties: Record<string, unknown> }): void {
    const line = this.enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev.properties)}\n\n`);
    for (const c of this.clients) {
      const ctrl = c.controller;
      // Bun does not invoke ReadableStream start() synchronously at
      // construction, so a freshly connected client may not have a controller
      // yet when an event fires. Buffer those events (bounded) and flush them
      // when start() runs, so no event is dropped in the connect window.
      if (!ctrl) {
        if (c.pending.length < MAX_PENDING) c.pending.push(line);
        continue;
      }
      if (ctrl.desiredSize !== null && ctrl.desiredSize !== undefined && ctrl.desiredSize < MIN_DESIRED_SIZE) continue;
      try {
        ctrl.enqueue(line);
      } catch {
        this.clients.delete(c);
      }
    }
    if (this.clients.size === 0) this.unsubscribe();
  }

  connect(signal?: AbortSignal | null): ReadableStream<Uint8Array> {
    if (!this.off) this.off = onOpenCodeEvent((ev) => this.broadcast(ev));
    const client: HubClient = { controller: null, aborted: false, pending: [] };
    // Track the client immediately (start() may be deferred by the runtime),
    // so clientCount reflects connected clients from the moment connect() runs.
    this.clients.add(client);
    const remove = (): void => {
      if (client.aborted) return;
      client.aborted = true;
      client.pending = [];
      this.clients.delete(client);
      if (this.clients.size === 0) this.unsubscribe();
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        client.controller = controller;
        if (client.aborted) return;
        for (const chunk of client.pending) controller.enqueue(chunk);
        client.pending = [];
      },
      cancel: () => {
        remove();
      },
    });
    signal?.addEventListener?.("abort", () => remove(), { once: true });
    return stream;
  }

  get clientCount(): number {
    return this.clients.size;
  }
}
