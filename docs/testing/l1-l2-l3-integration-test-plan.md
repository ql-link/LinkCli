# LinkCli L1-L2-L3 真实联调测试方案

## 1. 目标与范围

本方案用于验证 LinkCli 从标准 MCP 服务接入，到调用过程可靠采集，再到 Query 聚类和 L4 候选生成的完整链路。

测试范围如下：

- L1：服务登记、审核、健康发布、平台鉴权、统一工具清单和标准 MCP 调用路由。
- L2：调用前可靠记录、调用后补写、轮次归组、迟到处理、结算、统计和分析 Outbox。
- L3：完整轮次消费、Query 聚类、场景统计、候选门槛、覆盖缺口和 L4 候选 Outbox。
- 跨层联调：真实 MCP Client → LinkCli → 测试 MCP 服务 → MySQL → L2 Worker → L3 Batch。

本方案不验证 L4 的 Skill 生成、回放、数据库反向校验和发布。

## 2. 当前代码基线与联调门禁

### 2.1 当前基线

| 模块 | 当前代码位置 | 状态 |
|---|---|---|
| L1 | 当前 `master` 与 `origin/dev` | 已实现服务登记、审核、网关和真实 MySQL/MCP 测试 |
| L2 | `origin/dev`，提交 `4247d4d`，已合入 `origin/dev` | 已实现可靠采集、轮次归组和分析 Outbox |
| L3 | 当前工作树未提交修改 | 数据链路和批处理已实现；Module 快照和语义聚类尚未通过验收 |

当前集成分支已经包含 L1、L2 和 L3。正式联调仍必须记录同一代码快照，并先通过下述 Gate 0，不能仅根据三层代码共存宣称链路已联通。

### 2.2 Gate 0：L2→L3 契约必须先打通

当前 L2 的 `mcp_analysis_outbox.payload` 主要包含：

```text
turnId、revision、attributionMethod、attributionQuality、callCount、canonicalChain
```

当前 L3 的 `AnalysisInputConsumer` 需要：

```text
eventId、turnId、settlementVersion、actorHash、queryText、calls[]、
behaviorSignals、settlementStatus、collectionTrust、attemptedSkillId/version、occurredAt
```

正式联调前必须补齐以下契约：

| 缺口 | 正确来源 | 禁止做法 |
|---|---|---|
| Query 原文 | L2 `mcp_turns.user_question` 或结算载荷 | 不允许 L3 从 Tool 参数猜 Query |
| 用户摘要 | L2 根据稳定平台主体生成不可逆摘要 | 不允许保存平台 Token 或明文身份凭据 |
| Project/Module | 调用发生时的 MCP 注册快照 | 不允许仅根据 Tool 名猜 Module |
| 参数键 | L1 调用前保存的脱敏结构 | 不允许把参数值复制到 L3 |
| 行为信号 | L2 结算结果 | 不允许由 L3 根据单条调用临时推断轮次行为 |
| 结算状态 | L2 轮次结算 | 不允许把 Tool 成功直接等同于用户问题成功 |
| Outbox 消费 | 幂等消费 `turn_id + settlement_revision` | 不允许用人工 SQL 插入 `mcp_analysis_input` 冒充端到端联调 |

Gate 0 通过标准：一次真实 MCP 调用形成 L2 已结算轮次后，Analysis Outbox Worker 能够自动、幂等地生成一条 L3 `mcp_analysis_input`，且字段来源可以逐项追溯。候选路径还必须使用调用时稳定的 `project_id + ordered module_id` 快照；当前 `project_id + project_key` 只能验证数据链路，不能作为 Module 业务边界的验收证据。

### 2.3 其他前置依赖

- 零调用 Query 需要宿主提供明确的“轮次结束但未调用 MCP”事件；仅靠 `tools/call` 无法发现零调用需求。
- `expand_skill` 真实联调需要可读取的 Skill 能力元数据和生产 `SkillCoverageResolver`；未接入前只能做受控模块测试，不能宣称生产覆盖缺口链路已验证。
- L3 使用的 Module ID 必须来自稳定注册快照。若当前 MCP 注册模型尚未保存 Module，必须先补该字段和版本快照。
- L3 的字符二元组相似度已在 50 条真实 Query 中失败，替换为本地语义模型并完成标注数据验证前，不得宣称 Query 聚类完成。

