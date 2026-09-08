# Phase 12.3-B：Production Event Integration & Cloud Verification

> 文档性质：生产事件写入链集成审计与云端只读验证
>
> 安全边界：未恢复 timer，未修改 quota、collection lock、runtime、queue、历史 raw event、job 或 outbox；未发送 SMTP。

## 1. 最终结论

Phase 12.3-A 的独立 observability 模块已接入本地未来事件路径，并补充了 envelope 继承、delivery event、feedback event 和 metric-level reconciliation。

但云端只读验证显示：

- 云端 API 当前没有返回 `observability` 字段；
- 云端 release metadata 仍为旧 Control Plane 版本；
- 因此 Phase 12.3-B 尚未成为云端生产系统的一部分；
- 当前不能进入 Pipeline timer 恢复条件评估的“已满足”状态。

本阶段真实状态：**本地代码已接入关键未来写入点，云端部署和 API 验证仍是阻塞项。**

## 2. A/B/C 状态

- **A / 已上线**：云端已有的 Phase 12.2-B Control Plane、raw Daily Operations、Audit Timeline、system alert。
- **B / 已接入但未部署**：本工作树新增的 event envelope 继承、classified view、legacy mapping、metric-level reconciliation。
- **C / 仍未完成**：云端部署、完整 API snapshot、所有历史/未来写入点的最终覆盖证明、双轨连续业务日对账。

## 3. 实际写入点 Integration Matrix

| Entity | 文件 / 函数 | 当前是否调用 envelope | 风险 |
|---|---|---|---|
| job | `app/server.mjs:createPipelineJob()` | 是，创建 `observability` | 旧 job 不回写，需 legacy mapping |
| pipeline artifact | `app/server.mjs:updatePipelineStage()` | 是，继承 job `traceId/classification` | 其他外部 artifact 写入点需继续审计 |
| pipeline audit | `appendPipelineAudit()` 及关键 stage/auto approval 路径 | 是，继承 job envelope | 少数旧兼容/管理路径仍可能没有统一 helper |
| draft artifact | 通过 pipeline artifact 写入 | 是，继承父 job | 必须确认所有 drafting 入口均走 stage writer |
| approval event | auto approval 与关键 pipeline approval 路径 | 关键路径是 | 历史 approval event 不修改 |
| outbox | `prepareOutboxEntry()` | 是，按 campaign/父上下文创建 envelope | 旧 outbox 只能映射，不能补写 |
| delivery event | `transitionOutbox()` | 是，继承 outbox envelope | 旧 delivery event 仍可能缺字段 |
| feedback event | `recordFeedbackEvent()` | 是，继承匹配 outbox envelope | 无匹配 outbox 时使用 feedback trace，需人工审计 |
| outbox feedback event | `recordFeedbackEvent()` 写入 `entry.events` | 是，继承 outbox | 不改变历史事件 |
| system alert | `sendInterventionAlert()` 经 `prepareOutboxEntry()` | 可继承 system classification | 云端尚未部署本改动 |
| recovery event | retry/requeue/intervention | 基础 recovery metric 支持 | 仍需逐一覆盖全部 recovery 写入点 |

### 3.1 事件继承规则

```text
Pipeline Job envelope
        ↓ inherit traceId/classification
Pipeline Artifact / Draft
        ↓ inherit traceId/classification
Outbox Entry
        ↓ inherit traceId/classification
Delivery Event / Feedback Event
```

`recovery` 事件引用原始事件，不复制 production KPI；`canary`、`test` 的 `isBillableProduction` 强制为 false。

## 4. 已实施的代码能力

### 4.1 Job、artifact 与 audit

`createPipelineJob()` 为新 job 生成 classification、origin、runType、billable 标志、createdBy、traceId、createdAt 和 schemaVersion。阶段 artifact 继承父 job envelope。关键 stage claim、stage recorded、auto approval 和 auto outbox audit 通过 `appendPipelineAudit()` 写入 envelope。

### 4.2 Outbox、delivery 与 feedback

`prepareOutboxEntry()` 为未来新 outbox 创建 envelope；`transitionOutbox()` 为 pending/sending/accepted/failed 等事件继承相同 trace。campaign ID 中明确的 canary/test 标识会进入相应分类；system alert 使用 system origin。

`recordFeedbackEvent()` 在有匹配 outbox 时继承其 classification 和 traceId；没有匹配 outbox 时生成独立 feedback trace，并保留低置信关联。

## 5. Contract Tests

新增和更新测试覆盖：

