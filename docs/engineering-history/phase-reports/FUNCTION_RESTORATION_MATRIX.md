# Functional Restoration Matrix

| C 能力 | 目标 D 模块 | 是否已存在 | 是否需要迁移 | 是否需要重构 |
|---|---|---:|---:|---:|
| draft validation | `app/server.mjs` `pipelineDraftErrors`, `app/auto-approval.mjs` | 是 | 否 | 否 |
| auto-approval decision | `app/auto-approval.mjs` | 是 | 否 | 否 |
| PII-safe approval audit | `server.mjs` pipeline audit + observability envelope | 部分 | 否（能力已覆盖） | 仅需 contract 对齐 |
| classified metrics | `app/observability.mjs` | 是 | 否 | 否 |
| readonly reconciliation | `app/observability.mjs` + `/api/observability` | 是 | 否 | 否 |
| Control Plane display | D control-plane/status and readonly APIs | 部分 | 需核对 UI/API 对齐 | 可能需要只读适配 |
| collection/contact ingestion | `contact-collection.mjs`, collection APIs | 是 | 否 | 否 |
| pipeline claim/stage/artifact | `server.mjs`, pipeline worker/tests | 是 | 否 | 否 |
| draft generation | drafting stage/artifact path | 是 | 否 | 否 |
| approval gate | manual approval route and pure auto decision | 是 | 否 | 否 |
| outbox preparation/transition | `prepareOutboxEntry`, `transitionOutbox` | 是 | 否 | 保持现有发送门 |
| delivery/SMTP | `sendPipelineDraftBatch`, SMTP guard | 是 | 否 | 不得从 C 恢复自动副作用 |
| feedback/recovery | `recordFeedbackEvent`, delivery circuit | 是 | 否 | 仅补分类字段时重构 |
| C auto-prepare-outbox behavior | route-specific C implementation | 否（按安全边界不启用） | 否 | 是，如未来授权需拆分 |
| C systemd/runtime Control Plane probe block | C-only mixed block | 否 | 否 | D 已有安全只读替代；不恢复历史实现 |

分类：A= D 已有；B= C 有而 D 缺；C=存在但需安全重构；D=历史遗留/不应恢复。
