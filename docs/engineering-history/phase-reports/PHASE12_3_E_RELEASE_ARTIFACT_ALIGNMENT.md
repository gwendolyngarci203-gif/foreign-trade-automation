# Phase 12.3-E：Release Artifact Alignment

> 只读审计。本阶段未部署、未建立 SSH 会话、未修改 quota/lock/runtime、未恢复 timer、未处理 queue、未创建 job/outbox、未调用 SMTP。

## 1. 最终判断

当前无法形成代码、工作树、manifest、release commit、部署流程五者一致的真实可发布 artifact。原因是本地发布输入不完整，且工作树包含大量未分层改动。

因此本阶段不创建 release commit，不执行 backup/upload/restart，避免把不相关业务变化混入生产发布。

## 2. 当前不一致原因

| 维度 | 当前事实 | 影响 |
|---|---|---|
| Branch | `feature/phase7-production-control-fixes` | 不是 `production/main` |
| Local HEAD | `e3f1c69734438304e36f95be43e9c442ad627284` | 旧恢复基线 |
| Working tree | 多个 app、tools、报告文件未提交 | 无法直接作为纯 observability release |
| Cloud HEAD | `95713bc5f9f55f780ed07081a21ce16a2ad71f17` | 云端仍为旧 Control Plane |
| release.json | commit `80b3bebf...` | 与本地、云端均不一致 |
| Manifest | 缺少 3 个既有文件 | `project_manifest()` 失败 |
| SSH preflight | `.codex_work/known_hosts` 不存在 | 部署器拒绝连接 |

## 3. Release Readiness Matrix

| 检查项 | 结果 | 说明 |
|---|---|---|
| `app/observability.mjs` | PASS | 新增模块存在 |
| observability contract test | PASS | 契约通过 |
| deployment contract test | PASS | 静态接入点通过 |
| server/public syntax | PASS | Node 检查通过 |
| deployment Python syntax | PASS | py_compile 通过 |
| Phase 12.3-B 改动隔离 | BLOCKED | `app/server.mjs` 有 875 行混合改动 |
| manifest 完整 | FAIL | 缺少既有依赖 |
| `.codex_work/known_hosts` | FAIL | 部署器要求路径不存在 |
| release metadata 对齐 | FAIL | commit/branch 不一致 |
| backup 前置 | NOT RUN | 未进入远端阶段 |
| cloud API verification | NOT RUN | 尚未部署 |

## 4. Phase 12.3-B 与无关改动

可识别的 Phase 12.3-B 内容：`app/observability.mjs`、其契约测试、`app/server.mjs` 中 observability 集成、`app/public/app.js` 分类展示和 deployment contract 断言。

不能安全归入纯 release 的内容：`app/server.mjs`、`app/public/*`、`deploy/deploy-server.py` 还包含此前 Phase 9–12 的 Control Plane、quota、delivery、lock 和部署编排改动；`tools/*` 也有历史 browser/collection 修改。当前没有按阶段提交，不能声称这些文件只包含 Phase 12.3-B。

## 5. Manifest 依赖审计

部署器 `PROJECT_FILES` 明确要求但当前缺失：

```text
app/data/email-template-library.json
app/data/managed-history-report.json
deploy/.env.runtime.example
```

前两项属于生产/managed 运行依赖，后一项属于部署配置契约。不能删除 manifest 要求，也不能用生产 secret 或伪造数据替代。在不复制生产数据的前提下，本阶段无法补齐。

## 6. 目标 Release Artifact 组成

真实 artifact 必须包含：纯 Phase 12.3-B commit、完整 manifest 依赖、同步的 `release.json`、已核验 host key、测试证据、保留 timer/quota 的部署路径、发布前 backup 和发布后 API snapshot。当前仅有部分代码和静态测试证据。

## 7. Commit 决策

本阶段未创建 commit。整个 `app/server.mjs` 提交会混入历史 quota、delivery、lock 和 Control Plane 变化；只提交 `observability.mjs` 又遗漏真实 server integration；manifest 不完整也不能形成可发布 artifact。

## 8. Deployment Preflight

已通过：

```text
node --check app/server.mjs
node --check app/observability.mjs
node --check app/public/app.js
python -m py_compile deploy/deploy-server.py
node app/tests/observability-contract-unit.mjs
node app/tests/deployment-contract-unit.mjs
git diff --check
```

`project_manifest()` 预检失败并列出上述三项缺失文件；SSH preflight 要求工作树 `.codex_work/known_hosts`，当前不存在。没有进入 backup、upload 或远端命令阶段。

## 9. 正式部署条件

尚未达到。必须先恢复并核验 manifest 依赖，在干净临时 worktree 分离 Phase 12.3-B，生成纯 observability commit，同步 release metadata，恢复部署器要求路径下的已核验 host key，并重新通过 preflight。

## 10. 安全状态与最终回答

本阶段没有生产变化：timer inactive、quota 未改、collection lock 未改、runtime/queue/pipeline/outbox 未改、SMTP=0。禁止 SSH 绕过、手工 scp、删除 manifest 要求、伪造 fixture、修改历史 raw event 或以不完整 commit 宣称发布完成。

- Release artifact：未形成完整可发布 artifact。
- Commit：未创建，避免混入无关生产变更。
- Manifest：FAIL，缺少 3 个既有依赖。
- 部署前检查：语法/契约 PASS，manifest/SSH BLOCKED。
- 云端生产能力：Phase 12.3-B 仍未进入云端。
