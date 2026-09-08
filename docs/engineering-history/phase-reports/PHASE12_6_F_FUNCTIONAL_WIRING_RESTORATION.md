# Phase 12.6-F Functional Wiring Restoration

## 能力分类

- **A：无需修改**：Collection、Contact、Pipeline、Validation、Draft、Outbox、Delivery、Feedback，以及 observability/auto-approval 纯模块。
- **B：需要新增 service**：仅当需要统一 decision→audit payload 时，新增无副作用 approval service wrapper。
- **C：需要 server adapter**：将受控 route 接到 service 和既有 approval transition；必须 line-level、人工审查、contract test。
- **D：禁止恢复**：auto-prepare-outbox、SMTP 自动发送、quota/timer/lock/runtime 改写、systemd 控制、queue/pipeline lease 迁移。

## 实施顺序

1. 先补 approval service contract fixture（无写入）。
2. 在隔离分支实现 route adapter 草稿，验证只返回 decision/audit 或调用既有 transition。
3. 运行 syntax、approval、observability、deployment contract 和 diff/forbidden scan。
4. 只读验证 Control Plane Production/Canary/Recovery/Observability 四区。
5. 通过人工 hunk approval 后，才考虑进入 release；本阶段不修改 `server.mjs`。

## 安全判断

D 可以继续保持生产安全边界；完整业务能力不需要通过复制 C 的 server 恢复。当前距离“唯一开发源”仍差：approval adapter 的隔离实现、Control Plane 只读字段对账，以及 C 侧剩余有效编排的分类确认。

本阶段未部署、未发送 SMTP、未创建 job/outbox、未处理 queue/pipeline/runtime。
