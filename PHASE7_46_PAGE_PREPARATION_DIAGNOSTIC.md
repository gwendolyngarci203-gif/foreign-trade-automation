# PHASE 7.46 Search Page Preparation Isolation Diagnostic

日期：2026-09-05
执行环境：云端 `/opt/dakings-prospect-ops/`
测试方式：云端 `/tmp/phase746-page-prep.mjs` 一次性 Playwright 诊断副本

## 安全边界

本轮未修改生产代码，未连接 queue，未输入公司名，未设置 exact，未点击搜索，未等待 XHR，未读取结果，未运行联系人采集、pipeline 或 SMTP。

## 分阶段结果

### 1. Initial page state

- 开始：`2026-09-05T11:13:05.853Z`
- 结束：`2026-09-05T11:13:05.990Z`
- targetId：`B62C6AA4171870008F480A00413FEBA1`
- URL：`https://waimao.office.163.com/#wmData?page=globalSearch`
- title：网易外贸通页面
- 可见 tabs：3 个，分别为按关键词、按公司、按国家（页面返回文本编码显示异常，但 aria 选择状态显示按公司为 selected）

结论：initial page state 正常，page target 选择未阻塞。

### 2. Close drawer

- `close_drawer_start`：`2026-09-05T11:13:05.991Z`
- 发现可见 `.ant-drawer-close`：1 个
- 执行 close：是，尝试点击第一个按钮
- 结果：未完成
- 错误：Playwright `locator.click` 5 秒超时，元素虽 visible/enabled/stable，但被判定为 `outside of the viewport`

### 3. Company tab locate

未执行。流程在 drawer close 阶段停止。

### 4. Company tab click

未执行。

### 5. Company input locate

未执行。

## 根因定位

本阶段 30 秒问题已进一步缩小：阻塞发生在页面准备的 **drawer close 动作**，不是 connectOverCDP、page 选择、company tab selector、company tab click 或 company input selector。

drawer close 按钮在 DOM 中可见，但 Playwright 点击操作认为其位于 viewport 外。这是页面布局/滚动容器或 overlay 定位问题；不能据此推断网易登录、权限、CAPTCHA、联系人 selector 或 queue 有问题。

## 生产影响

- managed collection 未启动
- pipeline worker 未启动
- 无 queue claim/retry/resume
- 无联系人读取、runtime 写入、outbox 变化或邮件发送
- 页面只发生了一次关闭按钮点击尝试，点击未成功

## 结论与最小后续方向

1. drawer close 是当前明确的第一个阻塞点。
2. company tab/input 尚未被诊断，因为流程按安全要求在 close 失败后停止。
3. 最小修复方向应只针对页面准备：确认 drawer 是否真的需要关闭，并采用可观测的 viewport/overlay 状态处理；不得用强制点击或跳过状态校验掩盖页面状态。
4. 修复后仍需重新执行同样的页面准备隔离诊断，依次证明 close、tab locate、tab click、input locate，再考虑 search/collect 绑定验证。

