# L3 Query 聚类问题分析与整改方案

本文档整理本次会话对 MCPSTAT-1-L3（Query 聚类分析层）问题的完整诊断，以及截至目前在 `l3-similarity-fix` 分支上已经落地和尚未完成的工作，供后续继续推进或转交他人执行。

## 一、问题根因

`feature/l3-query-clustering` 分支上已有一份**冻结**的 [`.specs/MCPSTAT-1-L3/solution.md`](.specs/MCPSTAT-1-L3/solution.md)，但实际实现相对方案发生了明显偏离，[implementation_report.md](.specs/MCPSTAT-1-L3/implementation_report.md) 中也诚实记录了"L3 尚未实现完成"、"50 条真实 MCP Query 批测产生 50 个单成员类别"。

逐条比对方案要求与代码：

| 方案要求 | 实际代码（整改前） | 位置 |
|---|---|---|
| 无损规范化，保留动作词、填充词 | 用正则整体删除动作词/填充词，且无词边界，会误伤单词内部字符 | `src/analysis/similarity.ts` `normalizeQuery` |
| 不得将 Project 当 Module，不得靠 Tool 名猜测 Module | 直接把 `project_key` 当 `moduleId` 使用 | `src/analysis/outbox-worker.ts:142`（整改前） |
| 用语义模型计算与类别语义中心的相似度 | 用字符二元组 Jaccard 计算与单条代表 Query 的相似度 | `src/analysis/similarity.ts` `querySimilarity` |
| 类别应有"代表 Query + 语义中心" | 只有 `representativeEventId`/`representativeQuery`，没有质心字段 | `src/analysis/types.ts` `QueryCluster` |
| 加入阈值 0.82 只是待压测初值 | 直接当生产阈值使用 | `src/analysis/types.ts` `defaultClusterThresholds` |
| 周期性合并/拆分修正增量聚类的顺序误差 | 完全未实现，`ClusterRebuildJob` 组件在方案 §12.1 中被点名但代码里不存在 | 无对应文件 |

结论：**不是方案设计错了，是实现没有按已冻结方案做**。方案里"候选门槛多指标 gate"（`sampleCount>=20` 才能进候选）、事务隔离、幂等、Outbox 可靠投递等骨架是对的，不需要推倒重来。

## 二、已在 `l3-similarity-fix` 分支完成的工作

> 分支基于 `origin/feature/l3-query-clustering` 新建，当前改动**全部是未提交的工作区改动**，未 commit、未 push。使用 `git diff --stat` 可查看全部改动文件。

### 1. Spec 层（已重新冻结）

- **`.specs/MCPSTAT-1-L1/solution.md`**：新增决策 D10——`mcp_tool_versions` 增加可空 `module_key` 字段，登记或提交新版本时由项目负责人显式指定，系统不猜测、不用 Project 代替；同步更新数据模型章节、DDL、接口契约（新增 `PATCH /admin/versions/{id}/tools/{toolId}/module`）、实现步骤。已用 `npm run spec -- freeze MCPSTAT-1-L1 solution --next acceptance_first --refreeze` 重新冻结。
- **`.specs/MCPSTAT-1-L3/solution.md`**：关闭 §16 待冻结项的前两项：
  - Module 来源改为直接读取 L1 的 `module_key`；`module_key` 为空的工具参与的调用轮次整轮 `modulePath` 记为 `null`，进入未覆盖 Query 池，不再静默退化成 Project 分桶。
  - 补齐 `EmbeddingProvider` 可插拔接口设计（本地模型 / 远程 API 两种实现）、质心（语义中心）增量更新公式、基于标注数据的阈值校准方法论、`ClusterRebuildJob` 周期合并拆分机制。**具体阈值数值和 Embedding 后端配置仍待真实数据压测和你提供的服务配置确定，在此之前只能用于影子运行。**
  - 已用 `npm run spec -- freeze MCPSTAT-1-L3 solution --next direct_build --refreeze` 重新冻结。

### 2. Registry 侧（L1，`module_key` 登记）

- `src/domain.ts`：`ToolVersion` 增加 `moduleKey: string | null`。
- `src/db/schema.sql`：`mcp_tool_versions` 增加 `module_key` 列和索引。
- `src/db/repository.ts`：`toolFrom` 映射、`createVersion` 插入语句、新增 `updateToolModule` 方法（Memory + MySQL 两套实现）。
- `src/registry/project-service.ts`：新增 `setToolModule(versionId, toolId, submittedBy, moduleKey)`，校验版本必须是 `draft` 状态、调用者必须是项目负责人。
- `src/admin/http.ts`：新增路由 `PATCH /admin/versions/:id/tools/:toolId/module`。
- `src/console/views.ts`：`toolView` 增加 `moduleKey` 字段透出（控制台页面本身未改，只是数据可读）。

