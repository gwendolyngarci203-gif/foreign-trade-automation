# Final Control Plane Readonly Verification

| 区域 | 期望 | 验证结论 |
|---|---|---|
| Production | draft/approved/outbox/sent/failed，排除 canary/test/recovery | schema 已定义；API/UI 最终快照待运行环境 |
| Canary/Test | canary/sandbox/test quota，不进入 production KPI | classified metrics/legacy mapping 已定义 |
| Recovery | retry/recovered/intervention | classified metrics/审计来源已定义 |
| Observability | schemaVersion、classification、trace、raw/classified reconciliation，只读 | contract test PASS |

禁止写操作：Control Plane fixture 仅检查响应结构，不创建业务数据、不改历史 raw event、不控制 systemd/runtime。

限制：本阶段未启动 API，因此无法提供云端或 live UI snapshot；该项是发布前验证条件，不得标记为已上线。
