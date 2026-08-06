# LinkCli

LinkCli 是 TypeScript + Node.js 实现的标准 MCP Streamable HTTP 聚合网关。它负责企业内部 MCP 项目的登记、版本审核、探活、统一工具清单、调用路由和 L2 调用过程投递。

`AGENTS.md` 与 `CLAUDE.md` 都链接到本文件。详细阶段工作流在 `.ai/skills/`，Spec 状态和冻结产物在 `.specs/`，长期运行事实在 `README.md` 与 `docs/architecture.md`。

## 开发约束

- 默认使用中文沟通和交付说明，代码标识与命令保留英文。
- 当前只接入标准 MCP Streamable HTTP；不要加入 stdio、命令行包装或任意协议适配器。
- 平台凭据只存 SHA-256 摘要，项目 Token 使用 AES-256-GCM 加密；任何响应、日志和测试都不得包含真实凭据。
- 第一阶段不做平台侧项目级或工具级授权。项目内部业务权限由项目 MCP 根据项目 Token 判断。
- 所有工具调用均不自动重试。用户原始问题仅用于归因，不传给下游业务工具。
- MySQL 8 的 `src/db/schema.sql` 是当前绿地 schema 真值源；内存仓库只用于自动化测试。
- 状态机、DDL、接口或权限边界发生变化时，先更新并重新冻结对应 Spec，不得在实现中静默偏离。

## 常用命令

```bash
npm install
npm run db:init
npm run dev
npm run typecheck
npm test
npm run build
npm run check
npm run spec -- status MCPSTAT-1-L1
```

不得宣称真实 MySQL、项目 MCP、L2 或部署环境已验证，除非当次实际执行并取得证据。未经用户明确要求，不创建提交、推送、PR 或远端发布。

## 目录

```text
src/admin       受保护的管理 REST API
src/registry    登记、版本、审核、风险和健康状态
src/gateway     平台鉴权、目录、路由和 MCP 服务端
src/collection  L2 信封与有界异步投递
src/db          MySQL schema 与仓库
tests           服务层、并发和标准 MCP 协议测试
```
