# PHASE 7.43 Search-Collect Target State Binding Report

日期：2026-09-05
范围：网易搜索与 `collect-current-visible` 控制层

## 修改文件

- `tools/netease-playwright-search.mjs`
  - 搜索成功返回 `targetId`、`query`、`exact`、`resultSignature`、`timestamp`。
  - 搜索后对输入值、精确模式、渲染结果和 target 进行显式校验。
- `tools/netease-cdp-client.mjs`
  - `collect-current-visible` 支持 `--target-id` 和 `--result-signature`。
  - 传入绑定 target 时优先使用该 target，不再默认切换到最高 score 页面。
  - collect 前验证 target、query、exact 和 result signature。
- `tools/run-netease-contact-queue.mjs`
  - 将搜索返回的绑定状态传递给 collect。
  - 保留结构化错误码，并识别 CDP Runtime 超时。

## 结构化错误

控制层现在区分：

- `SEARCH_STATE_MISMATCH`
- `TARGET_CHANGED`
- `EXACT_MODE_LOST`
- `RESULT_NOT_READY`
- `CDP_RUNTIME_TIMEOUT`

原有 queue signal/status 状态机未扩展；错误码保留在 runner 的 `status` 和 `error` 中，避免把业务生命周期与诊断分类耦合。

## 生产生命周期影响

无。未修改 queue 状态机、contact supervisor 的业务决策、pipeline、SMTP、runtime schema、systemd 或 timer。未恢复旧 queue，未 retry/resume，未启动联系人采集或 pipeline。

## 验证

- `node --check tools/netease-playwright-search.mjs`：通过
- `node --check tools/netease-cdp-client.mjs`：通过
- `node --check tools/run-netease-contact-queue.mjs`：通过
- `git diff --check`：通过
- 生产隔离运行：未执行，因本阶段明确禁止联系人采集和旧 queue 操作。

修改已同步到云端 `/opt/dakings-prospect-ops/`；三个原文件均已先复制到 `deploy/backups/*-pre-phase743-20260905-174600.mjs`，云端三份 `node --check` 均通过。两个业务服务保持 `inactive`，未执行重启。

因此，本轮已验证代码语法和参数传递路径，但尚未宣称生产联系人链路已恢复。

## 对 Phase 7.40 错误来源的判断

修复直接覆盖了已定位的竞态面：search 结果状态现在携带 target 和签名，collect 优先复用并验证同一状态；输入值或 exact 丢失时不再产生含糊的 “result does not belong” 文本，而会给出结构化原因。

这解决了错误分类和 target 重选问题的控制层缺口，但只有在后续受控、无副作用的单公司验证中观察到绑定状态一致且联系人入口可读后，才能确认 Phase 7.40 的实际运行故障已消除。

## 下一步

在恢复任何 queue 前，安排一次独立的单公司控制层验证：执行搜索，记录返回的绑定对象，再只调用 `collect-current-visible` 的前置状态检查；若返回 `TARGET_CHANGED`、`SEARCH_STATE_MISMATCH` 或 `EXACT_MODE_LOST`，停止并保留证据，不重试生产任务。
