import { randomUUID } from "node:crypto";
import type { CollectionRepository, CollectionSettings } from "./repository.js";

export interface CollectionWorkerOptions {
  batchSize: number;
  leaseMs: number;
  startedCallTimeoutMs: number;
  retryBaseMs: number;
}

export class CollectionWorker {
  private readonly workerId = `collection-${randomUUID()}`;

  constructor(
    private readonly repository: CollectionRepository,
    private readonly settings: CollectionSettings,
    private readonly options: CollectionWorkerOptions,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async drainOnce(): Promise<{ claimed: number; delivered: number; failed: number }> {
    const now = this.clock();
    await this.repository.reconcileStarted(new Date(now.getTime() - this.options.startedCallTimeoutMs));
    const records = await this.repository.claimReady(this.workerId, now, this.options.leaseMs, this.options.batchSize);
    let delivered = 0; let failed = 0;
    for (const record of records) {
      try {
        await this.repository.ingestCall(record, this.settings, this.clock());
        if (await this.repository.markDelivered(record.id, this.workerId, this.clock())) delivered++;
      } catch {
        const delay = Math.min(60_000, this.options.retryBaseMs * 2 ** Math.max(0, record.deliveryAttempts - 1));
        if (await this.repository.markDeliveryFailure(record.id, this.workerId, new Date(this.clock().getTime() + delay), this.settings.maxDeliveryAttempts)) failed++;
      }
    }
    return { claimed: records.length, delivered, failed };
  }

  async maintainOnce(): Promise<{ lifecycleChanges: number; settlements: number }> {
    const now = this.clock();
    const lifecycleChanges = await this.repository.advanceTurnLifecycles(this.settings, now);
    const settlements = await this.repository.settleReadyTurns(now, this.options.batchSize);
    return { lifecycleChanges, settlements };
  }
}

export class RetentionService {
  constructor(
    private readonly repository: CollectionRepository,
    private readonly detailRetentionDays: number,
    private readonly deliveredOutboxRetentionDays: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  runOnce(): Promise<{ callEvents: number; outbox: number }> {
    const now = this.clock();
    const day = 24 * 60 * 60 * 1_000;
    return this.repository.purgeExpired(new Date(now.getTime() - this.detailRetentionDays * day), new Date(now.getTime() - this.deliveredOutboxRetentionDays * day));
  }
}
