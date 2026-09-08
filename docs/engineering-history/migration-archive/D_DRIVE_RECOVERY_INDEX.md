# D 盘恢复索引

扫描范围：`D:\\zcy\\外贸自动化拓客系统`。本索引只记录路径和文件类型，不记录任何密码、token 或密钥内容。

## 关键文件

- `app/`：生产应用、pipeline、联系人、前端和测试代码
- `tools/`：网易采集、登录恢复、handoff、反馈同步工具
- `plans/`：计划配置
- `deploy/`：服务单元、部署脚本、SMTP/IMAP 辅助文件
- `PROJECT_HANDOVER_20260904.md`：项目交接文档
- `历史归档/`：历史资料

## 账号恢复相关

- `服务器后台访问账号.txt`：TXT，服务器访问凭据候选
- `服务器root账号密码.txt`：TXT，root 访问凭据候选
- `.codex_work/ssh-askpass.cmd`：CMD，历史 askpass 调用脚本
- `.codex_work/ssh-askpass.ps1`：PowerShell，历史 askpass 脚本
- `.codex_work/edge-cdp-profile/`：浏览器会话资料，包含登录/令牌类数据库文件
- `tools/netease-login-recovery.mjs`：网易登录恢复工具

## 项目历史资料

- `历史归档/`
- `outputs/`
- `.codex_work/` 下的审计、部署、验证和发布快照
- `PROJECT_HANDOVER_20260904.md`
- `app/README.md`、`deploy/README.md`、`tools/NETEASE_EDGE_CDP.md`

## 可安全归档目录（不删除）

- `.codex_work/`
- `outputs/`
- `tmp/`
- `.playwright-cli/`
- `bundle-parts/`（如存在）

## 不允许进入 GitHub

- `服务器后台访问账号.txt`
- `服务器root账号密码.txt`
- `.codex_work/edge-cdp-profile/`
- `.codex_work/ssh-askpass*`
- 所有 `.env`、token、credential、key、password、passwd 文件
- SMTP/IMAP 实际凭据和邮箱状态文件
- `runtime-data/`、`outbox/`、联系人库存和发送记录
- `*.log`、`*.tar.gz`、`*.bundle` 及 bundle 分片
