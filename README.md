# LinkCli

LinkCli 是企业内部标准 MCP 聚合网关。项目负责人登记已有的 Streamable HTTP MCP 服务，平台完成工具发现、版本审核、探活与发布；外部 Agent 使用一个平台凭据即可列出和调用全部已发布、健康且未暂停的工具。

第一阶段只支持标准 MCP Streamable HTTP，不接入命令行进程或任意脚本。平台不做项目级、工具级差异授权：有效平台凭据可以访问全部可用工具，项目 MCP 根据平台配置的项目 Token 自行完成业务数据权限判断。

## 本地启动

要求 Node.js 20+ 和 MySQL 8.0+。

```bash
npm install
cp .env.example .env
# 设置 DATABASE_URL、ADMIN_API_KEY、PROJECT_CREDENTIAL_KEY 和 COLLECTION_FINGERPRINT_KEY
set -a && source .env && set +a
npm run db:init
npm run dev
```

`npm run db:init` 只用于全新空库。`src/db/schema.sql` 是当前 SQL 真值源，不应对已有库重复执行。

已有 L1 数据库升级控制台所需的账号与会话表：

```bash
npm run db:upgrade:console
npm run admin:bootstrap -- --username operator --display-name "平台运营"
```

第二条命令从终端读取首个运营管理员密码，不要把密码放进命令参数。`npm run dev` 同时启动 API 和 Vite 控制台；生产构建由 Express 同域托管 `web/dist`。

## 接口

- `GET /healthz`：进程健康检查。
- `/api/*`：控制台登录会话和页面接口，浏览器使用 HttpOnly Cookie，不接触部署级管理密钥。
- `/api/statistics/*`：按项目可见性查询调用、工具和轮次统计；调用问题与明细默认保留 90 天。
- `/admin/*`：登记、版本、审核、项目状态和平台凭据管理。请求必须携带 `x-admin-api-key`、`x-platform-user-id` 和 `x-platform-role`。
- `/mcp`：标准 MCP Streamable HTTP 入口，使用 `Authorization: Bearer <platform-token>`。

为了精确记录“一轮用户输入触发的多次 MCP 调用”，宿主应在同一轮所有 `tools/call` 的 `_meta` 中传入相同的 `com.tolink.stats/conversation-id` 和 `com.tolink.stats/turn-id`。工具定义要求携带 `__linkcli_user_question`，用于问题下钻和未适配宿主的空闲窗口兼容推断；该字段不会传给下游 MCP。

管理接口和状态规则详见 [架构说明](docs/architecture.md)。

## 验证

```bash
npm run typecheck
npm run typecheck:web
npm test
npm run build
npm run check
```

自动化测试使用内存仓库和确定性 MCP 替身，并包含真实 Streamable HTTP 协议边界测试。它们不证明目标 MySQL 实例、真实项目 MCP 或部署环境已经就绪。

连接专用开发数据库执行真实 MySQL + 标准 MCP 端到端联调：

```bash
set -a && source .env.development.local && set +a
npm run test:mysql
```

该测试只接受库名以 `_dev` 或 `_test` 结尾的显式 `LINKCLI_TEST_MYSQL_URL`，执行前后会清空测试范围内的 LinkCli 表，不得指向共享业务库或生产库。
