import { pipeline, type FeatureExtractionPipelineType } from "@huggingface/transformers";

const createFeatureExtractionPipeline = pipeline as unknown as (
  task:"feature-extraction",model:string,options:Record<string,unknown>,
)=>Promise<FeatureExtractionPipelineType>;

export interface EmbeddingProvider {
  /** `<provider>:<model_name>:<dim>`，写入 mcp_query_cluster.embedding_model_version */
  readonly modelVersion: string;
  /** 显式为 false 时只允许影子聚类，不得将候选投递给 L4。 */
  readonly candidateHandoffEnabled?: boolean;
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
  readonly candidateHandoffEnabled = true;
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

export interface LocalEmbeddingProviderOptions {
  dtype?: "auto" | "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "bnb4" | "q4f16";
  cacheDir?: string;
  revision?: string;
  localFilesOnly?: boolean;
}

/** 使用 Transformers.js + ONNX 在 LinkCli 进程内生成归一化句向量。模型按需加载并复用。 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly modelVersion: string;
  readonly candidateHandoffEnabled = true;
  private extractorPromise: Promise<FeatureExtractionPipelineType> | null = null;

  constructor(private readonly modelName: string, private readonly dimensions: number, private readonly options: LocalEmbeddingProviderOptions = {}) {
    this.modelVersion = `local:${modelName}:${dimensions}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.extractor();
    const output = await extractor(texts,{pooling:"mean",normalize:true});
    const expectedSize = texts.length * this.dimensions;
    if (output.size !== expectedSize || output.dims.at(-1) !== this.dimensions) {
      throw new Error(`Local embedding model returned shape [${output.dims.join(",")}] for ${texts.length} inputs; expected [${texts.length},${this.dimensions}]`);
    }
    const values = Array.from(output.data,(value)=>Number(value));
    return texts.map((_,index)=>values.slice(index*this.dimensions,(index+1)*this.dimensions));
  }

  private extractor(): Promise<FeatureExtractionPipelineType> {
    this.extractorPromise ??= createFeatureExtractionPipeline("feature-extraction",this.modelName,{
      dtype:this.options.dtype??"q8",cache_dir:this.options.cacheDir,revision:this.options.revision,
      local_files_only:this.options.localFilesOnly??false,
    });
    return this.extractorPromise;
  }
}

/**
 * 非语义的确定性兜底实现：基于词级 n-gram 的哈希词袋向量，只用于离线开发、测试和没有配置真实 Embedding
 * Provider 时的降级展示，绝不能用于生产候选判断——它仍然是字面近似，不是语义相似度。生产环境启动时若
 * 检测到只有该实现可用，应记录告警并保持影子运行，不把它产生的类别送入 L4（见 MCPSTAT-1-L3 §16）。
 */
export class DeterministicFallbackEmbeddingProvider implements EmbeddingProvider {
  readonly modelVersion = "fallback:word-ngram-hash:256";
  readonly candidateHandoffEnabled = false;
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
