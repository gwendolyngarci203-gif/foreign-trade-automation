# 项目当前状态交接文档

## 一、项目总体状态

- 项目名称：外贸自动化拓客系统
- 当前目标：网易外贸通无人值守外贸客户开发循环系统
- 当前阶段：Phase 8.0 灰度验证前

## 二、生产基线状态

- 云端路径：`/opt/dakings-prospect-ops/`
- 记录的生产基线 commit：`e87721dcf07380ace6eed68afefe335c6caeaa25`
- 状态：云端已初始化 Git，Production Baseline 已固化

已记录能力：

- Phase 7.2-A：Country+Business discovery
- Phase 7.2-B：联系人周期恢复、company checkpoint、queue resume
- Phase 7.2-C：Account Capacity Layer、发送容量统一控制

## 三、代码一致性状态

- 云端记录：`e87721d`
- 本地 D 盘：`33aba8a`
- Codex worktree：`33aba8a`

已确认以下核心文件 hash 一致：

- `app/server.mjs`
- `app/pipeline-worker.mjs`
- `app/contact-collection.mjs`
- `tools/run-managed-hscode-plan.mjs`
- `tools/handoff-managed-pipeline.py`
- `tools/netease-cdp-client.mjs`
- `tools/netease-country-business-discovery.mjs`

结论：核心生产业务代码未发现分叉。云端 commit 与本地 commit 的 Git 对象一致性仍需在 SSH 恢复后重新核验。

## 四、不要破坏的成果

禁止删除生产代码目录：

- `app/`
- `tools/`
- `deploy/`

禁止修改或覆盖：

- `runtime-data`
- `outbox`
- 联系人库存
- mailbox 状态
- SMTP 配置
- IMAP 配置
- `.env`
- 生产身份配置

禁止引入：

- 新的 collector 体系
- 新的 inventory 体系
- 新的 task-worker 生产入口

## 五、当前服务状态

最近一次云端只读核验记录：

- `dakings-prospect-ops.service`：active
- `dakings-pipeline-worker.service`：inactive/oneshot 正常退出
- `dakings-managed-collection.service`：failed

托管采集失败日志显示网易 session 遇到 credential/CAPTCHA/permission/MFA gate。该记录不能证明问题已恢复，也不能在 SSH 恢复前重新验证。

## 六、当前阻塞问题

主要阻塞：SSH 访问恢复。

- 服务器：`39.106.182.40`
- 用户：`dakings`
- 最近尝试结果：`Authentication failed`

恢复线索：

- `C:\Users\18395\.codex\ssh-askpass-dakings.cmd`
- `C:\Users\18395\.ssh\known_hosts`
- `D:\zcy\外贸自动化拓客系统\服务器后台访问账号.txt`
- `D:\zcy\employee supervision\阿里云服务器.txt`

目前未确认密码有效性，未尝试猜测或绕过认证。

## 七、凭据恢复策略

优先顺序：

1. 只读检查历史 SSH key
2. 检查 askpass 脚本及其引用
3. 检查 SSH config
4. 核对云厂商控制台中的访问凭据

禁止：

- 猜密码
- 修改服务器 SSH 配置
- 重置服务器
- 在聊天或 Git 中写入明文凭据

如果本地线索无法恢复，最后方案是通过云厂商控制台恢复访问。

## 八、版本管理规则

- 唯一生产来源：`production/main`
- 开发分支：`develop`
- 功能分支：`feature/*`

禁止直接修改云端代码。

部署流程：

`本地 commit → 测试 → 生成 hash → 部署 → 云端 hash 验证`

## 九、下一步行动计划

1. 恢复 SSH 访问。
2. 只读验证云端 Git 状态、分支和 commit。
3. 建立或确认 Git remote。
4. 统一 D 盘与 Codex 开发环境。
5. 在人工确认网易登录状态后恢复 managed collection。
6. 再进入 Phase 8 灰度：最多 20 家公司、50 个联系人、50 封邮件以内；发送前必须经过人工 approval。

## 十、冻结声明

本交接文档生成时：

- 未修改业务代码
- 未执行 Git 同步或重置
- 未部署
- 未重启服务
- 未采集
- 未发送邮件
