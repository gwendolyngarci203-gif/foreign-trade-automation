# Phase 12.6-G Approval Adapter Implementation

## 已实现

- `app/services/approval-adapter.mjs`：纯 decision → audit → transition request adapter。
- `app/tests/approval-adapter-unit.mjs`：approved、rejected、soft warning、hard fail fixture。
- `APPROVAL_ADAPTER_CONTRACT.md`：输入输出和副作用边界。
- `CONTROL_PLANE_CONTRACT_FIXTURE.md`：Production、Canary/Test、Recovery、Observability 只读契约。

## 安全边界

adapter 不写 store、不创建业务记录、不改变 quota/timer/lock/runtime，不执行发送，不处理 queue 或 lease。approved 结果仍明确要求显式发送；rejected 只返回拒绝 transition request。

## 验证

- Node syntax：PASS
- auto-approval unit：PASS
- approval adapter unit：PASS
- observability contract：PASS
- deployment contract：PASS
- forbidden scan：PASS（adapter 无生产控制调用）
- `git diff --check`：PASS

## 最终判断

auto-approval 的完整“决策—审计—transition request”能力已恢复，但尚未接入 `server.mjs` route，因此没有改变现有生产行为。D 更接近唯一开发源；仍需后续人工批准 server adapter 和 Control Plane fixture 的只读集成。`server.mjs` 本阶段无需修改。
