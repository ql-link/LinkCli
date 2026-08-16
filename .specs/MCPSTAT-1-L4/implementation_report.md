# MCPSTAT-1-L4 · Skill 完整闭环实施报告

## 1. 实现结果

L4 已形成从 L3 候选到 MCP Skill 运行时的闭环：候选事件通过带租约的 outbox Worker 消费并幂等生成 Skill；生成、修订、依赖变化和人工复核进入异步验证队列；验证通过后必须审核、灰度，再进入统一 MCP 工具清单。普通用户 Query 和普通 Tool 调用不会触发数据库反查。

已启用 Skill 以 `skill__<skillKey>` 暴露给 MCP。运行时按不可变 Tool 版本快照依次执行步骤，任一步失败即停止且不自动重试；灰度按 `credentialId + skillId` 稳定哈希和 `exposurePercent` 分流。每个内部步骤继续进入 L2，并带有 Skill、版本、运行和步骤关联字段。

主要实现位置：

- `src/skill/service.ts`：生成、修订、验证排队、审核、灰度、启用、暂停、降级、废弃和依赖变更处理。
- `src/skill/candidate-worker.ts`、`src/skill/validation-worker.ts`：候选和验证异步 Worker。
- `src/skill/runtime.ts`：Skill MCP Tool 清单、灰度路由、步骤编排和 L2 关联。
- `src/skill/repository.ts`、`src/skill/feedback.ts`：内存/MySQL 持久化和验证反馈回流。
- `src/gateway/catalog.ts`、`src/gateway/router.ts`：L1 清单挂载与 Skill 路由。
- `src/collection/repository.ts`、`src/domain.ts`：L2 Skill 运行元数据。
- `src/db/schema.sql`、`scripts/db/apply-analysis-schema.mjs`：Skill、验证队列、候选租约和 L2 关联字段。
- `src/admin/http.ts`：Skill 查询、候选接收、修订、验证排队、审核、生命周期和依赖事件 API。

## 2. 实际运行方式

1. L3 将达标类别写入 `mcp_l4_candidate_outbox`。
2. `SkillCandidateWorker` 获取租约，生成草稿和不可变 v1；失败按重试次数进入 dead 状态。
3. Worker 为新版本创建 `mcp_skill_validation_jobs`；`SkillValidationWorker` 执行固定样本和 `AuthorityChecker`，并将结论写入验证运行及 `mcp_l4_validation_feedback`。
4. 通过验证的版本进入待审核；审核通过进入 10% 灰度，显式激活后 exposure 为 100%。
5. MCP `tools/list` 展示灰度/启用 Skill；调用按固定步骤执行底层 Tool，内部事件写入 L2。
6. 依赖 Tool 变更可通过依赖事件接口暂停受影响 Skill 并排队定向验证；通过后仍需重新审核和灰度。

## 3. 与方案的差异

真实 AI 生成器和真实权威数据库连接仍通过 `SkillGenerator`、`SkillCaseExecutor`、`AuthorityChecker` 接口注入，默认实现是确定性生成器和 `insufficient` 校验器，不会伪造生产验证结论。L3 候选现已携带场景 Tool 路径及 `serviceVersionId/toolVersionId` 不可变快照；缺少快照时，Skill 仍会被激活门禁拒绝。

## 4. 验证结果

实际执行：

- `npm run typecheck`、`npm run typecheck:web`、`npm run build`：通过。
- 全量测试：118 个通过，6 个 MySQL 用例在未配置测试库时跳过。
- 本地真实 HTTP L4 E2E：480 条 L3 样本、8 个候选 Skill、异步验证、审核/激活、真实 Streamable HTTP 下游和 L2 采集全部通过。
- 隔离 MySQL 8.0.42 L4 E2E：480 条 L3 样本、候选/Skill/验证队列/反馈持久化、真实 MCP HTTP 调用和带 Skill 关联字段的 `mcp_call_events` 全部通过。
- 隔离 MySQL L1/L3 回归：6 个测试全部通过。
- `npm run spec -- check MCPSTAT-1-L4 implementation`：通过。

尚未在本次环境执行：真实 AI、真实只读权威库和跨进程部署验证；本次 E2E 使用了真实 MCP Streamable HTTP 下游和可判定的测试权威检查器。

## 5. 当前限制与 PR 重点

- 真实 `AuthorityChecker` 必须使用只读副本/影子库，禁止连接生产主库；未配置时不得把 `insufficient` 视为通过。
- 依赖 Tool 变更目前提供管理事件入口；生产应把 L1 版本发布/下线事件可靠投递到该入口。
- 灰度指标自动晋级/自动回滚仍需接入真实 L2/L3 质量阈值配置。
