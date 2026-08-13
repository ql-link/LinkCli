# MCPSTAT-1-L3 · Query 聚类分析层实施报告

## 1. 实现结果

LinkCli 现在具备一条独立于用户实时请求的 L3 批处理链路。L2 可以通过整轮输入契约写入已经结算的 Query；L3 默认每 5 分钟读取一批未分析记录，根据实际 MCP Project 和有序 Module 路径限定候选范围，再以本地确定性相似度完成宽口径聚类。查询、修改、删除不会拆散“用户模块 → 订单模块”这一 Query 类别，而会形成三个可独立统计的组内场景。

正常类别、未命中 MCP 的需求和已有 Skill 覆盖缺口使用不同门槛分流。达到门槛时，类别状态和脱敏候选证据在同一事务写入 `mcp_l4_candidate_outbox`。L3 不生成或执行 Skill，不调用业务 MCP，也不进行数据库反向校验。

### 整轮输入与批处理

`AnalysisInputConsumer` 校验稳定轮次、结算版本、不可逆用户摘要和调用顺序，并根据输入中明确的 Project/Module 组合生成有序模块路径，避免不同跨项目路径产生同一候选桶。它不会从当前调用级 `CallEnvelope` 猜测轮次或 Module。批处理通过 MySQL advisory lock 保证同一时刻只有一个实例执行，每条输入的成员、场景、评分、候选和完成标记在独立事务内提交；失败输入回滚并保留未分析状态，但不会阻塞同批次的其他输入。

同一轮次在批处理前提交更高结算版本时，旧版本不会参与分析。轮次已经聚类后再提交新版本会明确失败并要求补偿重建，避免静默重复计数。

主要实现位置：

- `src/analysis/input-consumer.ts`：L2 完整轮次输入校验、规范化和幂等写入。
- `src/analysis/similarity.ts`：Query 归一化、模块路径、场景和确定性相似度。
- `src/analysis/batch-service.ts`：定时批量聚类、质量统计、门槛和候选生成。
- `src/analysis/repository.ts`：内存测试仓库及 MySQL 事务、锁、聚类和 Outbox 持久化。
- `src/analysis/batch-scheduler.ts`：固定周期调度、进程内重入保护和安全停止。
- `src/db/schema.sql`：L3 输入、类别、成员、场景、覆盖缺口、评分、Outbox 和 L4 反馈表。
- `scripts/db/apply-analysis-schema.mjs`：从 schema 真值源为已有数据库幂等创建 L3 表。

## 2. 实际运行方式

1. L2 将一轮最终结算 Query 交给 `AnalysisInputConsumer`；零调用需求也必须显式提交。
2. 消费器只保存脱敏调用事实和参数键，不保存凭据或完整业务结果。
3. `AnalysisBatchScheduler` 按 `L3_BATCH_INTERVAL_MS` 触发批次，并在 MySQL 上取得全局批处理锁。
4. 批处理按 `project_scope + ordered_module_path` 检索候选类别，再比较 Query 内容；具体 Tool 动作写成组内场景。
5. 批次重算样本数、独立用户数、时间跨度、成功率、内聚度、输入完整率及覆盖缺口。
6. 达标类别原子写入 L4 候选 Outbox；未达标类别保持观察，等待后续批次。
7. 单条处理失败时事务回滚，不写 `analyzed_at`，批次继续处理其他输入，失败记录下一批重新处理。
8. 类别首次交付 `new_skill` 后如果出现达到门槛的覆盖缺口，可以继续交付一次 `expand_skill`；同一类别和候选类型不会重复发送。

## 3. 与确认方案的差异

### 首版语义算法

方案为语义模型保留了可替换边界，首版实际使用去除操作词和易变标识后的字符二元特征 Jaccard 相似度。这样可以在不引入外部 LLM、网络调用和敏感数据外发的条件下验证“同模块路径、宽口径场景”的业务假设。真实影子数据如果证明准确率不足，可以替换该实现而不改变输入、仓库和批处理契约。

### Skill 覆盖元数据

代码已经提供 `SkillCoverageResolver` 并实现覆盖缺口统计与 `expand_skill` 候选，但当前仓库没有 Skill 注册表或 L4 元数据读取契约，因此生产启动使用空解析器。L4 元数据接入后才能在真实运行中自动识别已有 Skill 覆盖过窄；单元测试使用受控解析器验证了该分支。

### 数据库状态字段

方案草案使用 MySQL `ENUM` 表达状态，实际 schema 沿用仓库既有的 `VARCHAR + CHECK` 约定，便于后续兼容新增状态。字段含义、合法取值和索引没有改变。

### L4 交付范围

本次实现可靠候选 Outbox 和验证反馈表，不实现 L4 消费端、Skill 生成、回放或业务数据库反向校验。周期性全量重聚类、自动合并拆分和已分析轮次的补偿重建也未在首版自动执行；当前通过显式错误阻止静默修改已分析轮次。

## 4. 验证结果

实际执行：

- `npm run typecheck`：通过。
- `npm test -- --run tests/analysis-batch.test.ts tests/mysql-analysis.integration.test.ts`：15 个 L3 单元测试通过，3 个真实 MySQL 用例因未配置 `LINKCLI_TEST_MYSQL_URL` 跳过。
- `npm run check`：在沙箱外通过；66 个测试通过，6 个需要真实 MySQL 的测试因未配置 `LINKCLI_TEST_MYSQL_URL` 跳过，API 与 Web 构建通过。

已经覆盖：

- L2 写入后不立即聚类，只有运行批次才产生类别。
- 查询、修改、删除订单归为同一类别并生成不同场景。
- 不同模块路径和相同路径下不同业务目标不会误并。
- 不同跨 Project 路径即使 Module 名称序列相同，也不会进入同一候选桶。
- 零调用 Query 形成 `uncovered_demand`。
- 已有 Skill 覆盖缺口形成 `expand_skill`，已覆盖时不重复生成 Skill。
- 单条输入事务失败不会阻塞同批其他输入；失败记录保留待重试并由调度器报告。
- `new_skill` 已交付后出现覆盖缺口时可继续产生一次 `expand_skill`，同类型事件保持幂等。
- 重复事件、非可信输入、批处理重入和结算版本前置替换。
- 成功响应中出现重试、切路、放弃或无产出信号时，不计为质量成功样本。
- 配置校验、现有网关、控制台、标准 MCP 协议及生产构建回归。

人工验收不适用：本次没有新增 UI 或人工交互入口。

未覆盖：真实 MySQL DDL、advisory lock、事务与 Outbox 集成测试已编写，但当前环境没有提供 `LINKCLI_TEST_MYSQL_URL`，本次未实际执行。

## 5. 当前限制与 PR 重点

当前仍存在以下限制：

- 当前调用级 L2 尚未把完整轮次写入 `mcp_analysis_input`，因此调度器上线后可以正常空跑，但在 L2 接线前不会产生真实候选。
- 生产 `SkillCoverageResolver` 尚未接入 L4 Skill 元数据，真实覆盖缺口只能在该契约补齐后识别。
- Outbox 消费、L4 验证反馈处理、自动重聚类和已分析轮次补偿重建属于后续 L4/运维接线范围。

PR 审查时重点确认：

- L2 完整轮次输入是否能提供稳定 Module ID 和零调用记录，而不是继续使用单次 `CallEnvelope`。
- 首版相似度阈值是否先通过影子数据评估再用于生产候选。
- 目标 MySQL 环境运行 `npm run db:upgrade:analysis` 后，必须执行 `npm run test:mysql`。