## 3. 测试环境

### 3.1 环境组件

| 组件 | 要求 |
|---|---|
| MySQL | MySQL 8，独立数据库，库名必须以 `_dev` 或 `_test` 结尾 |
| LinkCli | 合并 L1、L2、L3 后的同一代码快照 |
| MCP 下游 | 标准 Streamable HTTP 测试服务，至少提供用户、订单和资产模块工具 |
| MCP Client | 官方 SDK Client，支持 Authorization、传输会话和 `_meta` 轮次上下文 |
| 时钟 | 测试环境允许缩短 L2 idle/grace 和 L3 batch/span 门槛 |

禁止连接共享业务库或生产库。测试前后只清理专用测试库中的 LinkCli 表。

### 3.2 测试 MCP 工具

测试服务至少提供：

| Project/Module | Tool | 行为 |
|---|---|---|
| `crm/user` | `lookup_user` | 查询虚构用户 |
| `commerce/order` | `query_order` | 查询虚构订单 |
| `commerce/order` | `update_order` | 修改隔离测试订单 |
| `commerce/order` | `delete_order` | 删除隔离测试订单，可配置业务错误 |
| `asset/asset` | `query_asset` | 查询虚构资产 |

所有数据使用虚构 ID。测试 MCP 必须记录实际收到的参数和调用次数，用于验证项目 Token、平台字段剥离和“业务工具不自动重试”。

### 3.3 建议测试配置

```text
COLLECTION_IDLE_TIMEOUT_MS=1000
COLLECTION_GRACE_PERIOD_MS=500
COLLECTION_WORKER_INTERVAL_MS=200
COLLECTION_MAX_DELIVERY_ATTEMPTS=3
L3_BATCH_ENABLED=true
L3_BATCH_INTERVAL_MS=1000
L3_BATCH_SIZE=100
L3_MINIMUM_SAMPLES=3
L3_MINIMUM_ACTORS=3
L3_MINIMUM_SPAN_MS=0
L3_MINIMUM_INPUT_COMPLETENESS=1
L3_MINIMUM_COHESION=0.8
L3_MINIMUM_SUCCESS_RATE=0.9
L3_MINIMUM_COVERAGE_GAPS=1
L3_MINIMUM_COVERAGE_GAP_RATIO=0.5
```

这些值仅用于联调加速，不作为生产阈值结论。

## 4. L1 模块测试

### 4.1 需求

L1 负责把标准 MCP 服务安全接入统一网关：项目登记后生成不可变版本，默认经过人工审核和首次探活；只有已批准、健康且未暂停的工具进入统一清单。外部 Agent 使用平台凭据调用统一 `/mcp`，网关负责鉴权、名称改写、项目 Token 装配、单次转发和调用事实受理。

### 4.2 重难点

- 审核通过不等于发布，首次探活成功后才能原子切换生效版本。
- 项目 Token 必须加密保存，只能作为下游认证信息，不能进入响应、日志或业务参数。
- 平台 Token 只保存 SHA-256 摘要，过期和吊销必须在调用下游前拒绝。
- 跨项目重名 Tool 必须通过 `<projectKey>__<toolName>` 保持唯一。
- 用户问题和轮次元数据只能用于采集，不能传给业务 Tool。
- 业务工具调用始终至多一次；L2 新方案要求调用前可靠记录失败时拒绝调用，而不是产生无法追踪的业务副作用。

### 4.3 模块测试用例

