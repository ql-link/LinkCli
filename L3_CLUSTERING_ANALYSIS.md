# L3 Query 聚类实验记录

本文档记录 `l3-similarity-fix` 当前实验方案、实现边界和验收状态；完整方案已同步至飞书《MCPSTAT-1 · L3 分析层》revision 25，同时已同步至 L1–L4 需求与难点分析文档 revision 85，并完成全文与流程图回读验证。

## 一、当前结论

原来的字符 Jaccard 会把 50 条自然 Query 拆成 50 个单例；改用 MiniLM 或千问 Embedding 后，单一质心阈值又会把 13 个标注类别过度合并成 6 类。根因是“语义接近”不等于“应属于同一个业务需求类别”，Embedding 不适合独自承担最终类别判断。

本轮采用两阶段方案：

1. `Project + ordered Module Path` 确定性分桶保持不变。
2. 本地 MiniLM 在桶内召回 Top-K 候选类别，只负责减少比较范围。
3. `ClusterJudge` 阅读新 Query 与候选类别真实代表 Query，决定并入某类或新建类别。
4. 周期复核同样由 MiniLM 召回候选类别对，再由 LLM 判断是否合并。

## 二、模型边界

- Embedding：`Xenova/paraphrase-multilingual-MiniLM-L12-v2`，384 维，q8 ONNX，只用于召回。
- LLM Judge：本地实验使用当前已登录 Codex CLI 的 `gpt-5.3-codex-spark`；远程部署仍保留 OpenAI Chat Completions 兼容实现。
- MiniLM 不是对话模型，不能完成最终仲裁。
- 未配置 LLM 时使用 `NewClusterOnlyJudge`：只创建影子观察类别，不合并、不投递 L4。
- 本地模型默认 `local_files_only=true`，不得在生产或测试运行中静默下载。

## 三、已完成代码改造

1. 新增 `ClusterJudge`、`CodexCliClusterJudge`、`RemoteLlmClusterJudge` 和安全影子 Judge。
2. 在线归类改为：文本指纹短路 → 桶内 MiniLM Top-K → LLM 精判。
3. 质心仍增量维护，但只用于召回与内聚度观测，不再作为最终归类阈值。
4. 周期合并改为：Embedding 召回类别对 → LLM 阅读两组代表样本 → 同意后事务合并。
5. LLM/Embedding 外部调用移到数据库事务外，避免模型延迟形成长事务。
6. 每次归类与合并判断写入评分历史，记录 Judge 版本、候选 ID、召回分数、置信度和原因。
7. Judge 返回 Top-K 外类别、非法响应、超时、HTTP 或 CLI 进程错误时失败关闭，输入保留待重试。
8. L4 候选门禁同时要求真实 Embedding 和真实 LLM Judge，默认保持关闭。

## 四、配置

```env
L3_LOCAL_EMBEDDING_MODEL=Xenova/paraphrase-multilingual-MiniLM-L12-v2
L3_LOCAL_EMBEDDING_DIMENSIONS=384
L3_LOCAL_EMBEDDING_DTYPE=q8
L3_LOCAL_EMBEDDING_LOCAL_FILES_ONLY=true
L3_RECALL_TOP_K=5
L3_REPRESENTATIVE_QUERY_LIMIT=3
L3_MINIMUM_RECALL_SIMILARITY=0
L3_CANDIDATE_HANDOFF_ENABLED=false
L3_JUDGE_PROVIDER=codex-cli
L3_CODEX_CLI_COMMAND=codex
L3_CODEX_CLI_MODEL=gpt-5.3-codex-spark
L3_CODEX_CLI_REASONING_EFFORT=medium
L3_CODEX_CLI_TIMEOUT_MS=60000

# 改用远程 Judge 时配置
# L3_LLM_ENDPOINT=https://example.internal/v1/chat/completions
# L3_LLM_API_KEY=secret-manager-value
# L3_LLM_MODEL=cluster-judge-model
```

## 五、实验解释边界

现有 78 条、13 类、6 项目的标注数据可以验证 MiniLM Top-K 是否把正确类别召回。为在没有真实 LLM 时验证代码管线，评测脚本使用标签 Oracle Judge；该结果只表示“若 Judge 判断完全正确，当前 Top-K 是否足够”，不能代表真实 LLM 的 precision、recall 或 F1。

2026-08-14 离线实验结果：

- MiniLM 类别召回共评估 65 条非首次 Query：Recall@1 = 56.92%，Recall@3 = 100%，Recall@5 = 100%，Top-5 未召回 0 条。
- 若继续用单一 cosine 阈值做最终判定，blind precision = 28.89%、recall = 100%、F1 = 44.83%，明显不达标；主要错误来自同 Module Path 内语义相关但业务目标不同的类别。
- MiniLM + 标签 Oracle Judge 管线上限：78 条全部处理成功，13 个金标类别对应 13 个聚类，聚类 precision/recall/F1 均为 100%，无错误合并。
- 上述 Oracle 结果只证明 Top-5 没有卡住正确类别及代码管线可以表达正确决策。
- `gpt-5.3-codex-spark` 真实 CLI Smoke 共调用 4 次，两个在线归类和两个周期合并判断全部符合预期；单次耗时约 9–12 秒。该样本量只证明 CLI 协议链路可用，不能替代独立 blind 质量实验，因此本轮整体功能仍不能判定为正式达标。
- 本机模型目录明确标记该 Spark 模型 `supported_in_api=false`。CLI Judge 依赖宿主安装 Codex CLI 和有效 ChatGPT 登录态，只适合当前本地实验，不应直接视为生产服务依赖。

正式达标必须同时满足：

- 数据来自真实运营 Query 与真实 MCP 调用路径；
- tune 与 blind 完全隔离；
- MiniLM 在 blind 集上的正确类别 Recall@K 达标；
- 真实 LLM Judge 的归类与合并 precision/recall/F1 达标；
- 无跨业务目标错误合并；
- 真实 MySQL、模型失败重试和事务验证通过。

详细用例与执行口径见 `docs/l3-clustering-test-plan.md`。
