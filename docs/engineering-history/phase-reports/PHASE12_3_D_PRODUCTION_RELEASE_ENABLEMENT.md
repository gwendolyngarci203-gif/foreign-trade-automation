# Phase 12.3-D：Production Release Enablement

> 只读安全边界：未恢复 timer，未修改 quota、collection lock、runtime、queue、pipeline、outbox 或历史 raw event，未调用 SMTP。

## 1. 最终判断

Phase 12.3-B 尚未完成云端发布，因此尚未成为云端生产系统的一部分。既有部署流程在本地安全前置阶段停止：工作树缺少已核验 `.codex_work/known_hosts`，随后 manifest 检查确认缺少既有文件 `app/data/email-template-library.json`、`app/data/managed-history-report.json` 和 `deploy/.env.runtime.example`。

没有绕过 host key 或 manifest 校验，也没有使用手工 scp 覆盖生产文件。

## 2. Release Checklist

部署必须存在：`.codex_work/known_hosts`、仅本机读取的凭据、完整 `PROJECT_FILES` manifest、`deploy/release.json`、backup/restore/healthcheck 脚本、systemd/Nginx 配置和既有模板 fixture。

部署必须通过：本地语法与契约测试、manifest 完整性、SSH host identity、云端权限、发布前 runtime backup、发布后 API health/release snapshot，以及 timer/quota/lock/queue/pipeline/outbox/SMTP 安全复核。

## 3. SSH Verification

已核验来源为用户级 `C:\Users\18395\.ssh\known_hosts`。目标 `39.106.182.40` 的 ED25519、RSA、ECDSA keys 均能通过 `ssh-keygen -F` 找到，并与 `ssh-keyscan` 结果匹配。

部署器要求工作树路径 `.codex_work/known_hosts`，该路径当前不存在。未关闭 `RejectPolicy`，未接受未知 host key，未创建不确定内容的副本。

## 4. Before-Release Snapshot

本地：HEAD `e3f1c69734438304e36f95be43e9c442ad627284`，branch `feature/phase7-production-control-fixes`；工作树存在大量未提交改动，不能误报为正式新 release。

云端：`/opt/dakings-prospect-ops/`，release metadata commit `80b3bebf0fccc819693973d97b128f93d4c43829`，Git HEAD `95713bc5f9f55f780ed07081a21ce16a2ad71f17`，branch `production/main`，recoveryPhase `10.2`。

已知云端状态：managed/pipeline timer inactive、delivery gate 10/day batch=1、collection lock 生效、active outbox=0、queue lease=0、SMTP=0。

## 5. 正式部署结果

使用既有 `deploy/deploy-server.py`，并设置 `DAKINGS_PRESERVE_RUNTIME=1`、`DAKINGS_PRESERVE_TIMERS=1` 以避免本阶段修改 quota 或启用 timer。流程因缺少 `.codex_work/known_hosts` 停止；manifest 随后确认三项既有 fixture 缺失。

SSH、backup、上传、service restart、release 更新均未执行，生产数据无变化。

## 6. 云端 API 与 Control Plane

由于未发布，云端 `GET /api/control-plane/status` 仍未返回 `observability`、`schemaVersion`、`classifiedMetrics`、`reconciliation`。Production、Canary/Test、Recovery、Raw 分类页面尚未完成线上验证。

## 7. 安全复核

本阶段未引起状态变化：两个 timer inactive；delivery/quota 未改变；collection lock 未改变；queue/pipeline/outbox 未处理或创建；SMTP=0；历史 raw event 未修改。

## 8. Pipeline Timer 条件

不满足。必须先恢复人工核验的 host key、补齐 manifest fixture、完成隔离 API schema smoke，随后通过正式 backup/deploy/release/API 验证、Control Plane 页面确认、双轨对账和 Persistent replay 审计。

## 9. 回滚与禁止事项

发布后若 schema/API 异常，回到上一 release、隐藏 classified view、保留 raw audit 并保持 timer inactive。禁止绕过 host key、手工覆盖生产文件、修改 quota/lock/runtime、处理库存、创建 job/outbox 或发送 SMTP。

## 10. 必答项

- **A 部署是否完成：** 否，停止于安全前置校验。
- **B 云端 commit：** 仍为 `95713bc5f9f55f780ed07081a21ce16a2ad71f17`，无本阶段新 commit。
- **C API snapshot：** 四个 observability 字段均 absent。
- **D Control Plane：** 新分类模块未在线验证，云端仍是旧 Control Plane。
- **E Pipeline timer：** 前置条件不满足，系统继续 `safe_hold`。
