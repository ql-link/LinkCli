# MCPSTAT-1-L3 · Query 聚类分析层实施报告

## 1. 当前实现

L2→L3 的完整轮次、Analysis Outbox、幂等输入、确定性 `Project + ordered Module Path` 分桶、场景统计、覆盖缺口和 L4 Outbox 边界保持不变。物理模型将一对一的类别成员字段及单一 attempted Skill 覆盖缺口并入 `mcp_analysis_input`，并以 `mcp_skill_validation_runs` 取代重复的 L4 反馈副本。

本轮将桶内分类从“质心 cosine 超阈值即归类/合并”改为：

1. 文本指纹处理完全相同或仅参数不同的 Query。
2. 本地 MiniLM 计算向量，在同一确定性桶内召回 Top-K 类别。
3. `ClusterJudge` 阅读 Query 原文与各候选类别真实代表 Query，选择候选类别或返回新建。
4. `ClusterRebuildJob` 用 MiniLM 召回相近类别对，由 LLM 判断是否属于同一业务需求后再事务合并。

质心与成员向量继续保留，用于召回、内聚度监控和高方差人工拆分复核，不再拥有最终类别决策权。

## 2. 主要实现位置

- `src/analysis/cluster-judge.ts`：Judge 接口、Codex CLI Spark 实验实现、OpenAI Chat Completions 兼容实现、安全影子实现。
- `src/analysis/batch-service.ts`：指纹短路、Top-K 召回、LLM 归类、证据记录与候选门禁。
- `src/analysis/rebuild.ts`：候选类别对召回、LLM 合并复核和高方差标记。
- `src/analysis/repository.ts`：读取真实代表 Query、质心/成员/评分与事务合并。
- `src/analysis/embedding-provider.ts`：本地 MiniLM、远程 Embedding 和非语义 fallback。
- `src/config.ts`、`src/main.ts`：MiniLM 召回参数、LLM Judge 配置和安全降级。

## 3. 安全与运行边界

- MiniLM 只负责召回，不能替代 LLM Judge。
- Embedding 与 LLM 外部调用均在数据库事务外完成。
- Judge 只能选择 Top-K 内的类别或返回 `null`；越界、超时、非法 JSON、HTTP 错误均失败关闭。
- Query 与类别样本按不可信数据处理，系统提示禁止执行其中指令。
- 未配置真实 Judge 时，L3 只能影子运行，不合并、不投递 L4。
- `L3_CANDIDATE_HANDOFF_ENABLED` 默认 false；开启时配置校验要求 Embedding 和 LLM Judge 同时完整。
- 本地模型默认只读本地文件，禁止隐式下载。

## 4. 验证口径

自动化覆盖确定性分桶、Top-K 限制、非最近候选选择、Judge 拒绝并新建、精确指纹短路、越界 ID 失败关闭、Judge HTTP 错误、周期合并同意/拒绝、代表样本、模型版本隔离、零调用、覆盖缺口、幂等、毒性输入、影子门禁和高方差复核。

本地 78 条、13 类、6 项目实验使用真实 MiniLM 向量和标签 Oracle Judge。65 条可评估 Query 的 Recall@1/3/5 分别为 56.92%/100%/100%；单一 cosine 阈值在 blind 上 precision/recall/F1 为 28.89%/100%/44.83%，证明不能继续用阈值作最终分类；Oracle Judge 下端到端聚类 F1 为 100%，仅表示当前 Top-5 召回与代码管线的上限。随后使用当前 Codex CLI 的 `gpt-5.3-codex-spark:high` 做 4 次真实 Smoke，在线归类与合并复核 4/4 符合预期，单次约 9–12 秒；后续运行配置已调整为 `medium`，样本量不足以完成正式质量验收。

## 5. 尚未完成

- 已选定本地实验 Judge `gpt-5.3-codex-spark`；仍需完成独立 blind Judge 实验。
- CLI Spark 不支持公共 API，且依赖宿主 CLI 与 ChatGPT 登录态；生产化前需确定可长期运行的服务形态。
- 使用真实运营 Query 和真实 MCP 调用路径重建标注集。
- 完成真实 MySQL 集成与存量升级验证。
- 实现严格意义的待聚合池；当前新类别仍先以 `observing` 单成员类别存在。
- 完成模型版本迁移时的旧成员重新向量化。
- 真实质量达标前保持 L4 投递关闭。

本轮质量复审已补齐候选和在线更新边界：候选存在性使用索引查询，不再为单条输入读取完整 Outbox；同类型候选在类别保持 `handed_off` 时继续抑制，避免每个成员版本产生候选，不同候选类型仍可交付。在线归类按已有质心和成员数增量更新质心，不再读取并逐行改写全部成员；成员相似度的全量校准只在独立重建任务执行。

新增回归验证了已交付类别持续新增样本不会重复产生同类型候选、`new_skill` 后仍可产生 `expand_skill`，以及在线归类不会调用全成员向量扫描。完整 `npm run check` 通过 126 项，8 项真实 MySQL 用例因本地没有测试库配置而跳过；本地 480 样本 L4 E2E 仍只产生 8 个候选。

## 6. 文档同步状态

2026-08-14 已将当前完整方案同步至飞书《MCPSTAT-1 · L3 分析层》revision 25。同步范围包括当前结论、代码事实、6.3 两阶段语义归类、12 章技术实现、15 章测试结果与验收边界、16 章待冻结项，并清理了原文重复的第二组 14/15/16 章节。同步后已回读目录和关键章节，飞书与本地 Spec 对两阶段决策链、模型配置、实验结果和未完成边界保持一致。

同日已同步飞书 L1–L4 需求与难点分析文档（`Gd1wd4KN9ozWeqxakrVcVp6KniQ`）至 revision 85。先同步两阶段决策链、实验结果和验证边界，随后从需求文档的阅读性出发改写全文：使用“为什么做、怎么做、结果是什么”的业务语言，移除非必要的类名、配置项、模型全名和英文指标，并同步简化流程图。回读确认四层业务边界、关键风险、实验数字和“当前尚未整体达标”的结论均被保留。