| ID | 场景 | 操作 | 主要断言 |
|---|---|---|---|
| L1-01 | 正常登记 | 登记带正确 Project Token 的标准 MCP 服务 | 创建草稿版本；Token 不出现在响应和日志 |
| L1-02 | 非标准服务 | 登记普通 HTTP、错误协议或不可连接地址 | 返回稳定错误；项目、版本、Tool 表无残留 |
| L1-03 | 审核与发布 | 提交、由另一审核人批准并探活 | 版本为 approved，项目为 active/healthy，生效指针原子切换 |
| L1-04 | 自审限制 | 提交人审核自己的版本 | 请求被拒绝，审核状态不变 |
| L1-05 | 并发审核 | 两名审核人并发批准/驳回 | 只有一个结论成功，只存在一条最终审核记录 |
| L1-06 | 高风险变更 | 删除输入字段或改变输出结构 | 对应 Tool 暂停，旧版本不被静默覆盖 |
| L1-07 | 工具清单 | 使用有效平台凭据调用 `tools/list` | 只返回已发布、健康、未暂停 Tool；名称有项目前缀 |
| L1-08 | 无效凭据 | 缺失、过期或吊销平台 Token | 转发前拒绝，下游调用次数为 0 |
| L1-09 | 正常调用 | 调用查询 Tool | 业务结果与直连一致；下游只收到业务参数 |
| L1-10 | 敏感边界 | 参数含 token/password 等键 | L2 摘要脱敏；日志、响应和数据库无真实密钥 |
| L1-11 | 下游错误 | Tool 返回业务错误或协议错误 | 返回稳定错误分类；不自动重试；健康计数按规则变化 |
| L1-12 | 调用前记录失败 | 故障注入使 L2 持久受理失败 | 下游不执行，调用方收到采集不可用错误 |
| L1-13 | 调用后补写失败 | 下游已成功但完成记录补写失败 | 下游只执行一次；调用方获得原结果；保留 partial 记录 |
| L1-14 | 重启恢复 | 完成登记、凭据和发布后重启 LinkCli | 工具清单和调用能力从 MySQL 恢复 |

## 5. L2 模块测试

### 5.1 需求

L2 负责把每次 MCP 调用可靠记录并归属于一轮用户请求。精确模式使用宿主注入的 conversation/turn 元数据；兼容模式使用调用凭据、传输会话和 Query 指纹推断。调用事件通过 MySQL Outbox 至少一次投递，轮次结算后只有可信或推断且完整的记录进入分析 Outbox。

### 5.2 重难点

- MCP `tools/call` 本身没有用户消息边界，MCP Session 也不等同于一轮 Query。
- 调用前必须先持久化，调用后补写失败时不能重试有副作用的业务 Tool。
- 重启、重复投递、Worker 并发和租约过期不能造成事件丢失或重复计数。
- 真实调用顺序由开始时间、持久接收顺序和事件 ID 决定；时间重叠调用必须形成并行组。
- 精确与推断归属必须区分，存疑、缺失和 partial 记录不能进入 L3。
- 迟到事件需要增加 settlement revision，不能静默覆盖已经投递的版本。
- Query 可以明文存入业务库，但不能进入日志或错误响应，九十天后必须清理。

### 5.3 模块测试用例

| ID | 场景 | 操作 | 主要断言 |
|---|---|---|---|
| L2-01 | 精确轮次 | 同一 conversation/turn 连续调用多个 Tool | 归入同一 trusted 轮次 |
| L2-02 | 相同 Query 不同轮次 | 使用不同 client turn ID 重复相同问题 | 生成两个独立轮次 |
| L2-03 | 并发聊天隔离 | 不同 conversation 并发相同 Query | 调用不串轮次 |
| L2-04 | 会话推断 | 无精确元数据，有会话和相同 Query | 归入一个 inferred 轮次 |
| L2-05 | 凭据推断 | 无会话，仅同凭据和 Query | 空闲窗口内归组并记录会话缺失 |
| L2-06 | 确定性非法输入 | Query 缺失、空白、超长或含控制字符 | 下游不调用，返回可修正错误 |
| L2-07 | 启发式信号 | Query 过短、模板化或实体不重合 | 业务继续，质量变为 suspicious，不进入 L3 |
| L2-08 | 重复事件 | 相同 event ID 投递两次 | 明细和轮次调用数只增加一次 |
| L2-09 | Worker 重启 | ready/processing 事件在进程重启后恢复 | 租约到期后继续投递，不丢失 |
| L2-10 | 退避与死信 | 连续故障达到最大次数 | 状态进入 dead_letter，可由运营者重放 |
| L2-11 | 并发首次归组 | 两 Worker 同时处理同一候选键 | MySQL `GET_LOCK` 后只创建一个轮次 |
| L2-12 | 乱序到达 | 调用 3、1、2 顺序到达 | 结算链仍按真实开始顺序排列 |
| L2-13 | 并行调用 | 两个调用执行时间重叠 | `parallelGroup` 相同，不伪造串行顺序 |
| L2-14 | 生命周期 | collecting → grace → finalized | 状态、结束原因和 settlement revision 正确 |
| L2-15 | 迟到修订 | 定稿后修订窗口内追加精确事件 | 轮次不回退，revision 增加并重新生成 Outbox |
| L2-16 | 结算失败隔离 | 一个轮次结算失败、另一个正常 | 失败轮次退避，正常轮次仍完成 |
| L2-17 | 质量门槛 | trusted/inferred/suspicious/partial 同时结算 | 只有 trusted/inferred 且完整记录进入分析 Outbox |
| L2-18 | 统计权限 | 项目负责人查询其他项目 | 返回无权限，正文和摘要不泄露 |
| L2-19 | 保留期 | 构造超过九十天的数据并执行清理 | Query/调用明细删除，长期结算与聚合保留 |
| L2-20 | 日志安全 | 成功、错误、重试、死信全过程抓取日志 | 无 Query、参数正文、结果正文和任何密钥 |

