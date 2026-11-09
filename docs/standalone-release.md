# 独立仓库发布

2026-11-09，从 x-pkm-research 提交 `d33a0495275570fbe8478b2ee736f7ba357a2999` 的 `packages/js-superagent/` 导出已跟踪文件，建立独立 Git 历史。没有导入原仓库业务资料、凭据、数据库或运行缓存。

源码路径调整为仓库根目录；README 改为独立安装说明，原开发记录保留为历史参考，手动 DSH 测试使用 PATH 或 DSH_EXECUTABLE。原项目内的副本和部署保持原状，不自动切换依赖。

保留 UNLICENSED 元数据及上游 MIT 来源声明；未发布 npm。

独立目录验证：npm ci 后 npm run check 通过，包括上游来源哈希、类型检查、运行时回归、核心／SQLite 测试及干净消费者 CLI/SDK 安装包验证。修正 check 在类型检查前先构建，以支持首次克隆。
