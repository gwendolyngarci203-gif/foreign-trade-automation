# Phase 12.3-G：Development Workspace Consolidation & D Drive Migration

> 文档性质：开发源、发布源与恢复源的一致性审计和迁移方案。
>
> 本阶段只读盘点与方案设计。未删除、覆盖或迁移任何文件，未修改云端 production，未处理 queue/job/outbox，未恢复 timer，未发送 SMTP。

## 1. 最终判断

目标状态应为：`D:\zcy\外贸自动化拓客系统` 作为唯一开发、测试、release 准备和 commit 来源；C 盘 Codex worktree 退出项目生命周期；云端只作为受控部署目标。

当前尚未达到该状态：

- C 盘 worktree 仍是当前 Codex 工作目录，存在大量未提交改动；
- D 盘仓库虽存在，但 `production/main` 工作树也有 133 项变更；
- 云端仍运行旧 Control Plane，release metadata 与 Git HEAD 不一致；
- D 盘包含账号、root 密码、SSH、SMTP、env、浏览器 profile、runtime 等受保护内容，不能用普通复制处理。

因此，本阶段不执行迁移，不创建跨源 commit，不删除 C 盘内容。

## 2. Phase A：三源 Inventory Matrix

| 位置 | 作用 | commit / branch | 未提交 | 风险 |
|---|---|---|---|---|
| `C:\Users\18395\.codex\worktrees\d721\外贸自动化拓客系统` | 当前 Codex worktree | `e3f1c69734438304e36f95be43e9c442ad627284` / `feature/phase7-production-control-fixes` | 大量 app、deploy、tools、报告和临时文件 | 高：来源不唯一、改动未分层 |
| `D:\zcy\外贸自动化拓客系统` | 目标开发仓库 | `33aba8a0250c1c7458c8c80c0b87e58f04a8589e` / `production/main` | 133 项变更；含删除模板/env、历史修改和 protected 目录 | 高：名称像生产分支但工作树不干净 |
| `/opt/dakings-prospect-ops/` | 云端 production | Git HEAD `95713bc5f9f55f780ed07081a21ce16a2ad71f17` / `production/main` | 仅按云端运行态管理 | 高：release metadata 为旧 Control Plane |

云端只读状态：API service active；managed/pipeline timer/service inactive；delivery `auto`、active gate `10/day`、batch `1`；collection lock 仍为 `production_sending_started`；queue leases `0`；active outbox `0`；SMTP active connections `0`。

云端 runtime hashes 未因本次审计改变：

```text
runtime  2622e060ee7d69e790403daa0865e578c64b90584dd426ec7585efb30b795846
pipeline 267f13711e5d99f4aeaa43520dacb2bf94ec698208694d458634a3a51a3378d6
outbox   5692876fc305957ac418e29e03abcffe1e3678f2c7837ef6f0f89dede9f0f3e2
```

## 3. Phase B：D Drive Protection Map

### PROTECTED：不得覆盖、删除或进入 Git

D 盘已发现以下 protected 类别：

- `服务器root账号密码.txt`、`服务器后台访问账号.txt`；
- `deploy/.env.runtime`；
- `deploy/.env.maggie*.auth`、SMTP 授权文件；
- `.codex_work/known_hosts` 与 SSH 相关材料；
- `.codex_work/edge-cdp-profile` 浏览器 profile、Cookies、Session Storage；
- runtime 状态、部署凭据、API/token/key/secret 文件；
- `recovery-vault` 中的恢复材料。

扫描只记录路径和类别，没有读取、输出或修改 secret 内容。迁移前必须为每个 protected 文件建立加密/权限受控 backup，并记录 hash、属主、权限和恢复位置。

### PROJECT：允许进入唯一开发源 Git

- `app/` 源码与非敏感模板；
- `tools/` 工具；
- `deploy/` 脚本、systemd 模板、非 secret 配置示例；
- 单元/集成测试；
- `plans/` 中非敏感业务计划；
- `docs/` 与正式设计文档。

### ARCHIVE：只读归档，不参与发布输入

- `历史归档/`；
- Phase 报告、旧版本报告、旧截图；
- 已废弃脚本、旧 recovery 说明；
- 旧 backup（保留原权限和来源记录）。

### TEMP：禁止迁移到 release

- `.playwright-cli`、`__pycache__`、`.codex_work/python_deps`；
- `node_modules`、构建产物、preview、cache、临时 output；
- 未经分类的临时截图和中间文件。

## 4. Phase C：C 盘迁移分类

### 需要迁移（逐文件审查）

- Phase 12.3-B observability 代码：`app/observability.mjs`、server integration、前端展示、contract test；
- 已确认有效且不含 secret 的工具和测试；
- deploy 模板和 release 文档；
- 经过测试且属于正式项目的报告。

### 需要归档

- Phase 7–12 历史报告；
- 截图、渲染结果、旧 smoke 输出；
- 已完成的 canary 运行记录；
- 不再作为部署输入的旧脚本和 recovery 版本。

