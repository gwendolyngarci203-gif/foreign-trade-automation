# PHASE 7.47 Drawer State Decision Diagnostic

日期：2026-09-05
执行环境：云端 `/opt/dakings-prospect-ops/`
测试方式：一次性 `/tmp/phase747-drawer-state.mjs`

## 安全边界

本轮只读取页面 DOM、样式和几何信息。没有关闭 drawer，没有输入公司名，没有设置 exact，没有点击搜索，没有连接 queue/contact/pipeline，也没有修改生产代码、runtime、profile 或 session。

## Initial page

- URL：`https://waimao.office.163.com/#wmData?page=globalSearch`
- viewport：`1050 × 793`
- page target：生产网易全球搜索页

## Drawer 状态

页面共有 6 个 `.ant-drawer` 容器：

- drawer 0：DOM/样式存在，计算为 visible，但宽度为 `0`，位置 `x=0`；没有 close 按钮。
- drawer 1：DOM/样式存在，计算为 visible，但宽度为 `0`，位置 `x=1050`，`z-index=10`；close 按钮 bounding box 为 `x=1835, y=0, width=72, height=57`，完全位于 viewport 外。
- drawer 2-5：不可见，宽高为 0。

可见输入框区域为 `x=281, y=159, width=598.98, height=32`。所有 drawer 与该输入框的几何 overlap 均为 `false`。

## 搜索输入框

选择器：`input[placeholder="请输入公司名称"]`

- DOM count：3
- 可见 count：1
- 可见输入框：`visible=true`、`enabled=true`
- bounding box：`x=281, y=159, width=598.98, height=32`

## 判断

结论为 **B：drawer 只是残留/隐藏 DOM，不影响搜索**。

阻塞不是 drawer 覆盖搜索区域，而是现有逻辑对 `.ant-drawer-close:visible` 的几何判断过于宽松：Playwright 将位于 viewport 外的 close 按钮视为 locator visible，但实际 click 无法执行，导致 5 秒超时。

## 最小修复建议

1. 保留关闭逻辑，但只处理 bounding box 与 viewport 有实际交集、且宽高大于 0 的 close 按钮；这是首选。
2. 若没有满足条件的按钮，直接跳过 drawer close，不应阻断搜索。
3. 不建议删除所有关闭逻辑，因为真实打开的详情 drawer 仍可能遮挡搜索；也不应使用强制点击掩盖 viewport 状态。

## 结论

- drawer 实际阻塞搜索：否。
- 搜索输入框可用：是。
- 当前最小修复：收紧 drawer close 的几何/viewport 判断，或在无实际可见 drawer 时跳过关闭。
- 本轮未执行任何生产搜索或联系人动作。

