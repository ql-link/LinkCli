# MCPSTAT-1-L3 · Query 聚类分析层实施报告

## 1. 实现结果

LinkCli 已实现独立于用户实时请求的 L2→L3 数据链路：L2 结算后写入 Analysis Outbox，后台 Worker 关联轮次和调用明细，自动、幂等地转换成 L3 输入；L3 再由定时任务批量处理未分析记录。Outbox、批处理、事务隔离和候选写入等结构能力已经落地。

但按飞书 revision 9 的验收口径，L3 **尚未实现完成**。当前注册模型没有独立稳定的 Module 实体，字符二元组 Jaccard 也不具备业务语义聚类能力。真实 MCP 的 50 条 Query 批测最终得到 50 个单成员类别，因此不能将现有聚类结果或候选质量视为通过。

正常类别、未命中 MCP 的需求和已有 Skill 覆盖缺口使用不同门槛分流。达到门槛时，类别状态和脱敏候选证据在同一事务写入 `mcp_l4_candidate_outbox`。L3 不生成或执行 Skill，不调用业务 MCP，也不进行数据库反向校验。

### 整轮输入与批处理

`AnalysisInputConsumer` 校验稳定轮次、结算版本、不可逆用户摘要和调用顺序，并根据输入中明确的 Project/Module 组合生成有序模块路径，避免不同跨项目路径产生同一候选桶。它不会从当前调用级 `CallEnvelope` 猜测轮次或 Module。批处理通过 MySQL advisory lock 保证同一时刻只有一个实例执行，每条输入的成员、场景、评分、候选和完成标记在独立事务内提交；失败输入回滚并保留未分析状态，但不会阻塞同批次的其他输入。

同一轮次在批处理前提交更高结算版本时，旧版本不会参与分析。轮次已经聚类后再提交新版本会明确失败并要求补偿重建，避免静默重复计数。

主要实现位置：

- `src/analysis/input-consumer.ts`：L2 完整轮次输入校验、规范化和幂等写入。
- `src/analysis/outbox-worker.ts`：租约领取 L2 Analysis Outbox，关联完整轮次事实并可靠转换为 L3 输入。
- `src/analysis/similarity.ts`：Query 归一化、模块路径、场景和确定性相似度。
- `src/analysis/batch-service.ts`：定时批量聚类、质量统计、门槛和候选生成。
- `src/analysis/repository.ts`：内存测试仓库及 MySQL 事务、锁、聚类和 Outbox 持久化。
- `src/analysis/batch-scheduler.ts`：固定周期调度、进程内重入保护和安全停止。
- `src/db/schema.sql`：L3 输入、类别、成员、场景、覆盖缺口、评分、Outbox 和 L4 反馈表。
- `scripts/db/apply-analysis-schema.mjs`：从 schema 真值源为已有数据库幂等创建 L3 表。

## 2. 实际运行方式

1. L2 将最终结算轮次写入 `mcp_analysis_outbox`，Worker 自动关联 `mcp_turns + mcp_call_events` 后交给 `AnalysisInputConsumer`；零调用需求仍必须由宿主显式提交。
2. 消费器只保存脱敏调用事实和参数键，不保存凭据或完整业务结果。
3. `AnalysisBatchScheduler` 按 `L3_BATCH_INTERVAL_MS` 触发批次，并在 MySQL 上取得全局批处理锁。
4. 当前代码临时以 MCP Project 快照生成候选路径；这只能用于验证批处理链路，不等价于飞书方案要求的 `project_scope + ordered_module_path`，正式聚类前必须补齐稳定 Module 快照。
5. 批次重算样本数、独立用户数、时间跨度、成功率、内聚度、输入完整率及覆盖缺口。
6. 达标类别原子写入 L4 候选 Outbox；未达标类别保持观察，等待后续批次。
7. 单条处理失败时事务回滚，不写 `analyzed_at`，批次继续处理其他输入，失败记录下一批重新处理。
8. 类别首次交付 `new_skill` 后如果出现达到门槛的覆盖缺口，可以继续交付一次 `expand_skill`；同一类别和候选类型不会重复发送。

## 3. 与飞书方案的实现缺口

### 首版语义算法

