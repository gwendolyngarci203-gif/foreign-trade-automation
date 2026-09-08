# Phase 12.3-H：C/D Source Synchronization

> 文档性质：C 盘开发进度安全同步到 D 盘的审计与迁移方案。
>
> 本阶段仅完成只读盘点和设计。未复制目录、未覆盖 D 盘、未删除 C 盘、未执行 reset/rebase/force push，未修改云端 production。

## 1. 最终判断

安全目标不是舍弃 C 盘，也不是把 D 盘当前状态强行作为新起点，而是：

1. 保护 D 盘已有生产资产；
2. 逐文件识别 C 盘有效开发进度；
3. 在 D 盘建立隔离的 `migration/phase12-sync` 工作区和 feature branch；
4. 通过 hash、测试和 review 后合并到 D 盘；
5. 最终让 D 盘成为唯一开发、测试、commit 和 release 来源；
6. C 盘只保留只读历史备份。

## 2. SOURCE_DIFF_MATRIX

### 2.1 仓库级状态

| 位置 | HEAD | branch | 工作树 | 结论 |
|---|---|---|---:|---|
| C：`C:\Users\18395\.codex\worktrees\d721\外贸自动化拓客系统` | `e3f1c69734438304e36f95be43e9c442ad627284` | `feature/phase7-production-control-fixes` | 大量未提交改动 | 包含最新 Phase 9–12 开发进度，不得丢弃 |
| D：`D:\zcy\外贸自动化拓客系统` | `33aba8a0250c1c7458c8c80c0b87e58f04a8589e` | `production/main` | 133 项变更 | 已有生产资产和历史改动，不得覆盖 |

排除 `.git`、`.codex_work`、`.playwright-cli`、outputs、tmp、node_modules 后的文件级初步对比：C 约 296 个文件，D 约 184 个文件，共同约 110 个；C 独有约 186 个，D 独有约 74 个，共同文件中约 31 个大小不同。该统计用于风险排序，不替代逐文件 hash 对账。

### 2.2 C 盘独有有效进度

| 范畴 | C 盘内容 | 价值 |
|---|---|---|
| Browser Control | `BROWSER_RECOVERY_RUNBOOK.md`、health/recovery 报告和相关工具 | 高，记录 browser health gate 与恢复流程 |
| Phase 11 | golden path、draft、approval、recipient evidence 报告 | 高，保留验证证据 |
| Phase 12 | auto approval、delivery、observability 报告 | 高，支持当前生产策略 |
| Observability code | `app/observability.mjs`、contract test | 高，属于待同步的最新代码 |
| Control Plane | `app/server.mjs`、`app/public/*` 的未提交改动 | 高，但与历史 quota/delivery/lock 改动混合，必须拆分 review |
| Release metadata | C 盘 `deploy/release.json` | 需审计，不能直接覆盖 D 盘 metadata |

### 2.3 D 盘已有生产资产

D 盘存在 `app/`、`deploy/`、`tools/`、`plans/`、`outputs/`、`历史归档/`、`recovery-vault` 等目录，并有自己的 `production/main` 工作树。D 盘已发现账号文件、`.env.runtime`、SMTP 授权文件、`.codex_work/known_hosts`、浏览器 profile、runtime 文件和 recovery 材料；这些均不得由 C 盘复制覆盖。

## 3. C_ONLY_VALUABLE_CHANGES

### 必须进入 D 盘 Git 的候选

- `app/observability.mjs`；
- `app/tests/observability-contract-unit.mjs`；
- 已审查的 `app/server.mjs` observability 集成 hunk；
- 已审查的 `app/public/app.js` 分类指标展示 hunk；
- deployment contract 中与 observability 直接相关的断言；
- Phase 11–12 正式报告和 runbook（进入 docs/archive，不进入运行时 manifest）。

### 不能直接导入

- C 盘 `app/server.mjs` 中无法与 quota、timer、lock、runtime 变化分离的 hunk；
- `.env`、SMTP、API key、SSH、browser profile、runtime data；
- `.playwright-cli`、cache、node_modules、Python 依赖、output 中间产物；
- 未确认来源的临时脚本和截图。

## 4. D_PROTECTED_ASSET_MAP

| 资产类别 | D 盘示例 | 处理策略 |
|---|---|---|
| 账号/密码 | `服务器root账号密码.txt`、`服务器后台访问账号.txt` | 原位置保留；单独权限受控备份；不进 Git |
| 环境/SMTP | `deploy/.env.runtime`、`deploy/.env.maggie*.auth` | 原位置保留；只同步 hash/变量关系，不复制值 |
| SSH | `.codex_work/known_hosts`、SSH 配置 | 原位置保留；人工核验后使用 |
| Browser | `.codex_work/edge-cdp-profile` | 不复制、不删除、不重建 |
| Runtime | runtime-state、pipeline/outbox 等运行态 | 不迁移、不改写、不进普通 commit |
| Recovery | `recovery-vault`、历史 backup | 只读保护，独立备份和恢复演练 |

保护扫描只记录路径、类别、大小和存在性；禁止读取或输出 secret 内容。

