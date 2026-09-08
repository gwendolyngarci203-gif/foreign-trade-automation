# Phase 12.3-C：Production Release & Cloud Verification

> 只读安全边界：未恢复 timer，未修改 quota、collection lock、runtime、queue、pipeline、outbox 或历史 raw event；未调用 SMTP。

## 1. 最终结论

本阶段未完成云端发布。既有生产部署流程在本地安全前置阶段停止，因为工作树缺少已核验的 `.codex_work/known_hosts`。因此没有建立 SSH、没有创建云端备份、没有上传文件、没有重启 API，也没有改变生产状态。

结论：**Phase 12.3-B 尚未成为云端生产能力。** 本地代码和契约测试通过，不能替代正式 release、云端 API snapshot 和环境一致性证明。

## 2. 发布前检查

已检查代码与部署文件：`app/server.mjs`、`app/observability.mjs`、`app/public/app.js`、两项 observability tests、`deploy/deploy-server.py`、`deploy/release.json`。部署清单已包含 observability 模块和契约测试。

为遵守本阶段禁止事项，部署器支持显式保留开关：

```text
DAKINGS_PRESERVE_RUNTIME=1
DAKINGS_PRESERVE_TIMERS=1
```

这些开关只用于保留当前 runtime quota 与 timer 状态，不绕过 SSH host key 校验。

执行结果：

```text
python deploy/deploy-server.py
RuntimeError: 缺少已核验的SSH主机指纹文件：.codex_work/known_hosts
```

| 动作 | 结果 |
|---|---|
| SSH 建立 | 未执行 |
| 服务器 backup | 未执行 |
| 文件上传 | 未执行 |
| service restart | 未执行 |
| 云端 release 更新 | 未执行 |
| 生产数据变化 | 无 |

## 3. A/B/C 状态

- **A / 已在云端**：Phase 12.2-B Control Plane、raw Daily Operations、Audit Timeline、system alert、`safe_hold` 保护状态。
- **B / 本地已接入**：job envelope、artifact trace inheritance、pipeline audit envelope、outbox/delivery envelope、feedback trace、classified view、legacy mapping、metric-level reconciliation。
- **C / 仍未完成**：云端发布、云端 API snapshot、线上分类页面确认、双轨业务日对账。

## 4. 本地验证

通过：

```text
node --check app/server.mjs
node --check app/observability.mjs
node --check app/public/app.js
python -m py_compile deploy/deploy-server.py
node app/tests/observability-contract-unit.mjs
node app/tests/deployment-contract-unit.mjs
git diff --check
```

本地 API 启动仍受工作树既有 fixture 缺失影响：`app/data/email-template-library.json` 不存在。未复制生产数据，也未创建业务测试数据。

## 5. 云端只读证据

已知云端基线：

```text
release metadata commit: 80b3bebf0fccc819693973d97b128f93d4c43829
cloud Git HEAD:          95713bc5f9f55f780ed07081a21ce16a2ad71f17
branch:                  production/main
recoveryPhase:           10.2
```

云端 `GET /api/control-plane/status` 尚未返回：

```text
observability
schemaVersion
classifiedMetrics
reconciliation
```

判定：云端仍运行旧版本；本次没有上传或重启。

## 6. 双轨对账状态

本地代码已支持：

```text
rawMetrics
classifiedMetrics
legacyClassificationView
reconciliation
metricReconciliation[draft|approval|outbox|accepted|failed|retry]
```

但尚未取得真实云端 JSON 对账快照，不能宣称 raw/classified 已在生产日对账，也不能宣称 legacy mapping 覆盖全部历史事件。

## 7. 部署后安全复核状态

由于发布在前置检查阶段停止，没有发布后变化。以下状态保持不变：

- managed/pipeline timer inactive；
- delivery 与 quota 未修改，仍为 10/day、batch=1；
- collection lock 未修改；
- queue、pipeline、outbox 未处理、未创建、未删除；
- SMTP 未调用，连接数保持 0；
- runtime/pipeline/outbox hash 未因本次操作变化。

## 8. Pipeline timer 恢复条件

**不满足。** 缺口是：云端未部署 observability；API 没有 schema/classified/reconciliation；本地 API fixture 不完整；双轨对账和 Persistent replay 证据尚未完成。

## 9. 解阻与回滚

1. 恢复已人工核验的 `.codex_work/known_hosts`，不绕过 host key 校验；
2. 补齐隔离 API fixture，完成 schema smoke；
3. 使用既有部署流程和保留 runtime/timer 开关发布；
4. 只读确认云端 release hash、API、页面和 reconciliation；
5. 对账两个业务日后再评估 Pipeline timer 单周期观察。

若发布后异常，停用 classified view、保留 raw audit、保持 timer inactive 并回到 `safe_hold`。禁止删除或重写历史事件。

## 10. 最终判断

Phase 12.3-B **尚未真正成为云端生产系统的一部分**。本地关键写入点已接入，测试通过；正式发布被缺少已核验 SSH host key 阻断，云端 API 仍运行旧版本。

系统继续保持 `safe_hold`，不满足 Pipeline timer 恢复条件。
