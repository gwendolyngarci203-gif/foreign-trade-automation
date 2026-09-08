# Phase 12.6-H Functional Parity Restoration

## 已完成

- 在隔离分支将 `auto-approve` route 接入 `approval-adapter`。
- adapter 负责 decision、audit、transition request；route 复用 D 既有状态转换。
- approved 仍停在 `sending/waiting_input`，要求显式发送；rejected 保持 approval 等待状态。
- 生成 C+D 业务能力等价矩阵。

## 安全审查

该 route 片段不调用 outbox preparation、SMTP、delivery transition 或运行时控制。C 的 auto-outbox、systemd、quota、timer、lock、runtime、queue lease 逻辑未恢复。

## 验证

- Node syntax：PASS
- auto-approval unit：PASS
- approval adapter unit：PASS
- integration unit：PASS
- observability contract：PASS
- deployment contract：PASS
- forbidden scan：PASS
- `git diff --check`：PASS

## 最终判断

在隔离分支，D 已覆盖 C+D 的有效 approval 编排能力，且未发生功能退化；生产控制边界保持不变。尚不能冻结为唯一开发源，仍需人工审查该 server hunk、只读 Control Plane 字段对账及最终 release review。