飞书方案要求先用文本指纹去重，再使用本地语义模型与类别语义中心比较，并周期性执行合并和拆分检查。当前实现只使用字符二元组 Jaccard，还会删除部分操作词。真实批测中，同主题 Query 的中位相似度约为 0.19，最高约为 0.464，全部低于当前 0.82 加入阈值。降低固定阈值又会增加跨主题误合并，因此该算法不符合已确认方案，不是仅调整阈值即可收口的问题。

### Module 边界

飞书方案明确复用 MCP 的 `Project → Module → Tool` 分层，有序 Module 路径是候选范围的硬边界，Tool 操作只是组内场景。当前代码只有 Project 和 Tool 注册信息，将 Project 作为隐式 Module 会丢失“用户 → 订单”这类真实业务路径，因此只是现有代码状态，不能作为正式实现方案。

### Skill 覆盖元数据

代码已经提供 `SkillCoverageResolver` 并实现覆盖缺口统计与 `expand_skill` 候选，但当前仓库没有 Skill 注册表或 L4 元数据读取契约，因此生产启动使用空解析器。L4 元数据接入后才能在真实运行中自动识别已有 Skill 覆盖过窄；单元测试使用受控解析器验证了该分支。

### 数据库状态字段

方案草案使用 MySQL `ENUM` 表达状态，实际 schema 沿用仓库既有的 `VARCHAR + CHECK` 约定，便于后续兼容新增状态。字段含义、合法取值和索引没有改变。

### L4 交付范围

本次实现可靠候选 Outbox 和验证反馈表，不实现 L4 消费端、Skill 生成、回放或业务数据库反向校验。周期性全量重聚类、自动合并拆分和已分析轮次的补偿重建也未在首版自动执行；当前通过显式错误阻止静默修改已分析轮次。

## 4. 验证结果

实际执行：

- `npm run typecheck`：通过。
- `npm run check`：通过；84 个常规测试通过，API 与 Web 构建通过，6 个需要显式测试库的用例按设计跳过。
- `npm run test:mysql`：连接隔离 MySQL 8.0.42 串行执行，6 个真实 MySQL/MCP 用例全部通过。

上述自动化证明了数据链路、幂等、事务隔离和固定样例行为，不证明真实语义聚类已通过。后续真实 MCP 批测使用 50 条自然语言 Query，工具统计、轮次结算和 L2 Outbox 投递均为 50/50，但 L3 产生 50 个单例类别，语义聚类验收失败。

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
- L2 Analysis Outbox 自动转换为 L3 Input，重复领取不重复写入；不支持事件按上限退避后进入死信。
- 成功响应中出现重试、切路、放弃或无产出信号时，不计为质量成功样本。
- 配置校验、现有网关、控制台、标准 MCP 协议及生产构建回归。

人工验收不适用：本次没有新增 UI 或人工交互入口。

未覆盖：真实企业 MCP 服务、宿主零调用事件和生产 Skill 元数据仍没有可用测试环境；本次真实联调使用标准 MCP HTTP 测试服务和虚构数据。

## 5. 当前限制与 PR 重点

当前仍存在以下限制：

- 真实 MySQL 测试文件共享同一个专用数据库，必须串行执行；`npm run test:mysql` 已固定使用 `--no-file-parallelism`，避免并行清表制造伪失败。
- MCP 注册模型尚未提供稳定 `module_id` 和版本快照，当前 Project 级路径不满足飞书业务边界。
- 字符二元组相似度已被真实 50 Query 批测证明不满足语义聚类需求，正式候选产生前必须替换并重新标定。
- 生产 `SkillCoverageResolver` 尚未接入 L4 Skill 元数据，真实覆盖缺口只能在该契约补齐后识别。
- L4 Candidate Outbox 消费、L4 验证反馈处理、自动重聚类和已分析轮次补偿重建属于后续 L4/运维接线范围。

PR 审查时重点确认：

- 宿主何时提供零调用和未命中 MCP 的显式轮次结束事件；仅靠 `tools/call` 仍无法采集这类需求。
- 首版相似度阈值是否先通过影子数据评估再用于生产候选。
- 目标 MySQL 环境运行 `npm run db:upgrade:analysis` 后，必须执行 `npm run test:mysql`。