- 合法 envelope 与 schemaVersion；
- 缺失 `traceId` 失败；
- canary/test 不得标记为 billable production；
- artifact 继承 job traceId；
- outbox/delivery/feedback 继承父级 classification；
- recovery 不直接增加 production KPI；
- reconciliation 输出 metric-level raw/classified/difference/reason；
- raw event 通过只读视图，不被修改。

已通过：

```text
node --check app/server.mjs
node --check app/observability.mjs
node --check app/public/app.js
node app/tests/observability-contract-unit.mjs
node app/tests/deployment-contract-unit.mjs
git diff --check
```

## 6. Metric-level Reconciliation

当前 Control Plane 代码返回 `draft`、`approval`、`outbox`、`accepted`、`failed`、`retry` 六类逐项对账：

```json
{
  "draft": { "raw": 0, "classified": 0, "difference": 0, "reason": "matched" },
  "approval": { "raw": 0, "classified": 0, "difference": 0, "reason": "matched" },
  "outbox": { "raw": 0, "classified": 0, "difference": 0, "reason": "matched" },
  "accepted": { "raw": 0, "classified": 0, "difference": 0, "reason": "matched" },
  "failed": { "raw": 0, "classified": 0, "difference": 0, "reason": "matched" },
  "retry": { "raw": 0, "classified": 0, "difference": 0, "reason": "matched" }
}
```

非零差异标记为 `legacy_or_unclassified_event`。总对账保留 rawTotal、classifiedTotal、legacyMappedTotal、difference、differenceReasons 和 mappingRule。旧记录仍只通过 `legacyClassificationView` 映射。

## 7. 隔离 API 验证

尝试在本地工作树启动 API 时，服务在读取既有配置阶段失败：

```text
ENOENT: app/data/email-template-library.json
```

该 fixture 不存在于当前工作树。未复制生产数据、未创建业务测试数据，也未用伪造数据声称 API 成功。因此本地 API JSON snapshot 尚未完成；静态和纯函数 contract tests 已通过。

## 8. 云端只读验证结果

云端路径：`/opt/dakings-prospect-ops/`

### 8.1 Release metadata

云端只读结果：

```json
{
  "commit": "80b3bebf0fccc819693973d97b128f93d4c43829",
  "branch": "production/main",
  "recoveryPhase": "10.2",
  "recoveryStatus": "control_plane_release_frozen"
}
```

云端 Git `HEAD`：

```text
95713bc5f9f55f780ed07081a21ce16a2ad71f17
```

### 8.2 API snapshot

云端 `GET /api/control-plane/status` 响应中：

```text
observability.readOnly       = absent
observability.schemaVersion  = absent
observability.classifiedMetrics = absent
observability.reconciliation = absent
```

判定：**云端仍运行旧版本，Phase 12.3-B 未部署。** 本次没有重启服务、上传文件或修改 release metadata。

## 9. Pipeline timer 恢复条件判断

当前不能判定满足，原因是：

1. 云端还没有 observability schema 和 classified view；
2. 云端 API 无法输出 metric-level reconciliation；
3. 历史 pipeline 库存仍包含 waiting/paused/circuit-open 状态；
4. Persistent timer replay 风险仍需在部署后单独观察；
5. 新事件分类和 trace 覆盖尚未在云端得到 snapshot 证明。

## 10. 剩余实施步骤

1. 在完整部署工作树补齐只读测试 fixture，验证 API schema；
2. 审核全部 audit/recovery/approval 写入点，补齐 helper 覆盖；
3. 生成正式 release commit；
4. 通过既有部署流程发布到云端，不改变业务数据；
5. 云端只读确认 release hash、API observability schema、Control Plane 展示和 reconciliation；
6. 连续两个业务日执行 raw/classified 对账；
7. 只有上述证据完整后，才重新评估 Pipeline timer Phase A 单周期观察。

## 11. 回滚方案与禁止事项

- classified view 异常：隐藏/停用新视图，保留 raw Daily Operations；
- trace/classification 写入异常：停止新写入路径或恢复兼容读取，禁止批量修写历史数据；
- 任何运行时异常：保持两个 timer inactive，回到 `safe_hold`；
- 不删除、不重写、不重新分类历史 event；
- 不修改 quota、collection lock、runtime-state、queue、pipeline 或 outbox；
- 不发送 SMTP，不创建测试 job/outbox。

## 12. 最终判断

Observability 已经**部分进入代码生产路径**，但尚未成为云端生产系统的一部分。当前阻塞是部署和云端验证，不是 SMTP、quota 或 collection lock。

在云端 release/API/schema/reconciliation 验证完成前：

- 不具备可信生产指标层完成证明；
- 不具备进入 Pipeline timer 恢复的充分条件；
- 系统继续保持 `safe_hold`；
- 不恢复 timer，不处理库存，不创建 job/outbox，不发送邮件。