## 6. L3 模块测试

### 6.1 需求

L3 只消费 L2 已结算的完整轮次，按定时批次完成 Query 聚类和频次统计。候选范围由真实有序 Project/Module 路径限定，查询、修改、删除属于类别下的不同场景。达到门槛后生成 `new_skill`、`expand_skill` 或 `uncovered_demand` 候选，交给 L4。

### 6.2 重难点

- L3 不接收单次 `CallEnvelope`，也不实时聚类。
- Project 和 Module 必须保持有序关联，不能让不同跨项目路径碰撞。
- Module 路径只是候选范围，同一路径下不同业务目标仍需语义拆分。
- Query/修改/删除等动作不能成为类别硬边界，但必须作为组内场景和风险证据保存。
- 同一 Turn 的高 settlement version 必须幂等替代旧版本；已分析后不能静默改版。
- 单条异常输入必须独立回滚并继续批次，不能阻塞后续输入。
- 同一类别、版本和类型的候选保持幂等；类别保持已交付状态时不因版本增长重复产生同类型候选，重新进入观察状态后才允许再次交付，`new_skill` 后出现覆盖缺口仍可产生 `expand_skill`。
- 生产覆盖缺口判断依赖真实 Skill 元数据，不能用测试 Fake 冒充生产完成。

### 6.3 模块测试用例

| ID | 场景 | 操作 | 主要断言 |
|---|---|---|---|
| L3-01 | 批处理边界 | 写入输入但不运行 Batch | 不产生 Cluster；Batch 后才聚类 |
| L3-02 | 宽口径聚类 | 查用户→查/改/删订单 | 一个 Cluster，三个 Scene |
| L3-03 | 不同模块路径 | 用户→订单与用户→资产 | 分属不同候选桶 |
| L3-04 | 跨 Project 路径 | Module 名相同但 Project/Module 顺序不同 | `modulePathHash` 不同 |
| L3-05 | 同路径不同目标 | 审批权限与物流轨迹 | 语义不足时拆成两个 Cluster |
| L3-06 | 未覆盖需求 | 输入 zero_call/unmatched Query | 进入 uncovered 类别，达标后产生 `uncovered_demand` |
| L3-07 | 输入幂等 | 重复 event 或 turn/revision | 不重复计数 |
| L3-08 | 结算版本 | Batch 前写入更高 revision | 只分析最新版本；分析后改版明确拒绝 |
| L3-09 | 非可信输入 | collectionTrust=suspect/missing | 标记完成但不参与聚类门槛 |
| L3-10 | 质量成功 | 成功结果伴随 retry/switch/abandon/noOutput | 不计入成功样本 |
| L3-11 | 门槛不足 | 样本数、用户数、跨度或内聚度不足 | 保持 observing，不产生候选 |
| L3-12 | 新 Skill 候选 | 无 attempted Skill 且全部门槛达标 | 产生一次 `new_skill` |
| L3-13 | 已覆盖 | attempted Skill 明确覆盖类别 | 不重复产生候选 |
| L3-14 | 覆盖缺口 | 删除场景超出现有 Skill 声明 | 记录 gap，达标后产生 `expand_skill` |
| L3-15 | 后续扩展 | Cluster 已交付 `new_skill` 后出现 gap | 再产生一次 `expand_skill`，不重复同类型事件 |
| L3-16 | 单条失败隔离 | 第一条 coverage/DB 处理失败，第二条正常 | 第一条回滚待重试，第二条正常分析，调度器报告失败数 |
| L3-17 | 多实例 Batch | 两实例同时运行 | 只有一个实例获得 MySQL advisory lock |
| L3-18 | Outbox 原子性 | 候选写入时注入数据库异常 | Cluster 状态和 Outbox 同时回滚，不出现半完成状态 |

