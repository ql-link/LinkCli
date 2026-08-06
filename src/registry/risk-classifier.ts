import type { DiscoveredTool, RiskLevel, ToolVersion } from "../domain.js";

const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export interface RiskAssessment {
  overall: RiskLevel;
  toolRisks: Map<string, RiskLevel>;
  suspendedTools: string[];
}

const rank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, incompatible: 3 };
const maxRisk = (values: RiskLevel[]): RiskLevel => values.reduce((current, value) => rank[value] > rank[current] ? value : current, "low");

export function classifyRisk(previous: ToolVersion[], next: DiscoveredTool[]): RiskAssessment {
  const oldByName = new Map(previous.map((tool) => [tool.originalName, tool]));
  const nextByName = new Map(next.map((tool) => [tool.name, tool]));
  const toolRisks = new Map<string, RiskLevel>();
  const suspended = new Set<string>();

  for (const oldTool of previous) {
    const newTool = nextByName.get(oldTool.originalName);
    if (!newTool) {
      toolRisks.set(oldTool.originalName, "incompatible");
      suspended.add(oldTool.originalName);
      continue;
    }
    if (stable(oldTool.inputSchema) !== stable(newTool.inputSchema) || stable(oldTool.outputSchema) !== stable(newTool.outputSchema)) {
      toolRisks.set(oldTool.originalName, "high");
      suspended.add(oldTool.originalName);
    } else if (oldTool.description !== newTool.description) {
      toolRisks.set(oldTool.originalName, "medium");
    } else toolRisks.set(oldTool.originalName, "low");
  }
  for (const newTool of next) if (!oldByName.has(newTool.name)) toolRisks.set(newTool.name, "low");
  return { overall: maxRisk([...toolRisks.values()]), toolRisks, suspendedTools: [...suspended] };
}
