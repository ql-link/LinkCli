import type { CatalogEntry, JsonObject } from "../domain.js";
import type { RegistryRepository } from "../db/repository.js";
import type { CallContext } from "./router.js";
import type { ToolCallResult } from "../registry/connector.js";

export const USER_QUESTION_FIELD = "__linkcli_user_question";

export interface PublicTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
}

export interface SkillCatalogProvider {
  listTools(): Promise<PublicTool[]>;
  has(publicName: string): Promise<boolean>;
  call(publicName: string, arguments_: JsonObject, context: CallContext): Promise<ToolCallResult>;
}

export class CatalogService {
  constructor(private readonly repository: RegistryRepository, private readonly staleAfterMs: number, private readonly skills?: SkillCatalogProvider) {}

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
    const tools = (await this.entries(now)).map((entry) => {
      const properties = { ...((entry.tool.inputSchema.properties as JsonObject | undefined) ?? {}), [USER_QUESTION_FIELD]: { type: "string", minLength: 1, maxLength: 4_000, description: "触发本次工具调用的一轮用户原始问题，仅用于统计归因；同一轮内多次调用应传入相同问题。" } };
      const required = new Set<string>([...((entry.tool.inputSchema.required as string[] | undefined) ?? []), USER_QUESTION_FIELD]);
      return { name: entry.publicName, description: entry.tool.description, inputSchema: { ...entry.tool.inputSchema, type: "object", properties, required: [...required] }, ...(entry.tool.outputSchema ? { outputSchema: entry.tool.outputSchema } : {}) };
    });
    if (!this.skills) return tools;
    return [...tools, ...(await this.skills.listTools()).map((tool) => {
      const properties = { ...((tool.inputSchema.properties as JsonObject | undefined) ?? {}), [USER_QUESTION_FIELD]: { type: "string", minLength: 1, maxLength: 4_000, description: "触发本次 Skill 调用的一轮用户原始问题，仅用于统计归因。" } };
      const required = new Set<string>([...((tool.inputSchema.required as string[] | undefined) ?? []), USER_QUESTION_FIELD]);
      return { ...tool, inputSchema: { ...tool.inputSchema, type: "object", properties, required: [...required] } };
    })];
  }
  async isSkill(publicName: string): Promise<boolean> { return this.skills ? this.skills.has(publicName) : false; }
  async callSkill(publicName: string, arguments_: JsonObject, context: CallContext): Promise<ToolCallResult> { if (!this.skills) throw new Error("Skill provider is not configured"); return this.skills.call(publicName, arguments_, context); }
}