这一段**已通过 `npm run typecheck` 验证**，编译无误。

### 3. Analysis 侧（L3，相似度算法与质心）

- `src/analysis/outbox-worker.ts`：`moduleId` 改为通过 `LEFT JOIN mcp_projects → mcp_tool_versions` 读取调用当时项目生效版本里对应工具的真实 `module_key`，不再用 `project_key` 顶替。
- `src/analysis/similarity.ts`：
  - `normalizeQuery` 改为只做 Unicode 规范化、大小写统一、空白折叠，不删除任何词。
  - 新增 `fingerprintText`（更激进的清洗，仅用于指纹去重，不用于语义比较）。
  - 删除字符二元组 `querySimilarity`，新增 `cosineSimilarity` 和 `averageVector`。
  - `modulePathOf`、`sceneOf` 保持不变（原实现在"缺失 moduleId 时整轮记 null"这点上本来就是对的，只是上游没喂真实数据）。
- `src/analysis/embedding-provider.ts`（新文件）：定义 `EmbeddingProvider` 接口；`RemoteEmbeddingProvider`（调用 OpenAI 兼容 `/embeddings` 接口，通义千问 DashScope 兼容模式可直接对接，端点/密钥/模型名走配置）；`LocalEmbeddingProvider`（占位，未接入真实模型前构造即抛错，避免被误用）；`DeterministicFallbackEmbeddingProvider`（非语义的词级 n-gram 哈希兜底，明确注释只能用于离线开发/测试和影子运行，不能用于生产候选判断）。
- `src/analysis/types.ts`：`QueryCluster` 增加 `centroidVector`、`embeddingModelVersion`、`mergedIntoClusterId`；`ClusterMember` 增加 `queryVector`；`ClusterThresholds` 增加 `mergeSimilarity`、`minimumRebuildMembers`。
- `src/analysis/batch-service.ts`：`AnalysisBatchService` 构造函数新增 `embeddings: EmbeddingProvider` 参数；`processInput` 改为对输入 Query 调用 `embeddings.embed()` 得到向量，与候选类别的**质心**（而非单条代表文本）算 cosine 相似度；只与 `embeddingModelVersion` 相同的类别比较，避免跨模型版本向量空间不一致；新类别创建时写入质心；成员写入后调用 `repository.updateCentroid` 增量重算质心。
- `src/analysis/rebuild.ts`（新文件）：`ClusterRebuildJob`，周期性对每个候选范围（Project + ModulePath + Embedding 模型版本）内状态为"观察中"的类别做贪心层次聚合合并——每轮找 cosine 相似度最高的一对类别，若 ≥ `mergeSimilarity` 阈值就合并（成员迁移到样本数更多的一方，另一方标记为 `merged`），直到没有可合并的对为止。**当前只做合并，不做自动拆分**（拆分只写入评分历史供人工复核，方案里也是这么定的）。
- `src/analysis/repository.ts`：`AnalysisRepository` 接口新增 `listMemberVectors`、`updateCentroid`、`mergeClusters`（Memory + MySQL 两套实现都已写）；`clusterFrom`/`createCluster`/`addMember` 相应更新以读写向量字段。
- `src/db/schema.sql`：`mcp_query_cluster` 增加 `centroid_vector`、`embedding_model_version` 列；`mcp_query_cluster_member` 增加 `query_vector` 列。
- `src/config.ts`：新增 `L3_MERGE_SIMILARITY`、`L3_MINIMUM_REBUILD_MEMBERS`、`L3_REBUILD_INTERVAL_MS`、`L3_EMBEDDING_ENDPOINT`、`L3_EMBEDDING_API_KEY`、`L3_EMBEDDING_MODEL`、`L3_EMBEDDING_DIMENSIONS`（后四项均为可选，未配置时走兜底实现）。
- `src/main.ts`：按配置选择 `RemoteEmbeddingProvider` 或 `DeterministicFallbackEmbeddingProvider`（未配置真实 Embedding 服务时打印明确警告）；实例化并启动 `ClusterRebuildJob` 的周期调度、纳入优雅关闭流程。

## 三、尚未完成的事项（明确清单）

