# Server Three-Way Diff Map

审计范围：

- C: `C:\Users\18395\.codex\worktrees\d721\外贸自动化拓客系统\app\server.mjs`
- D: `D:\zcy\外贸自动化拓客系统\app\server.mjs`
- baseline: `D:\zcy\release-phase12-clean-staging\app\server.mjs`

## 总结

| 区域/hunk | C 相对 baseline | D 相对 baseline | 分类 | 决策 |
|---|---|---|---|---|
| imports | observability、auto-approval 导入 | observability 导入 | KEEP_FROM_D；C 的 auto-approval 需 MERGE_REQUIRED | 保留 D 的观测导入；自动审批仅在独立小块审查后再合并 |
| release/browser/system alert 常量 | 新增 | 无 | DROP | 与运行时/控制面状态耦合，超出本阶段边界 |
| systemd/control-plane 探针大块 | 新增约 369 行 | 无 | DROP | 读取 systemd/SMTP/运行状态，不能随 server 能力迁移 |
| feedback event | 增加 envelope 继承 | 已存在 envelope 继承 | KEEP_FROM_D | 已落在 D，禁止重复引入 |
| pipeline job creation | C 增加 envelope 与 trace | 已存在 job envelope | KEEP_FROM_D | D 已有安全版本 |
| pipeline artifact | C 增加 trace inheritance | 已存在 artifact inheritance | KEEP_FROM_D | D 已有安全版本 |
| classified metrics/reconciliation | C 新增完整 Control Plane 聚合 | baseline/D 已有只读 observability snapshot | MERGE_REQUIRED | 需单独 contract 评审；本阶段不改 server |
| outbox/delivery observability | C 增加事件与状态路径 | D 未完全等价 | MERGE_REQUIRED | 只允许纯 envelope 字段；不得改变发送/状态转换 |
| auto-approval / auto-prepare-outbox routes | C 新增混合业务、quota、outbox 行为 | 无 | DROP | 本阶段禁止引入业务状态变更；另行审查 |
| runtime/quota/timer/lock/delivery/SMTP 变化 | C 多处新增或调整 | D 保留当前控制逻辑 | KEEP_FROM_D | 生产控制逻辑不可被 C 覆盖 |

## 结论

C 与 D 的差异为约 770 行插入、33 行删除，不能整文件合并。候选 patch 文件 `server-three-way-candidate.patch` 仅记录 baseline 到 D 当前版本的已落地安全观测差异；没有把 C 的混合 hunk 应用到 D。
