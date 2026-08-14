export interface EmbeddingProvider {
  /** `<provider>:<model_name>:<dim>`，写入 mcp_query_cluster.embedding_model_version */
  readonly modelVersion: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface RemoteEmbeddingProviderConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  dimensions: number;
  timeoutMs?: number;
}

/**
 * 调用 OpenAI 兼容的 /embeddings 接口（通义千问 DashScope 兼容模式、其他自建服务均满足该形状）。
 * 具体 endpoint、apiKey、model 由部署配置提供，不写死在代码里。
 */
export class RemoteEmbeddingProvider implements EmbeddingProvider {
  readonly modelVersion: string;
  constructor(private readonly config: RemoteEmbeddingProviderConfig) {
    this.modelVersion = `remote:${config.model}:${config.dimensions}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await fetch(this.config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify({ model: this.config.model, input: texts }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
    });
    if (!response.ok) throw new Error(`Embedding provider returned ${response.status}`);
    const body = (await response.json()) as { data?: Array<{ embedding: number[]; index?: number }> };
    const rows = body.data ?? [];
    if (rows.length !== texts.length) throw new Error(`Embedding provider returned ${rows.length} vectors for ${texts.length} inputs`);
    const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const row of ordered) {
      if (!Array.isArray(row.embedding) || row.embedding.length !== this.config.dimensions) {
        throw new Error(`Embedding provider returned vector of unexpected dimension`);
      }
    }
    return ordered.map((row) => row.embedding);
  }
}

/**
 * 本地进程内推理占位实现：待接入开源多语言句向量模型（如 transformers.js + ONNX）时替换本文件内部实现，
 * 对外的 EmbeddingProvider 接口和调用方不需要改动。当前尚未引入模型依赖，构造时直接报错，避免被误当作可用实现。
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly modelVersion: string;
  constructor(modelName: string, _dimensions: number) {
    this.modelVersion = `local:${modelName}`;
    throw new Error("LocalEmbeddingProvider is not wired to a model yet; configure RemoteEmbeddingProvider or provide a model dependency first");
  }
  async embed(): Promise<number[][]> {
    throw new Error("LocalEmbeddingProvider is not wired to a model yet");
  }
}

/**
 * 非语义的确定性兜底实现：基于词级 n-gram 的哈希词袋向量，只用于离线开发、测试和没有配置真实 Embedding
 * Provider 时的降级展示，绝不能用于生产候选判断——它仍然是字面近似，不是语义相似度。生产环境启动时若
 * 检测到只有该实现可用，应记录告警并保持影子运行，不把它产生的类别送入 L4（见 MCPSTAT-1-L3 §16）。
 */
export class DeterministicFallbackEmbeddingProvider implements EmbeddingProvider {
  readonly modelVersion = "fallback:word-ngram-hash:256";
  private readonly dimensions = 256;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.vectorOf(text));
  }

  private vectorOf(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const words = text.normalize("NFKC").toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    const tokens = words.length > 1 ? words : [...text.normalize("NFKC").toLocaleLowerCase()];
    for (let i = 0; i < tokens.length; i += 1) {
      for (const n of [1, 2]) {
        if (i + n > tokens.length) continue;
        const gram = tokens.slice(i, i + n).join(" ");
        const bucket = this.hash(gram) % this.dimensions;
        vector[bucket] = (vector[bucket] ?? 0) + 1;
      }
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm === 0 ? vector : vector.map((value) => value / norm);
  }

  private hash(value: string): number {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return hash >>> 0;
  }
}
