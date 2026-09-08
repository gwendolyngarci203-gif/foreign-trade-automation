# Final Server Hunk Approval

## APPROVE（隔离分支）

- `buildApprovalAdapterResult` import。
- pipeline action matcher 增加 `auto-approve`。
- confirmation/mode/stage 校验。
- 读取 drafting artifact，调用 adapter。
- 写入 adapter audit 并复用现有 approval 状态转换。

## REJECT

- auto-prepare-outbox、SMTP、quota、timer、lock、runtime、queue lease、systemd、自动 delivery 的任何 hunk。

## 证据

当前 `git diff -- app/server.mjs` 仅包含上述 import、route matcher 和 adapter 分支；禁止项扫描无命中。该修改只存在于隔离分支，`production/main` 未改、未部署。
