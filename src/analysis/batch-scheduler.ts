import type { AnalysisBatchService, BatchResult } from "./batch-service.js";

export class AnalysisBatchScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<BatchResult> | null = null;
  constructor(private readonly service: AnalysisBatchService, private readonly intervalMs: number, private readonly batchSize: number, private readonly onError: (error: unknown) => void = console.error) {}
  start(): void {
    if (this.timer) return;
    void this.runOnce().catch(() => undefined);
    this.timer = setInterval(() => { void this.runOnce().catch(() => undefined); }, this.intervalMs); this.timer.unref();
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = null; await this.running?.catch(() => undefined); }
  async runOnce(): Promise<BatchResult> {
    if (this.running) return this.running;
    this.running = this.service.runBatch(this.batchSize).then((result) => {
      if (result.failed > 0) this.onError(new Error(`L3 analysis batch left ${result.failed} input(s) pending after isolated failures`));
      return result;
    }).catch((error) => { this.onError(error); throw error; }).finally(() => { this.running = null; });
    return this.running;
  }
}
