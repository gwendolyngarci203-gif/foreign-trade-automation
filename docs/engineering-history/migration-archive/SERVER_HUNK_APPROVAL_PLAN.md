# Server Hunk Approval Plan

| hunk | 来源 | 目的 | 生产状态影响 | 决策 |
|---|---|---|---|---|
| import block | D | 加载 observability helpers | 无，仅模块加载 | KEEP_FROM_D |
| `recordFeedbackEvent` envelope | D/C 等价能力 | 让反馈带 trace/classification | 只读事件字段 | KEEP_FROM_D |
| `createPipelineJob` envelope | D/C 等价能力 | job 建立统一 envelope | 不改变 job 状态 | KEEP_FROM_D |
| `updatePipelineStage` artifact inheritance | D/C 等价能力 | artifact 继承 trace | 不改变 claim/lease | KEEP_FROM_D |
| `/api/observability` | D | 提供只读 snapshot | 只读 | KEEP_FROM_D |
| C systemd/control-plane probe block | C | 运行状态探针与控制面聚合 | 读取 SMTP/systemd、扩大运行假设 | DROP |
| C auto-approval route | C | 自动审批业务流程 | 改变 approval/outbox 状态 | MERGE_REQUIRED，暂不应用 |
| C auto-prepare-outbox route | C | 准备 outbox | 创建业务 outbox，可能触发 quota 路径 | DROP |
| C delivery/SMTP changes | C | 发送与告警行为 | 影响 delivery/SMTP | DROP |
| C quota/timer/lock/runtime changes | C | 生产运行控制 | 直接改变生产状态 | DROP |
| C classified metrics/reconciliation | C | 指标分类与对账 | 理论上只读，但与控制面大块耦合 | MERGE_REQUIRED，单独拆 patch |

审批规则：任何含 `quota`、`timer`、`lock`、`runtime-state`、`SMTP`、outbox transition、scheduler 或实际发送调用的 hunk 均不得进入本候选。
