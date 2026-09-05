# PHASE 7.44 Bound Contact Entry Validation

日期：2026-09-05
执行环境：云端 `/opt/dakings-prospect-ops/`
测试范围：一次隔离的单公司搜索；未连接 production queue。

## 安全边界

- 未恢复旧 queue/task，未调用 claim、retry、resume 或 complete。
- 未调用 `collect-current-visible` 的联系人读取阶段。
- 未打开联系人详情、未读取或提取真实联系人。
- 未启动 managed collection、pipeline、draft、outbox 或 SMTP。
- managed collection 与 pipeline worker 保持 `inactive`。
- 未修改代码、runtime、queue、profile 或 session。

## 执行结果

使用云端现有 `tools/netease-playwright-search.mjs` 对 `Allnote Printing Ltd.` 执行一次搜索。命令在 30 秒内未返回结构化 search 状态对象，随后停止等待，没有重试。

结果分类：`SEARCH_CANARY_EXECUTION_TIMEOUT`

由于没有返回 search 对象，以下字段均无法安全确认：

- `targetId`
- `query`
- `exact`
- `resultSignature`
- `timestamp`
- 搜索结果公司名

这不是 queue 的 `control_error`，也没有证据表明是网易 credential、CAPTCHA 或权限错误。

## 只读收尾检查

- 云端 CDP `/json/list` 仍可访问；生产 page target 为 `B62C6AA4171870008F480A00413FEBA1`，URL 为网易外贸通全球搜索页。
- 未发现残留 `netease-playwright-search`、`phase744` 或联系人 runner 进程。
- managed collection 与 pipeline worker 均为 `inactive`。

## 必答结论

1. target 绑定是否生效：本轮未取得 search 返回对象，无法验证；代码路径已支持绑定 target，但缺少运行时证据。
2. Phase 7.40 的 SEARCH_STATE 问题是否消失：无法确认。没有进入 collect，也没有得到前后状态比较。
3. 联系人入口是否可读取：未测试，避免打开联系人详情或读取真实联系人。
4. 下一步是否可以进入真正单公司联系人采集：不可以。必须先获得一次完整的 search 绑定对象，并完成只读 preflight（同 target、query、exact、resultSignature 和联系人入口可见性）后才能放行。

## 最小后续动作

不重试生产 queue。下一步应改进现有搜索入口的分阶段诊断输出（连接、target 选择、输入、exact、XHR 等待、结果读取），然后在不写 queue 的隔离上下文中重新验证；联系人采集仍保持停止。

