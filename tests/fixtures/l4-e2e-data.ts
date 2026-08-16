import { createHash } from "node:crypto";
import type { SettledTurnInput } from "../../src/analysis/input-consumer.js";
import type { AnalysisCall } from "../../src/analysis/types.js";

export interface L4E2EDataOptions {
  projectId: string;
  moduleId: string;
  toolName: string;
  serviceVersionId: string;
  toolVersionId: string;
  samplesPerGroup?: number;
  groupCount?: number;
}

const queryGroups = [
  ["订单查询", ["查询订单最新状态", "帮我看看这笔订单现在到哪一步了", "查一下客户订单的处理进度"]],
  ["订单物流", ["查询订单物流轨迹", "帮我追踪这笔订单的配送状态", "看看包裹现在由哪个网点配送"]],
  ["订单权限", ["检查用户有没有订单审批权限", "确认这个账号能否审核订单", "核实订单操作授权范围"]],
  ["订单售后", ["查询这笔订单的售后进度", "看看订单退款处理到哪一步", "帮我跟进客户的退货申请"]],
  ["库存查询", ["查询商品当前可用库存", "看看这个 SKU 还有多少现货", "查一下各仓库的可销售数量"]],
  ["库存预占", ["为订单预占商品库存", "检查本次库存锁定是否成功", "释放取消订单占用的库存"]],
  ["发票查询", ["查询发票开具进度", "看看这张发票现在是什么状态", "查一下订单的电子发票"]],
  ["发票合规", ["检查发票抬头和税号是否匹配", "核对这张票是否满足开票规范", "验证发票金额与订单金额"]],
] as const;

const actorHash = (actor: string): string => createHash("sha256").update(actor).digest("hex");

export function l4E2EGroupOf(query: string): string {
  return /（(.+)-样本\d+）/u.exec(query)?.[1] ?? query;
}

export function generateL4E2EData(options: L4E2EDataOptions): SettledTurnInput[] {
  const samplesPerGroup = options.samplesPerGroup ?? 60;
  const groupCount = Math.min(options.groupCount ?? queryGroups.length, queryGroups.length);
  const start = Date.UTC(2026, 7, 1);
  const rows: SettledTurnInput[] = [];
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    const [label, templates] = queryGroups[groupIndex]!;
    for (let index = 0; index < samplesPerGroup; index++) {
      const actor = `l4-e2e-actor-${groupIndex}-${index % 10}`;
      const query = `${templates[index % templates.length]}（${label}-样本${index + 1}）`;
      const call: AnalysisCall = {
        sequence: 1,
        projectId: options.projectId,
        moduleId: options.moduleId,
        toolName: options.toolName,
        serviceVersionId: options.serviceVersionId,
        toolVersionId: options.toolVersionId,
        operation: "query",
        parameterKeys: ["query"],
        outcome: "success",
      };
      rows.push({
        eventId: `l4-e2e-event-${groupIndex}-${index + 1}`,
        turnId: `l4-e2e-turn-${groupIndex}-${index + 1}`,
        settlementVersion: 1,
        actorHash: actorHash(actor),
        queryText: query,
        calls: [call],
        settlementStatus: "success",
        collectionTrust: "trusted",
        occurredAt: new Date(start + (index % 6) * 24 * 60 * 60 * 1_000 + groupIndex * 1_000),
      });
    }
  }
  return rows;
}

export const l4E2EGroupLabels: string[] = queryGroups.map(([label]) => label);
