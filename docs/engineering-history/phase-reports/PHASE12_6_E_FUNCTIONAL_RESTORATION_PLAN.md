# Phase 12.6-E Functional Restoration Plan

## 业务链完整性

| 阶段 | D 当前证据 | 判断 |
|---|---|---|
| Collection | collection store、queue APIs、`contact-collection.mjs` | A 已存在 |
| Contact | `/api/contacts`、validation/suppression stores | A 已存在 |
| Pipeline | job creation、claim、stage update、artifact 读写 | A 已存在 |
| Validation | `pipelineDraftErrors`、contact validation、approval checks | A 已存在 |
| Draft | drafting artifact 与 draft API | A 已存在 |
| Approval | manual approval route + pure `evaluateAutoApproval` | A 已存在；C 仅有 route 编排差异 |
| Outbox | prepare/transition 与发送前门控 | A 已存在；保持受控 |
| Delivery | SMTP sender、delivery circuit、send gate | A 已存在；不恢复 C 的自动副作用 |
| Feedback | feedback event ingestion、suppression、circuit recovery | A 已存在 |

## 恢复原则

“无损恢复”指业务能力不丢失，不等于复制 C 的运行时状态。C 的纯校验/决策/分类能力若 D 缺失才迁移；当前审计未发现必须迁移的 B 类核心阶段能力。

## 真正缺口

1. Control Plane 展示与分类字段的逐项 API/UI 对齐仍需只读验证。
2. C auto-approval route 的 orchestration 尚未以无副作用 service 形式落地；列为 C 类安全重构，不得直接恢复。
3. 历史事件的 legacy mapping 只能视图映射，不能修改 raw 数据。

## 不应恢复

systemd 探针混合运行块、自动 outbox 创建、quota/timer/lock/delivery/SMTP 状态变更、queue lease 或 runtime 假设均属于 D 类或受控边界，永久排除在功能恢复 patch 之外。

## 下一步

在隔离分支补充只读 Control Plane contract fixture；随后对纯 approval service 做单元测试和人工审查。通过前不得修改 `server.mjs`，不得改变 production/main、timer、runtime、queue、outbox 或发送状态。
