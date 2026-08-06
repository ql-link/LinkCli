export interface RegistryEvent {
  type: "tool.suspended" | "tool.restored" | "version.published" | "health.alert" | "review.stale" | "tool.suspension.stale";
  projectKey: string;
  toolName?: string;
  versionId?: string;
  reason?: string;
}

export interface RegistryEventSink { publish(event: RegistryEvent): Promise<void>; }
export class NoopRegistryEventSink implements RegistryEventSink { async publish(): Promise<void> {} }
export class HttpRegistryEventSink implements RegistryEventSink {
  constructor(private readonly endpoint: string, private readonly timeoutMs = 5_000) {}
  async publish(event: RegistryEvent): Promise<void> {
    const response = await fetch(this.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`Registry event endpoint returned ${response.status}`);
  }
}
