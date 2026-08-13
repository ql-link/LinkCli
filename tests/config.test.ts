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
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "mysql://localhost/linkcli", ADMIN_API_KEY: "admin-key-with-at-least-24-chars", PROJECT_CREDENTIAL_KEY: testKey });
    expect(config.PORT).toBe(3000);
    expect(config.PROJECT_CREDENTIAL_KEY_ID).toBe("v1");
    expect(config.L3_BATCH_ENABLED).toBe(true);
    expect(config.L3_BATCH_INTERVAL_MS).toBe(300_000);
  });

  it("allows the L3 batch scheduler and thresholds to be configured", () => {
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "mysql://localhost/linkcli", ADMIN_API_KEY: "admin-key-with-at-least-24-chars", PROJECT_CREDENTIAL_KEY: testKey, L3_BATCH_ENABLED: "false", L3_BATCH_INTERVAL_MS: "1000", L3_MINIMUM_SAMPLES: "3", L3_JOIN_SIMILARITY: "0.7" });
    expect(config.L3_BATCH_ENABLED).toBe(false);
    expect(config.L3_BATCH_INTERVAL_MS).toBe(1_000);
    expect(config.L3_MINIMUM_SAMPLES).toBe(3);
    expect(config.L3_JOIN_SIMILARITY).toBe(0.7);
  });

  it("preserves the browser host through the development proxy for same-origin writes", () => {
    const proxy = (viteConfig as UserConfig).server?.proxy;
    expect(proxy?.["/api"]).toMatchObject({ target: "http://127.0.0.1:3000", changeOrigin: false });
  });
});