## 7. L1→L2→L3 完整联调场景

以下用例必须在三个模块位于同一代码快照、使用真实 MySQL 和标准 MCP HTTP 的情况下执行。

### 7.1 核心主链路

| ID | 场景 | 端到端步骤 | 最终断言 |
|---|---|---|---|
| E2E-01 | 登记到调用 | 登记测试 MCP、提交、审核、探活、签发平台凭据、SDK 调用 Tool | L1 项目 active/healthy；下游收到一次正确调用；调用事实进入 L2 Outbox |
| E2E-02 | 精确轮次结算 | 同一精确 Turn 调用 `lookup_user→query_order` | L2 形成一个 trusted finalized Turn，调用链顺序正确，自动写入 L3 输入 |
| E2E-03 | 宽口径需求聚类 | 三个独立调用方分别执行用户→查询/修改/删除订单 | L3 形成一个用户→订单 Cluster、三个 Scene，达标后输出一个 `new_skill` |
| E2E-04 | 模块边界 | 增加用户→资产 Query | 资产链路不进入用户→订单 Cluster |
| E2E-05 | 语义边界 | 相同模块链分别查询审批权限和物流轨迹 | 两类 Query 不因模块路径相同而错误合并 |

### 7.2 归属、质量和版本

| ID | 场景 | 端到端步骤 | 最终断言 |
|---|---|---|---|
| E2E-06 | 精确与兼容 | 分别使用 `_meta` 精确 Turn、会话+Query 推断 | L2 分别标记 trusted/inferred；两者完整时可进入 L3 |
| E2E-07 | 存疑隔离 | 使用模板化或过短 Query 调用 | L1 业务调用正常；L2 标记 suspicious；L3 无对应输入或不计门槛 |
| E2E-08 | 迟到修订 | Turn 定稿并送入 L3 前追加精确迟到调用 | L2 revision 增加；L3 只使用最新版本，不重复累计旧链 |
| E2E-09 | 已分析后迟到 | L3 已分析后再收到修订 | 系统进入显式补偿/重建路径，不能静默重复计数 |
| E2E-10 | 零调用 Query | 宿主提交未调用 MCP 的完整结束事件 | L2 产生 zero_call 结算；L3 聚类为 uncovered demand |

### 7.3 故障、重启和并发

| ID | 场景 | 端到端步骤 | 最终断言 |
|---|---|---|---|
| E2E-11 | 调用前数据库故障 | 在 L1 受理调用前断开 MySQL | 下游调用 0 次；调用方收到采集不可用错误 |
| E2E-12 | 调用后补写故障 | 下游执行后让完成补写失败 | 下游只执行一次；L2 保存 partial；该记录不进入 L3 |
| E2E-13 | Worker 重启 | 调用完成后、L2 消费前重启 LinkCli | 事件恢复并最终结算；无重复调用和重复明细 |
| E2E-14 | 重复与乱序 | 重复投递并改变到达顺序 | L2 幂等，L3 样本数不重复，调用链按真实时间排序 |
| E2E-15 | 并行调用 | 同一 Turn 并发调用两个 Tool | L2 保存 parallelGroup；L3 场景保留真实链路，不伪造严格顺序 |
| E2E-16 | L3 毒性输入 | 一条 L3 输入处理失败并同时存在正常输入 | 失败输入保留待重试，正常输入继续完成，批次产生失败告警 |
| E2E-17 | 多实例竞争 | 启动两个 LinkCli 实例同时运行 Worker/Batch | L2 不重复归组；L3 只有一个 Batch 获锁；计数一致 |

### 7.4 Skill 覆盖和安全

