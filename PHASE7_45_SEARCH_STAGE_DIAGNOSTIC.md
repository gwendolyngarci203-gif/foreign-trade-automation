# PHASE 7.45 Search Stage Diagnostic

日期：2026-09-05
执行环境：云端 `/opt/dakings-prospect-ops/`
测试输入：`Allnote Printing Ltd.`

## 安全边界

使用的是云端 `/tmp/phase745-search-stage.mjs` 一次性诊断副本，未修改项目脚本。未连接 production queue，未调用联系人采集、pipeline、handoff、draft、outbox 或 SMTP。managed collection 与 pipeline worker 保持 `inactive`。临时副本和日志均不属于项目 Git。

## 阶段日志

| 阶段 | 结果 |
|---|---|
| `connectOverCDP` 开始 | `2026-09-05T11:05:36.789Z` |
| `connectOverCDP` 结束 | `2026-09-05T11:05:36.999Z`，约 210 ms |
| page 选择开始 | `2026-09-05T11:05:36.999Z` |
| page 选择结束 | `2026-09-05T11:05:37.024Z`，约 25 ms |
| 输入开始/结束 | 未到达 |
| exact 设置开始/结束 | 未到达 |
| click 开始/结束 | 未到达 |
| XHR 等待开始/结束 | 未到达 |
| DOM 等待开始/结束 | 未到达 |
| resultSignature 开始/结束 | 未到达 |

随后在 20 秒硬超时内无更多输出，最终分类：`SEARCH_STAGE_TIMEOUT`，具体阶段为 **page 选择完成后的页面准备/控件定位阶段**，早于输入公司名。该阶段包含关闭旧 drawer、确认/切换“按公司” tab，以及等待可见公司输入框；现有标记尚未细分其中哪个调用阻塞。

## 当前云端页面证据

- CDP endpoint：`http://127.0.0.1:9224`
- page target：`B62C6AA4171870008F480A00413FEBA1`
- URL：`https://waimao.office.163.com/#wmData?page=globalSearch`
- `/json/list` 可访问
- 运行结束后无残留 `phase745` 或 Playwright 搜索进程
- managed collection、pipeline worker：`inactive`

## 结论

1. 30 秒 timeout 真实发生位置：不是 `connectOverCDP`、XHR、DOM 结果等待或 `resultSignature`；已缩小到 page 选择后的页面准备/控件定位阶段，且尚未进入输入或 exact 设置。
2. 本轮不能证明 production search 请求失败，也不能证明 Phase 7.43 的 target binding 失败；搜索尚未返回绑定对象。
3. 当前最小诊断方向：把页面准备阶段拆成独立标记（drawer close、company tab locate/click、company input wait），仍保持一次性副本，不触碰 queue。
4. 在该阶段可稳定返回前，不应进入联系人采集或恢复旧任务。

## 生产影响

本轮无生产数据副作用：没有 queue lease、联系人写入、pipeline job、runtime、outbox 或邮件发送变化；没有修改生产代码、服务配置、浏览器 profile 或 session。

