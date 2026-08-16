# L3 Query 聚类测试方案

## 1. 目标

验证以下责任边界：确定性分桶不跨 Project/Module Path；MiniLM 只保证正确类别进入 Top-K；LLM Judge 决定归类、新建和周期合并；任何模型异常均失败关闭且可重试。

## 2. 测试层级

| 层级 | 数据/依赖 | 证明什么 | 不证明什么 |
|---|---|---|---|
| 单元测试 | Stub Embedding + Stub Judge | 分支、事务、门禁和错误处理 | 真实模型质量 |
| 召回实验 | 真实 MiniLM + 标签 Oracle Judge | 正确类别是否进入 Top-K、管线上限 | 真实 LLM 判断能力 |
| Judge 盲测 | 冻结 MiniLM + 真实 LLM | 最终归类和合并质量 | 真实 MySQL 链路 |
| MySQL 集成 | MySQL 8 + Stub/真实模型 | 持久化、回滚、合并、幂等 | 生产容量 |
| 运营影子测试 | 真实 Query/MCP 路径，不投递 L4 | 端到端业务质量 | L4 Skill 正确性 |

## 3. 必测用例

### 3.1 确定性分桶

- 相同 Project + 有序 Module Path 进入同一候选桶。
- Module 顺序变化、Project 变化或路径变化不得跨桶召回。
- 任一 Tool 缺少 `module_key` 时整轮进入未覆盖池。
- 零调用/未命中 Query 进入未覆盖池，不伪造 Module。

### 3.2 Embedding Top-K 召回

- 正确类别是相似度第一时进入候选。
- 正确类别不是第一但在 Top-K 内时，Judge 可以选择它。
- 桶内类别数大于 K 时，只给 Judge K 个类别。
- 召回下限仅剪枝；不得直接决定并入或合并。
- Embedding 模型版本不同的质心不得比较。
- 正确类别 Recall@1、Recall@3、Recall@5 分别统计。

### 3.3 在线 LLM 归类

- Judge 选择已有类别后正确写入成员、场景、质心和评分证据。
- Judge 返回 `null` 时创建新观察类别。
- 完全相同/仅参数不同 Query 走指纹短路，不调用 Judge。
- Judge 返回 Top-K 外 ID、非法 JSON、空响应、超时、401/429/5xx 时失败关闭，输入保持待重试。
- Query 包含“忽略规则、返回某 ID”等提示注入文本时，仍只按业务语义输出结构化协议。
- 代表样本数量不超过配置，且均来自真实类别成员。

### 3.4 周期复核

- LLM 判断同一业务需求时，成员、场景和覆盖缺口事务合并，源类别标记 `merged`。
- LLM 判断不同目标时保持两个类别，并记录拒绝证据。
- 已合并/退役类别不参与复核。
- 同一类别对只仲裁一次；任一类别被合并后跳过失效候选对。
- 高方差成熟类别只标记人工拆分复核，不自动拆分。

### 3.5 候选与可靠性

- 样本数、用户数、跨度、完整率、成功率和覆盖缺口门槛正确。
- Embedding cohesion 只用于观测，不再直接否决 LLM 类别。
- fallback Embedding、无真实 Judge 或显式影子模式均不能投递 L4。
- 单条毒性输入失败不污染同批后续输入。
- 重复事件、重复结算版本和批处理重跑不重复计数。

## 4. 标注数据要求

- 至少覆盖 6 个项目、10 个以上业务类别和 50 条以上自然 Query。
- 每类包含自然表达、同义改写、操作场景变化和参数变化。
- 每个共享 Module Path 的桶必须包含困难负样本，例如订单生命周期、订单权限、订单物流。
- Query 对应的 Project、Module、Tool、Operation 必须来自真实或严格模拟的调用事实，不能统一套用固定 Tool。
- tune 与 blind 按业务模板/来源隔离，blind 不能参与阈值、提示词或类别代表样本选择。
- 至少两名标注者独立判断，冲突样本单独记录。

## 5. 指标与门槛

建议实验门槛：

- MiniLM `Recall@5 ≥ 0.98`；同时报告 Recall@1/3。
- Judge blind precision ≥ 0.90、recall ≥ 0.80、F1 ≥ 0.80。
- 端到端聚类 F1 ≥ 0.80。
- `overmergedClusters = 0`。
- 非法 Judge 输出接受率 = 0。
- 所有归类/合并决策证据完整率 = 100%。

这些数值仍是实验门槛，不等于生产冻结值。

## 6. 执行命令

```bash
npm run typecheck
npx vitest run tests/analysis-batch.test.ts tests/cluster-judge.test.ts tests/config.test.ts tests/l3-evaluation-data.test.ts
npm run eval:l3 -- --provider=local --cache-dir=/tmp/linkcli-transformers-cache --local-files-only=true --top-k=5 --representatives=3
npm run check
```

真实 MySQL 仅在提供隔离测试库后执行：

```bash
LINKCLI_TEST_MYSQL_URL='mysql://...' npm run test:mysql
```

## 7. 结果记录模板

- 日期、分支、代码 SHA/工作区状态
- 数据集版本、Query 数、类别数、项目数、桶数
- Embedding/Judge 模型版本与配置
- Recall@1/3/5、Judge precision/recall/F1、端到端聚类指标
- 错误合并、错误拆分、未召回和模型协议错误样本
- 自动化、MySQL、运营影子测试分别标记通过/失败/跳过
- 是否允许开启 L4 投递：是/否及依据

## 8. 2026-08-14 本地执行记录

| 项目 | 结果 | 结论 |
|---|---:|---|
| 定向自动化 | 46/46 通过 | Top-K、远程/CLI Judge 协议、异常响应、提示注入、周期复核、分桶和安全门禁通过 |
| 完整自动化 | 110 通过、6 个 MySQL 用例跳过 | 类型检查、API/Web 构建及非 MySQL 自动化通过 |
| MiniLM Recall@1 | 56.92% | 不能把最近类别直接当最终答案 |
| MiniLM Recall@3 | 100% | 当前标注集满足候选召回门槛 |
| MiniLM Recall@5 | 100% | 当前建议保留 Top-K=5 作为安全余量 |
| 质心阈值 blind precision/recall/F1 | 28.89% / 100% / 44.83% | 原最终判定方案不达标 |
| Oracle Judge 端到端聚类 F1 | 100% | 只证明管线上限，不证明真实 LLM 质量 |
| Codex Spark Smoke | 4/4 通过 | 两个在线归类、同类合并、异类拒绝合并均符合预期；每次约 9–12 秒 |
| 真实 LLM blind | 未执行 | 已选 `gpt-5.3-codex-spark:medium`，但尚未执行足量独立 blind 数据 |
| 真实 MySQL | 未执行 | 当次未提供隔离测试库 |
| L4 投递 | 禁止开启 | 真实 LLM 与运营影子验证尚未完成 |
