# PHASE 7.48 Drawer Guard Minimal Fix Report

日期：2026-09-05

## 执行环境

- 云端目录：`/opt/dakings-prospect-ops/`
- CDP：`127.0.0.1:9224`
- 修改文件：`tools/netease-playwright-search.mjs`
- 云端原文件备份：`/opt/dakings-prospect-ops/deploy/backups/netease-playwright-search-pre-748-20260905-191951.mjs`

## 修改内容

页面准备阶段保留 drawer 关闭逻辑，并在点击前检查 `boundingBox()`：宽高必须大于 0，且与 viewport 存在交集。否则记录 `DRAWER_SKIPPED_HIDDEN_OR_OFFSCREEN` 并继续流程；未使用 force click，也未删除 drawer 处理。

云端 `node --check` 通过。

## Phase 7.46 等价隔离验证

- 网易页面 URL：`https://waimao.office.163.com/#wmData?page=globalSearch`
- viewport：`1050 × 793`
- drawer 数量：6
- close 候选：1
- 关闭动作：跳过 1 个，点击 0 个
- 事件：`DRAWER_SKIPPED_HIDDEN_OR_OFFSCREEN`
- 公司 tab：count 1，visible，已处于选中状态，无需点击
- 公司输入框：count 1，visible，enabled

## 安全边界

本轮未输入公司名，未执行 exact 设置、搜索、联系人采集，未连接或修改 queue、pipeline、runtime-data、outbox、SMTP；未重启服务、修改 profile/session 或 systemd/timer。

## 结论

页面准备阶段已通过 drawer 判断、company tab 定位和 company input 定位。Phase 7.47 的视口外 drawer click timeout 已在最小控制层修正；后续仍需单独授权后才可进行搜索或联系人验证。
