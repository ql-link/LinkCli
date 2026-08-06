import type { CallEnvelope } from "./envelope.js";

export interface EnvelopeSink { send(envelope: CallEnvelope): Promise<void>; }
export interface DispatcherMetrics { accepted: number; delivered: number; failed: number; dropped: number; }

export class HttpEnvelopeSink implements EnvelopeSink {
  constructor(private readonly endpoint: string, private readonly timeoutMs = 5_000) {}
  async send(envelope: CallEnvelope): Promise<void> {
    const response = await fetch(this.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`L2 returned ${response.status}`);
  }
}

export class NoopEnvelopeSink implements EnvelopeSink { async send(): Promise<void> {} }

export class BoundedDispatcher {
  readonly metrics: DispatcherMetrics = { accepted: 0, delivered: 0, failed: 0, dropped: 0 };
  private readonly queue: CallEnvelope[] = [];
  private processing = false;
  private idleResolvers: Array<() => void> = [];
  constructor(private readonly sink: EnvelopeSink, private readonly capacity: number) {}

  enqueue(envelope: CallEnvelope): boolean {
    if (this.queue.length >= this.capacity) { this.metrics.dropped += 1; return false; }
    this.queue.push(envelope); this.metrics.accepted += 1;
    if (!this.processing) void this.process();
    return true;
  }

  async idle(): Promise<void> {
    if (!this.processing && this.queue.length === 0) return;
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  private async process(): Promise<void> {
    this.processing = true;
    while (this.queue.length) {
      const envelope = this.queue.shift()!;
      try { await this.sink.send(envelope); this.metrics.delivered += 1; }
      catch { this.metrics.failed += 1; }
    }
    this.processing = false;
    const resolvers = this.idleResolvers.splice(0);
    for (const resolve of resolvers) resolve();
  }
}
