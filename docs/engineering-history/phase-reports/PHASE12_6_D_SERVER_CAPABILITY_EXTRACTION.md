# Phase 12.6-D Server Capability Extraction

## 当前状态（A/B/C）

- **A 已实施**：D 已有 observability module、event envelope、trace inheritance、只读 metrics/reconciliation endpoint；`auto-approval.mjs` 已是纯决策模块。
- **B 代码存在但未启用为新 route**：C 的 auto-approval route 可拆为 decision 与副作用两层；classified metrics 大块可拆为只读聚合服务。
- **C 未来规划**：在隔离分支评审后才可能添加 service wrapper 或最小 server adapter；本阶段没有应用。

## C 能力取舍

值得进入 D：draft validation、approval decision、PII-safe audit payload、trace/classification 事件封装、只读 classified metrics/reconciliation。

永久拒绝进入 capability patch：quota/timer/lock/runtime 状态改变、delivery/SMTP 行为、queue claim/lease、outbox 创建或状态转换、systemd 控制、自动发送和任何隐含生产运行假设。

## 验证结果

- `node --check app/server.mjs`：PASS
- `node app/tests/observability-contract-unit.mjs`：PASS
- `node app/tests/deployment-contract-unit.mjs`：PASS
- `git diff --check`：PASS
- 本阶段没有创建 job/outbox，没有扫描或修改 queue/pipeline/runtime，没有发送 SMTP。

## 稳定边界与唯一源判断

server 可以保持生产稳定边界，因为没有应用 C 的状态性 hunk。D 尚不能立即成为唯一开发源：C 仍有未分类的 route/Control Plane 进度，且任何 server adapter 都需要单独 hunk 审批、contract test 和 review。下一步应先在隔离分支实现纯 service 的最小测试样例，再决定是否需要 server adapter；不得直接整文件合并。
