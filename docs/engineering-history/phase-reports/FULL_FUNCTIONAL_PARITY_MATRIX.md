# Full Functional Parity Matrix

| 能力 | C 存在能力 | D 存在能力 | 差异 | 是否恢复 |
|---|---|---|---|---|
| Collection | 采集、队列、锁 | 采集、队列、锁 | C 有额外控制面探针 | 否，保留 D 边界 |
| Contact | 联系人提取/验证 | 联系人提取/验证 | 无关键差异 | 否 |
| Discovery | keyword/country/HSCode | 同等 collection manifests | 无关键差异 | 否 |
| Pipeline | job、claim、stage、artifact | 同等 | C 增加 envelope | 已由 D 覆盖 |
| Validation | draft quality/evidence gates | 同等 | 无关键缺口 | 否 |
| Draft | drafting artifact | 同等 | trace 继承已存在 | 否 |
| Approval | manual + auto decision/route | decision + manual，adapter route 已接入本隔离分支 | 需后续只读验证 | 是，最小 adapter |
| Outbox | prepare/transition | 同等且受门控 | C auto-prepare 不恢复 | 否 |
| Delivery | SMTP、quota、circuit | 同等 | C 自动路径被排除 | 否 |
| Feedback | feedback/suppression/recovery | 同等 | 分类字段需持续对账 | 否 |
| Control Plane | 分类指标、展示、运行探针 | 只读 observability 基础 | C systemd 控制块不恢复 | 只恢复只读字段 |

分类：A=D 已有；B=C 有而 D 缺；C=实现需安全重构；D=废弃/禁止。