## 5. 分类同步策略

```text
C 盘逐文件审计
        ↓
PROJECT / ARCHIVE / PROTECTED / TEMP
        ↓
D:\...\migration\phase12-sync
        ↓
feature/phase12-sync
        ↓ tests + hash + review
release/phase12-sync
        ↓
D:\...\production/main
```

- **PROJECT**：有效源码、非敏感工具、测试、配置模板、正式 docs，进入 D 盘 Git；
- **ARCHIVE**：历史 Phase 报告、旧截图、旧 backup、deprecated 脚本，进入 D 盘 archive，只读；
- **PROTECTED**：D 盘原位置保留，只同步 hash、依赖关系和恢复说明；
- **TEMP**：不迁移，待负责人批准后清理，不能进入 release。

禁止整目录复制。每个文件必须记录来源路径、目标路径、原 hash、目标 hash、分类、审查人和冲突决策。

## 6. D 盘合并方案

### 6.1 隔离区

在 D 盘建立：

```text
D:\zcy\外贸自动化拓客系统\migration\phase12-sync\
```

该目录用于临时比对、patch、hash manifest 和 review 记录，不作为运行时目录，不含 secret。

### 6.2 合并步骤

1. 对 D 盘全仓和 protected asset 做 backup/hash；
2. 在 D 盘创建 `feature/phase12-sync`，不触碰 `production/main`；
3. 从 C 盘导入 PROJECT 文件或经过审查的最小 patch；
4. 对冲突文件逐 hunk review，尤其是 `app/server.mjs`、`app/public/*`、`deploy/*`；
5. 运行 syntax、unit、contract、secret scan、manifest preflight；
6. 比较 runtime/queue/pipeline/outbox 文件未被导入；
7. review 通过后创建 release branch 和 commit；
8. 只有 D 盘 release commit 与 manifest 完全一致后，才可使用正式 deploy 流程。

## 7. 冲突文件与优先级

| 文件范围 | 冲突风险 | 处理 |
|---|---|---|
| `app/server.mjs` | 极高，C/D 均含大规模业务改动 | 禁止整文件覆盖，按功能 hunk 拆分 |
| `app/public/app.js/index.html/styles.css` | 高，Control Plane 与旧页面可能并存 | 保留 D 盘现有受保护配置，逐段合并 |
| `deploy/deploy-server.py` | 高，部署开关和生产流程敏感 | 仅合并安全 preflight 改动，单独 review |
| `app/tests/deployment-contract-unit.mjs` | 中 | 合并测试断言，运行完整测试 |
| `tools/*` | 中高，browser/collection 逻辑历史漂移 | 只导入确认属于 Phase 11–12 的文件 |
| `deploy/release.json` | 高 | 由最终 D 盘 release commit 重新生成，不从 C 盘直接复制 |
| docs/reports | 低 | 归档到 archive/docs，不进入生产 manifest |

## 8. D 盘最终标准结构

```text
D:\zcy\外贸自动化拓客系统\
├── app\
├── tools\
├── deploy\
├── tests\
├── docs\
├── .security\{secrets,ssh,env}\
├── recovery-vault\
├── archive\{phases,old-reports,deprecated}\
├── migration\phase12-sync\
├── release\
└── temp\
```

Git 只收录源码、非敏感模板、测试、部署模板、计划和文档。`.security`、env、SMTP/API/SSH、browser profile、runtime、recovery secret、backup、cache、temp、build output 全部排除。

## 9. 回滚方案

- 同步前：保留 C/D 双方原始 hash 和 backup；
- 合并失败：删除 D 盘 feature branch 和 migration 临时 patch，不触碰 `production/main`；
- 发现 protected 文件变化：立即停止，使用 D 盘 backup 恢复，保留审计；
- 测试失败：不生成 release commit，不部署云端；
- 发布后异常：只回退代码 release，保持 D 盘 runtime/queue/pipeline/outbox 不变；
- rollback 窗口结束前，C 盘 worktree 不删除，仅改为只读历史备份。

禁止 `git reset --hard`、rebase、force push、整目录覆盖和直接修改云端 production。

## 10. 唯一工作流

```text
D 盘 feature/phase12-sync
        ↓
测试、hash、secret scan、review
        ↓
D 盘 release branch
        ↓
production/main
        ↓
既有 deploy orchestrator
        ↓
云端 /opt/dakings-prospect-ops/
```

C 盘从迁移完成后不再执行开发、测试、commit 或部署，仅保留只读历史备份。云端不作为开发源，不直接修改。

## 11. 最终回答

在不丢失 C 盘最新进度的前提下，安全迁移的关键是“逐文件分类 + D 盘隔离 branch + protected 原位保留 + hash/测试对账”，而不是复制整个目录。

当前尚未执行迁移，因为 D 盘已有 133 项变更和 protected 资产，C 盘也有大量未提交改动。完成上述备份、拆分、review 和一致性验证后，D 盘才能成为唯一可信开发源；在此之前，C/D 均不得作为未经审查的生产发布来源。