1. **`src/analysis/similarity.ts` 还有 1 处 TypeScript 类型错误**（`averageVector` 里 `sum[i] += vector[i] ?? 0`，`noUncheckedIndexedAccess` 下 `sum[i]` 读取仍判定可能为 `undefined`），一行修复：把 `sum[i] += vector[i] ?? 0` 改成 `sum[i] = (sum[i] ?? 0) + (vector[i] ?? 0)`。
2. **测试文件完全没有更新**，`npm run typecheck` 目前仍报错：
   - `tests/analysis-batch.test.ts` 引用了已删除的 `querySimilarity`，且构造 `AnalysisBatchService` 的地方都还是旧的两参数签名（`repository, thresholds`），需要改成新的四参数签名（`repository, embeddings, thresholds, coverage`），一般测试里可以传 `DeterministicFallbackEmbeddingProvider` 或手写一个确定性 stub。
   - `tests/mysql-analysis.integration.test.ts` 同样需要补上 `embeddings` 参数。
   - 建议新增测试覆盖：同一意图不同表达能否聚为一类、`module_key` 缺失时是否正确进入未覆盖池、质心合并（`ClusterRebuildJob`）是否按预期减少碎片化类别数、跨 `embeddingModelVersion` 的类别不会被互相比较。
3. **`RemoteEmbeddingProvider` 还没有真实可用的配置**：需要你提供千问 Embedding（或其他开源模型）的 endpoint、API Key、model 名称、向量维度，写入 `.env`（对应 `L3_EMBEDDING_ENDPOINT` / `L3_EMBEDDING_API_KEY` / `L3_EMBEDDING_MODEL` / `L3_EMBEDDING_DIMENSIONS`）。在配置好之前，系统会自动退化到 `DeterministicFallbackEmbeddingProvider`（非语义、仅供开发联调，日志会打印明确警告），不能拿这个阶段产出的候选送 L4。
4. **加入阈值 / 合并阈值仍是占位值（0.82）**，需要按 `.specs/MCPSTAT-1-L3/solution.md` §6.3 描述的方法——用标注测试集（同类别不同表达 + 跨类别相似表达）计算相似度分布，取 F1 最优切点——重新校准，正式数值出来前只能影子运行。
5. **`LocalEmbeddingProvider` 只是占位**，如果决定要本地推理（而不是全部走远程 API），需要引入实际的模型依赖（如 `@xenova/transformers`）并补全实现；目前构造即抛错，防止被误当成可用实现。
6. **控制台（Console）尚未展示 `module_key` 编辑入口**，目前只是数据可读（`toolView` 里带出该字段），项目负责人如果通过管理界面登记项目，还看不到填写模块的地方；需要走前端改动或至少通过管理 API 直接调用 `PATCH /admin/versions/:id/tools/:toolId/module`。
7. **拆分（Split）逻辑未实现**：`ClusterRebuildJob` 目前只做合并，类别内部方差过高时按方案要求"标记待人工复核"，但当前代码里连这个标记动作都还没写，只是把评分写进了 `mcp_cluster_score_history`（合并事件），没有专门的高方差检测和标记流程。
8. **历史存量数据**：如果这套 schema 已经在某个环境跑起来过（哪怕是测试环境），`mcp_tool_versions`、`mcp_query_cluster`、`mcp_query_cluster_member` 新增的列在已有表上不会自动出现——项目当前是"绿地 schema 真值源"模式，没有迁移工具，需要手工 `ALTER TABLE` 或重建库。

## 四、如果要继续推进，建议的顺序

1. 先在 `l3-similarity-fix` 分支修好 `similarity.ts` 的最后一处类型错误，把 `npm run typecheck` 跑绿。
2. 更新 `tests/analysis-batch.test.ts` 和 `tests/mysql-analysis.integration.test.ts`，把 `npm run check` 跑绿。
3. 决定 Embedding 后端：把千问（或其他）Embedding 服务的配置发给负责实现的人，写入环境变量。
4. 用一批有标注的真实/模拟 Query（同主题多种表达 + 跨主题相似表达）跑一次影子聚类，观察 `semantic_cohesion` 分布，据此把 `L3_JOIN_SIMILARITY` / `L3_MERGE_SIMILARITY` 从占位值 0.82 校准成正式数值，并把结果回写进 `.specs/MCPSTAT-1-L3/solution.md` §7.1、§16。
5. 决定是否需要控制台上的 `module_key` 编辑入口（当前只有 API），需要的话按 CONSOLE 的 Spec 流程另外走一版方案。
6. 全部验证通过后，再决定是提交到 `l3-similarity-fix` 并发 PR 合并回 `feature/l3-query-clustering`，还是由你自己在别的 worktree 里参照这份文档手动整合。

## 五、当前分支状态

```
分支：l3-similarity-fix（本地新建，跟踪 origin/feature/l3-query-clustering）
状态：17 个文件修改 + 2 个新文件，全部是未提交的工作区改动
      （.specs/MCPSTAT-1-L1、.specs/MCPSTAT-1-L3 已重新冻结）
未提交、未推送；未创建 PR
```

这份文档本身（`L3_CLUSTERING_ANALYSIS.md`）也在这个分支的工作区里，如果不需要可以直接删除，不影响其他改动。
