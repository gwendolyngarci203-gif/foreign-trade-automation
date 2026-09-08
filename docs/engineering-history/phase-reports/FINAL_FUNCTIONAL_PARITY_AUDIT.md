# Final Functional Parity Audit

| 能力 | C 能力 | D 能力 | 差异 | 用户功能影响 | 已恢复 |
|---|---|---|---|---|---|
| Collection | browser/collection、queue | collection + queue + safety gates | C 有额外运行探针 | 无核心影响 | 是 |
| Contact | 提取、验证、抑制 | 同等 stores/APIs | 无关键差异 | 无 | 是 |
| Discovery | HSCode/keyword/country-business | 同等 manifests | 无关键差异 | 无 | 是 |
| Pipeline | job、claim、stage、artifact | 同等 + D envelope | 无负向差异 | 无 | 是 |
| Validation | draft/evidence quality gates | 同等 + pure evaluator | 无 | 无 | 是 |
| Draft | drafting artifacts | 同等 | trace 已覆盖 | 无 | 是 |
| Approval | manual + auto route | manual + adapter auto route（隔离分支） | 需最终发布审查 | 暂无；未部署 | 部分/待冻结 |
| Outbox | preparation/transition | 同等且受 gate 保护 | C auto-prepare 不恢复 | 无；自动副作用被拒绝 | 是 |
| Delivery | SMTP、quota、circuit | 同等 D 安全实现 | C 混合自动路径排除 | 无；仍需显式发送 | 是 |
| Feedback | feedback、suppression、recovery | 同等 + envelope | 只读分类需持续对账 | 无 | 是 |
| Control Plane | 分类展示 + 运行探针 | 只读分类/observability 基础 | C systemd 控制块不恢复 | 仅影响运维展示完整度 | 部分 |

结论：D 已覆盖有效业务阶段；“完全替代 C+D”仍需 Control Plane 最终字段对账和 approval route release review，不能宣称已完成。