| ID | 场景 | 端到端步骤 | 最终断言 |
|---|---|---|---|
| E2E-18 | 已有 Skill 覆盖过窄 | 现有 Skill 只声明查询订单，实际出现删除订单 | L2 只记录 attempted Skill 事实；L3 识别 gap 并产生一次 `expand_skill` |
| E2E-19 | 状态感知候选幂等 | 重跑 Worker、Batch 和候选写入，再增加样本使类别版本增长 | 同一类别版本和类型只有一条；类别仍为已交付时不重复同类型候选，不同类型仍可交付，样本数不重复 |
| E2E-20 | 全链路敏感信息 | Query 和参数包含虚构 token/password 字段 | 下游只收到业务所需参数；日志、响应、L2/L3 Outbox 不含秘密值 |

## 8. 数据库核对点

每个端到端用例至少核对以下表，且所有记录必须能通过稳定 ID 串联：

| 层级 | 表 | 核对内容 |
|---|---|---|
| L1 | `mcp_projects`、`mcp_service_versions`、`mcp_tool_versions`、`mcp_reviews`、`mcp_call_credentials` | 审核、健康、生效版本、凭据摘要 |
| L2 | `mcp_call_outbox` | 调用前记录、完成状态、重试、租约和死信 |
| L2 | `mcp_call_events`、`mcp_turns` | 轮次归属、质量、顺序、并行组、结算版本 |
| L2→L3 | `mcp_analysis_outbox`、`mcp_analysis_input` | 结算版本幂等转换及字段来源完整性 |
| L3 | `mcp_analysis_input`、`mcp_query_cluster`、`mcp_query_cluster_scene` | 输入的唯一类别归属、覆盖缺口、类别、场景和统计指标 |
| L3→L4 | `mcp_l4_candidate_outbox` | 候选可靠交付和幂等性 |

数据库核对只读取必要字段，不打印 Query、参数、结果或凭据正文。

## 9. 执行顺序

1. 记录当前 Git SHA、工作树差异、Node/MySQL 版本和测试库名。
2. 在隔离分支或工作树中整合 `origin/dev` 的 L2 与当前 L3，处理 schema、配置、主进程和测试冲突。
3. 完成 Gate 0 的 L2→L3 契约适配测试；未通过时停止端到端联调。
4. 初始化专用 MySQL 8 测试库，执行绿地 schema，并核对所有 L1/L2/L3 表和约束。
5. 分别执行 L1、L2、L3 模块测试。
6. 启动测试 MCP、LinkCli 和 MCP Client，执行 E2E-01 至 E2E-20。
7. 执行重启、故障注入和双实例并发场景。
8. 运行 `npm run check` 和 `npm run test:mysql`，记录真实通过、失败和跳过数量。
9. 清理测试数据和临时服务，保留脱敏测试报告。

## 10. 通过标准

只有同时满足以下条件，才能宣称 L1-L2-L3 真实联调通过：

- 三层代码来自同一可复现 SHA，工作树状态已记录。
- 使用真实 MySQL 8 和真实标准 MCP HTTP Client/Server，而不是内存仓库。
- Gate 0 自动完成 L2 Outbox 到 L3 Input 的幂等转换。
- 核心主链路、失败恢复、重启、并发和敏感信息场景全部通过。
- 业务 Tool 在任何错误和重试场景下调用次数均不超过预期次数。
- L2 的 suspicious/partial/missing 数据不会污染 L3。
- L3 聚类结果、场景数、样本数和候选类型与数据库记录一致。
- 没有把跳过的真实 MySQL、真实 MCP、零调用或 Skill 覆盖场景描述为已验证。

## 11. 测试结果记录模板

| 字段 | 内容 |
|---|---|
| 代码 SHA / 工作树 |  |
| MySQL 版本 / 测试库 |  |
| Node 版本 |  |
| 测试 MCP 版本 |  |
| 执行时间 |  |
| L1 模块结果 | 通过 / 失败 / 阻塞 |
| L2 模块结果 | 通过 / 失败 / 阻塞 |
| L3 模块结果 | 通过 / 失败 / 阻塞 |
| 端到端结果 | 通过 / 失败 / 阻塞 |
| 自动化命令 |  |
| 失败用例及证据 |  |
| 跳过项及原因 |  |
| 残余风险 |  |
