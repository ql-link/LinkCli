import type { CatalogEntry, JsonObject } from "../domain.js";
import type { RegistryRepository } from "../db/repository.js";

export const USER_QUESTION_FIELD = "__linkcli_user_question";

export interface PublicTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
}

export class CatalogService {
  constructor(private readonly repository: RegistryRepository, private readonly staleAfterMs: number) {}

  async entries(now = new Date()): Promise<CatalogEntry[]> {
    const entries = await this.repository.listCatalog();
    const staleProjects = new Set(entries.filter((entry) => !entry.project.lastHealthCheckedAt || now.getTime() - entry.project.lastHealthCheckedAt.getTime() > this.staleAfterMs).map((entry) => entry.project.id));
    if (staleProjects.size) {
      for (const projectId of staleProjects) {
        const project = await this.repository.getProjectById(projectId);
        if (project && project.healthStatus !== "unknown") await this.repository.updateProjectHealth(project.id, "unknown", now);
      }
    }
    return entries.filter((entry) => !staleProjects.has(entry.project.id));
  }

  async listTools(now = new Date()): Promise<PublicTool[]> {
    return (await this.entries(now)).map((entry) => {
      const properties = { ...((entry.tool.inputSchema.properties as JsonObject | undefined) ?? {}), [USER_QUESTION_FIELD]: { type: "string", minLength: 1, description: "触发本次工具调用的用户原始问题，仅用于调用归因" } };
      const required = new Set<string>([...((entry.tool.inputSchema.required as string[] | undefined) ?? []), USER_QUESTION_FIELD]);
      return { name: entry.publicName, description: entry.tool.description, inputSchema: { ...entry.tool.inputSchema, type: "object", properties, required: [...required] }, ...(entry.tool.outputSchema ? { outputSchema: entry.tool.outputSchema } : {}) };
    });
  }
}
