# MCPSTAT-1-L2 实施报告

## 已实现范围

- MCP 初始化说明和 `tools/call` `_meta` 精确轮次上下文；兼容问题字段保持工具契约必填并继续从业务参数剥离，确保问题下钻与未适配宿主归因可用。
- 用户问题原文保存，NFC/空白规范化值仅用于独立 HMAC 指纹；确定性错误拒绝，启发式质量信号不阻断。
- 调用前持久化、调用后完成或 `partial/unknown` 补写；业务工具始终至多调用一次。
- MySQL Transactional Outbox、租约领取、指数退避、死信和运营者重放。
- 精确/兼容轮次归组、兼容候选数据库级并发锁、持久接收顺序、`collecting/grace/finalized`、迟到修订、稳定错误分类、并行分组和规范调用链签名。
- 只有 `trusted`、`inferred` 且完整的结算写入分析 Outbox；结算失败按轮次退避，不阻断同批其他轮次。
- 九十天问题与调用明细、七天已投递 Outbox、九十天死信清理；长期轮次摘要保持按项目可见。
- 统计摘要、工具聚合、轮次/调用分页下钻和项目级权限过滤。

## 结构说明

冻结方案中的 `outbox-worker.ts`、`turn-service.ts`、`settlement-service.ts` 和 `retention-service.ts` 在实现中按事务边界合并为 `collection/repository.ts` 与 `collection/worker.ts`：轮次分配和结算必须与调用事件写入共享数据库事务，定时编排与保留期任务共享同一 Worker 生命周期。模块职责和对外契约未改变。

`src/db/schema.sql` 的四张 L2 表与冻结方案“7.3 定稿 DDL”保持一致；内存仓库仅用于自动化测试。

## 验证与未覆盖范围

最终自动化证据以 `state.yaml` 的 `verification` 为准。自动化覆盖标准 MCP HTTP、可靠受理、归组、乱序、迟到、死信、统计权限和保留期。本次另外使用隔离的 MySQL 8.0.42 临时库成功执行 `src/db/schema.sql`，并运行 `npm run test:mysql`：3 个真实 MySQL/MCP 集成测试通过，覆盖候选键并发首次建轮、稳定错误分类、重启持久化和既有审核并发；临时容器及数据已删除。尚未使用真实第三方 Agent、真实项目 MCP 或部署环境验证，关键统计查询在大数据量下的执行计划仍需上线前压测。
