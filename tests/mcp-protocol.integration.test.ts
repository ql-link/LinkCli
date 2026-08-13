import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { CONVERSATION_META_KEY, TURN_META_KEY } from "../src/collection/context.js";
import { USER_QUESTION_FIELD } from "../src/gateway/catalog.js";
import { approve, createHarness, registerSubmitted } from "./fixtures/harness.js";

describe("standard MCP Streamable HTTP boundary", () => {
  const close: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const item of close.splice(0).reverse()) await item(); });

  it("supports initialize, tools/list and tools/call through /mcp", async () => {
    const h = createHarness(); const registered = await registerSubmitted(h); await approve(h, registered.version.id);
    const issued = await h.credentials.issue("agent-1", "Protocol test", null);
    const app = createApp({ projects: h.projects, reviews: h.reviews, health: h.health, credentials: h.credentials, catalog: h.catalog, gateway: h.gateway }, "admin-key-with-at-least-24-chars");
    const httpServer = app.listen(0, "127.0.0.1"); await once(httpServer, "listening");
    close.push(() => new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve())));
    const address = httpServer.address() as AddressInfo;
    const client = new Client({ name: "linkcli-test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${issued.token}`, "x-linkcli-session-id": "protocol-test" } } });
    close.push(async () => { await client.close(); });
    await client.connect(transport);
    expect(client.getInstructions()).toContain(CONVERSATION_META_KEY);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["knowledge__search"]);
    expect(tools.tools[0]?.inputSchema.required).toContain(USER_QUESTION_FIELD);
    const meta = { [CONVERSATION_META_KEY]: "protocol-chat", [TURN_META_KEY]: "protocol-turn" };
    const result = await client.callTool({ name: "knowledge__search", arguments: { query: "规划", [USER_QUESTION_FIELD]: "下一步如何规划？" }, _meta: meta });
    await client.callTool({ name: "knowledge__search", arguments: { query: "风险", [USER_QUESTION_FIELD]: "下一步如何规划？" }, _meta: meta });
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(h.connector.endpoints.get(registered.version.endpoint)!.calls).toHaveLength(2);
    await h.collectionWorker.drainOnce();
    expect(await h.collection.listTurns()).toHaveLength(1);
    expect((await h.collection.listTurns())[0]?.callCount).toBe(2);
  });
});
