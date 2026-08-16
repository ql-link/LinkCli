import { describe, expect, it } from "vitest";
import type { UserConfig } from "vite";
import { loadConfig } from "../src/config.js";
import viteConfig from "../web/vite.config.js";
import { testKey } from "./fixtures/harness.js";

describe("startup configuration", () => {
  it("rejects missing secrets before the service starts", () => {
    expect(() => loadConfig({ NODE_ENV: "test" })).toThrow(/DATABASE_URL/);
  });

  it("accepts a complete configuration and decodes a 32-byte key", () => {
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "mysql://localhost/linkcli", ADMIN_API_KEY: "admin-key-with-at-least-24-chars", PROJECT_CREDENTIAL_KEY: testKey, COLLECTION_FINGERPRINT_KEY: Buffer.alloc(32, 8).toString("base64") });
    expect(config.PORT).toBe(3000);
    expect(config.PROJECT_CREDENTIAL_KEY_ID).toBe("v1");
    expect(config.COLLECTION_DETAIL_RETENTION_DAYS).toBe(90);
    expect(config.L3_BATCH_ENABLED).toBe(true);
    expect(config.L3_BATCH_INTERVAL_MS).toBe(300_000);
    expect(config.L3_CANDIDATE_HANDOFF_ENABLED).toBe(false);
  });

  it("allows the L3 batch scheduler and thresholds to be configured", () => {
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "mysql://localhost/linkcli", ADMIN_API_KEY: "admin-key-with-at-least-24-chars", PROJECT_CREDENTIAL_KEY: testKey, COLLECTION_FINGERPRINT_KEY: Buffer.alloc(32, 8).toString("base64"), L3_BATCH_ENABLED: "false", L3_BATCH_INTERVAL_MS: "1000", L3_MINIMUM_SAMPLES: "3", L3_RECALL_TOP_K: "4", L3_REPRESENTATIVE_QUERY_LIMIT: "2", L3_MINIMUM_RECALL_SIMILARITY: "0.25", L3_MINIMUM_REBUILD_MEMBERS: "4", L3_REBUILD_INTERVAL_MS: "2000" });
    expect(config.L3_BATCH_ENABLED).toBe(false);
    expect(config.L3_BATCH_INTERVAL_MS).toBe(1_000);
    expect(config.L3_MINIMUM_SAMPLES).toBe(3);
    expect(config.L3_RECALL_TOP_K).toBe(4);
    expect(config.L3_REPRESENTATIVE_QUERY_LIMIT).toBe(2);
    expect(config.L3_MINIMUM_RECALL_SIMILARITY).toBe(0.25);
    expect(config.L3_MINIMUM_REBUILD_MEMBERS).toBe(4);
    expect(config.L3_REBUILD_INTERVAL_MS).toBe(2_000);
  });

  it("requires an independent collection fingerprint key", () => {
    expect(() => loadConfig({ NODE_ENV: "test", DATABASE_URL: "mysql://localhost/linkcli", ADMIN_API_KEY: "admin-key-with-at-least-24-chars", PROJECT_CREDENTIAL_KEY: testKey, COLLECTION_FINGERPRINT_KEY: testKey })).toThrow(/must be independent/);
  });

  it("requires a complete semantic embedding configuration before L4 handoff", () => {
    const base={NODE_ENV:"test",DATABASE_URL:"mysql://localhost/linkcli",ADMIN_API_KEY:"admin-key-with-at-least-24-chars",PROJECT_CREDENTIAL_KEY:testKey,COLLECTION_FINGERPRINT_KEY:Buffer.alloc(32,8).toString("base64")};
    expect(()=>loadConfig({...base,L3_EMBEDDING_ENDPOINT:"https://embedding.example/v1/embeddings"})).toThrow(/must be configured together/);
    expect(()=>loadConfig({...base,L3_CANDIDATE_HANDOFF_ENABLED:"true"})).toThrow(/candidate handoff requires/);
    const judge={L3_JUDGE_PROVIDER:"remote",L3_LLM_ENDPOINT:"https://llm.example/v1/chat/completions",L3_LLM_API_KEY:"secret",L3_LLM_MODEL:"judge-model"};
    expect(()=>loadConfig({...base,L3_LLM_ENDPOINT:"https://llm.example/v1/chat/completions"})).toThrow(/must be configured together/);
    const config=loadConfig({...base,...judge,L3_CANDIDATE_HANDOFF_ENABLED:"true",L3_EMBEDDING_ENDPOINT:"https://embedding.example/v1/embeddings",L3_EMBEDDING_API_KEY:"secret",L3_EMBEDDING_MODEL:"semantic-model",L3_EMBEDDING_DIMENSIONS:"1024"});
    expect(config.L3_CANDIDATE_HANDOFF_ENABLED).toBe(true);
    const local=loadConfig({...base,...judge,L3_CANDIDATE_HANDOFF_ENABLED:"true",L3_LOCAL_EMBEDDING_MODEL:"local-model",L3_LOCAL_EMBEDDING_DIMENSIONS:"384"});
    expect(local.L3_LOCAL_EMBEDDING_DTYPE).toBe("q8");
    expect(local.L3_LOCAL_EMBEDDING_LOCAL_FILES_ONLY).toBe(true);
    const cli=loadConfig({...base,L3_JUDGE_PROVIDER:"codex-cli",L3_CANDIDATE_HANDOFF_ENABLED:"true",L3_LOCAL_EMBEDDING_MODEL:"local-model",L3_LOCAL_EMBEDDING_DIMENSIONS:"384"});
    expect(cli.L3_CODEX_CLI_MODEL).toBe("gpt-5.3-codex-spark");
    expect(cli.L3_CODEX_CLI_REASONING_EFFORT).toBe("medium");
    expect(()=>loadConfig({...base,L3_LOCAL_EMBEDDING_MODEL:"local-model",L3_LOCAL_EMBEDDING_DIMENSIONS:"384",L3_EMBEDDING_ENDPOINT:"https://embedding.example/v1/embeddings",L3_EMBEDDING_API_KEY:"secret",L3_EMBEDDING_MODEL:"semantic-model",L3_EMBEDDING_DIMENSIONS:"1024"})).toThrow(/either remote or local/);
  });

  it("preserves the browser host through the development proxy for same-origin writes", () => {
    const proxy = (viteConfig as UserConfig).server?.proxy;
    expect(proxy?.["/api"]).toMatchObject({ target: "http://127.0.0.1:3000", changeOrigin: false });
  });
});
