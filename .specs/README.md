# LinkCli 本地 Spec 工作区

`.specs/<KEY>/` 保存方案先行任务在当前工作区中的阶段快照。正式业务开发支持两条方案路径：

- `route=direct_build`：冻结 `solution.md` 后直接实现。
- `route=acceptance_first`：冻结 `solution.md`，再冻结 `acceptance.feature`，之后实现。

## 常用命令

```bash
npm run spec -- init MCPSTAT-1-L1 --source-issue <ISSUE_URL_OR_REF>
npm run spec -- status MCPSTAT-1-L1
npm run spec -- check MCPSTAT-1-L1 acceptance
npm run spec -- freeze MCPSTAT-1-L1 solution --next acceptance_first
npm run spec -- freeze MCPSTAT-1-L1 acceptance
npm run spec -- verify MCPSTAT-1-L1 --run "<验证命令>"
npm run spec -- review MCPSTAT-1-L1 --pass --evidence "未发现阻断问题"
```

`init` 只创建状态文件，不覆盖现有方案。`freeze` 会记录产物 SHA-256；冻结后修改产物会导致下游门禁失败，确认修订后必须使用 `--refreeze`。状态、哈希、验证退出码和质量审查阶段只能由工具维护，不得手工填写。

`source_issue` 原样保存外部 Issue、飞书详情文档或其他稳定来源引用，不根据来源平台改变流程。当前目录是工作区快照，不承诺跨设备自动同步。