### 禁止迁移

- cache、临时目录、`.playwright-cli`、`node_modules`、Python 依赖；
- C 盘重复 worktree 元数据；
- 任何未确认来源的凭据、浏览器 profile、runtime secret；
- 未经 hash/权限核验的 `.env`、SSH、SMTP 文件。

迁移不是覆盖式复制，而是“分类、备份、hash 对照、人工批准、原子导入”。

## 5. Phase D：D 盘标准目录结构

目标结构：

```text
D:\zcy\外贸自动化拓客系统\
├── app\
├── tools\
├── deploy\
├── tests\
├── docs\
├── .security\
│   ├── secrets\
│   ├── ssh\
│   └── env\
├── recovery-vault\
├── archive\
│   ├── phases\
│   ├── old-reports\
│   └── deprecated\
├── release\
└── temp\
```

### 进入 Git

`app/`、`tools/`、非 secret 的 `deploy/`、测试、计划、docs、release manifest 和审计报告。

### 禁止进入 Git

`.security/` 全部内容、`.env.runtime`、SMTP/API/token/key/密码、浏览器 profile、runtime data、recovery secret、backup、cache、temp 和构建产物。`.gitignore` 必须以 deny-by-default 方式覆盖这些目录和文件名模式。

## 6. Phase E：新的唯一 Git 工作流

```text
D:\zcy\外贸自动化拓客系统
        ↓
feature/phase-*
        ↓ tests + manifest + secret scan
release/phase-*
        ↓ deployment preflight + backup plan
production/main
        ↓ existing deploy orchestrator
云端 /opt/dakings-prospect-ops/
```

规则：

1. 所有开发、测试、commit 只在 D 盘；
2. C 盘不执行 commit、部署或 release 准备；
3. 云端不作为开发源，不直接修改；
4. release commit 必须只包含明确范围的代码和非敏感 metadata；
5. production data、runtime、queue、outbox 不能进入普通 Git commit；
6. 部署必须使用既有 deploy orchestrator、host key 校验和 backup 流程。

## 7. Phase F：迁移执行计划（未来实施）

本阶段未执行。真正迁移前必须：

1. 在 D 盘为全仓创建完整 backup，包含文件清单和 hash；
2. 对 C/D 两源生成 `git status`、HEAD、branch、文件 hash 快照；
3. 对 protected 文件建立独立权限受控 backup，确认可恢复；
4. 生成逐文件迁移清单和冲突决策；
5. 在 D 盘新 feature branch 原子导入 PROJECT 文件；
6. 运行语法、contract、secret scan、manifest 和部署 preflight；
7. 对迁移后 hash、权限、secret 存在性和 Git status 复核；
8. 由负责人批准后，才允许生成 release branch/commit；
9. 迁移完成后，C 盘只保留只读归档，不删除原 worktree，直到 rollback 窗口结束。

## 8. 风险与回滚

| 风险 | 等级 | 控制 |
|---|---|---|
| 覆盖 D 盘凭据或 profile | 极高 | protected 清单、独立 backup、禁止自动复制 |
| 混入历史业务改动 | 高 | 逐文件分类、干净 feature branch |
| D 盘 production/main dirty | 高 | 先冻结，禁止直接 commit |
| C/D 版本漂移 | 高 | hash matrix、唯一 D 源规则 |
| manifest 缺失 | 高 | 先补齐来源并验证，不删除要求 |
| 云端与 release metadata 不一致 | 高 | 发布后 API/release snapshot |
| 回滚破坏 runtime | 极高 | 只回滚代码 release，不回写 runtime data |

回滚原则：迁移失败时恢复 D 盘 backup；C 盘原 worktree 保持不动；不使用 reset/rebase/force push；不覆盖 protected 文件；不修改云端 production。

## 9. 当前应保持的安全状态

- C/D 均不执行 production deploy；
- 云端 managed/pipeline timer 继续 inactive；
- delivery quota、collection lock、runtime、queue、pipeline、outbox 不变；
- SMTP 不调用；
- D 盘凭据、SSH、SMTP、profile、runtime 和 recovery 材料不迁移、不覆盖。

## 10. 最终回答

当前还没有建立唯一可信开发源。D 盘具备成为唯一源的仓库基础，但其工作树仍 dirty，且包含大量 protected 和历史内容；C 盘也不能直接复制进 D 盘。

最小安全落地步骤：

1. 先对 D 盘 protected 文件和整个仓库做备份/hash；
2. 在 D 盘创建干净 feature branch；
3. 逐文件导入已确认的 PROJECT 内容，单独归档历史/临时内容；
4. 完成 manifest、secret scan、contract test 和版本对账；
5. 由 D 盘生成唯一 release commit；
6. 后续所有开发、测试、发布只使用 D 盘；
7. C 盘仅保留只读归档，待 rollback 窗口结束后再由负责人决定处置。

本报告生成期间未删除、覆盖或迁移任何文件，未修改云端 production。
