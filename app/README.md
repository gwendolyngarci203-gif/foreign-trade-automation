# DaKings Prospect Ops

内部客户采集与邮件准备原型。应用直接读取项目现有网易采集 JSON，提供数据总览、采集流程、买家、联系人和邮件草稿工作区。

## 启动

在 PowerShell 中运行：

```powershell
& "D:\zcy\外贸自动化拓客系统\app\start.ps1"
```

本地默认地址：`http://127.0.0.1:4173`。生产正式入口：`https://ops.dakingscc.cn/`；生产应用仍只监听回环地址，由 Nginx 负责 HTTPS 与 Basic Auth。授权工作站可在项目根目录运行 `& ".\deploy\one-click-deploy.ps1"`，完成校验、备份与无覆盖恢复验证、全量原子发布、Nginx安全切换、服务重启恢复、四个定时器和域名健康检查。

可通过环境变量覆盖：

- `PORT`：服务端口。
- `HOST`：监听地址，默认仅本机。
- `SOURCE_PATH`：采集 JSON 路径。
- `CAMPAIGN_PATH`：本地邮件草稿存储路径。
- `PIPELINE_PATH`：托管九阶段流水线、租约、检查点与熔断状态。
- `OUTBOX_PATH`：发送前落盘的幂等发件箱与尝试事件。
- `RUNTIME_STATE_PATH`：AI网关实际请求时间、成功时间和最近错误。
- `OPENAI_PROXY_URL`：可选的显式 AI 出站代理。当前 `kuaipao.pro` 生产路径保持为空并直连；只有在单独验证代理路径稳定后才设置该值，且它不会改变采集或 SMTP 的默认网络路径。
- `SENDER_PROFILE_PATH`：发件身份、Reply-To、实体地址和退订策略的本地JSON存储路径。
- `FEEDBACK_WEBHOOK_SECRET`：邮件服务商反馈回调的独立认证密钥；未配置时回调接口返回503。

## AI邮件起草

后端通过 `kuaipao.pro` 提供的 OpenAI 兼容 Responses API 生成主题和正文。密钥只从 `OPENAI_API_KEY`
读取，不会返回给浏览器，也不会写入活动文件。默认模型为 `gpt-5.6-sol`，可用
`OPENAI_MODEL` 覆盖。配置项参考 `.env.example`。

AI生成与发送是两个独立动作：生成结果先进入可编辑草稿，之后仍需保存、预览、
提交审核。模型不会直接调用SMTP。

邮件实验室现支持首次开发信、工厂能力信、展会展位邀请、展会当地拜访和对参展商约见五个场景。每次起草必须提供HSCode、产品方向、采购商证据和我方能力；HSCode仅作内部匹配，不写入客户邮件。

33年经验、Walmart/National Geographic客户背书、OA账期、15天交期、工厂图和作品图都是受控卖点，默认禁止，只有人工勾选后才可生成或提交审核。

## 邮件配图

系统内置了用户提供的9组工厂/作品图。首次触达最多1张，展会场景最多2张。选图后必须确认对外使用权，预览会显示所选图片。受控SMTP发送使用multipart/alternative保留纯文本与HTML版，并以CID内嵌图片；不使用跟踪像素。

## SMTP发送门槛

真实发送默认关闭。只有同时满足以下条件时，活动页面才会显示发送按钮：

- `EMAIL_SENDING_ENABLED=true`，且SMTP主机、账号、密码、发件地址完整。
- 活动已提交审核。
- “发件配置”页中的对外公司名、法定公司名、公司邮箱、Reply-To、公司退订邮箱、公司网站和实体地址均已填写。公司电话为可选项，不得使用员工个人号码冒充公司总机。
- 发件域名、退订、实体地址和抑制名单四项均已人工确认。
- 部署环境可用 `SMTP_FROM`、`EMAIL_REPLY_TO`、`EMAIL_UNSUBSCRIBE_URL`、`EMAIL_UNSUBSCRIBE_REPLY_MAILBOX` 和 `EMAIL_PHYSICAL_ADDRESS` 覆盖后台配置。
- 收件人邮箱已验证；如仅限内部测试，可显式设置 `EMAIL_ALLOW_UNVERIFIED=true`。

发送端点要求输入 `SEND <campaign-id>`，每次最多发送 `SEND_BATCH_LIMIT`
封，并按 `SEND_DELAY_MS` 间隔发送。发送结果仅保存收件邮箱哈希和数量，不把SMTP
密码写入审计记录。

## Reply-To 与退订

第一轮统一使用公司身份，不使用员工姓名、职位或个人签名。主发件邮箱同时作为 Reply-To 和退订邮箱，MIME 邮件写入公司邮箱的 `Reply-To` 与 `mailto:` `List-Unsubscribe`。收到回复后再由公司分配员工；第二轮主题和正文目前保留空白。

项目根目录已生成独立HMAC-SHA256密钥文件，为未来切换到签名退订链接预留。当前回复退订不使用该密钥；上线后需要把退订回复或未来token结果写入永久抑制名单。任何公司资料占位符都会继续锁定真实发送。

## 当前能力

- 读取139家买家和前20大买家联系人数据。
- 买家搜索、国家、置信度和补全状态筛选。
- 联系人搜索、角色优先级、匹配置信度和唯一邮箱筛选。
- 本地邮件活动草稿、变量预览、提交审核和模拟排期。
- 场景化AI开发信、HSCode/采购商/联系人三层定制、受控卖点与配图预览。
- 本地审计记录。
- 反馈回调接收、幂等去重、发件箱关联，以及退订、投诉、硬退信自动永久抑制。

## 明确未实现

- 邮箱投递有效性验证。
- 联系人在职状态验证。
- 具体邮件服务商的Webhook字段适配、签名算法和生产回调地址配置。
- 收件箱同步、人工回复/自动回复内容分类和活动效果归因。
- DM Pro、CRM、网易营销任务或第三方上传。

通用 `/api/send` 仍固定返回锁定状态。真实发送只允许走带活动ID、审核状态、
合规检查和确认短语的 `/api/campaigns/:id/send`。

## 免费本地运行控制

历史托管联系人可用以下命令按当前低门槛策略重新识别并生成幂等交接产物；命令不会发送邮件，也不会覆盖原始采集文件：

```powershell
& "C:\Users\18395\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" tools\reprocess-managed-history.mjs
```

结果写入 `outputs/history_reprocessed`，规则为公司非空、邮箱语法有效、来源可追溯并通过抑制检查；姓名、在职证明和两条独立来源不作为硬门槛。

以下能力不依赖付费服务，并且默认只写入 `app/data`：

- 邮箱格式与域名/MX检查：保存为 `syntax_valid`、`domain_valid` 或 `invalid`，不会把域名有效写成可投递。
- 当前联系人页可一次检查最多 25 个邮箱；同一域名在单批中只执行一次 DNS 查询，再把域名结果复用于该批邮箱。
- 人工验证状态导入：`deliverable` 必须提供以完整 HTTP/HTTPS URL 开头的可追溯证据；MX、推测格式或遮罩邮箱不能单独升级。
- 永久抑制名单：邮箱只保存 SHA-256 指纹、域名、原因和来源；活动收件人会自动排除抑制记录。
- HSCode运行任务：冻结采购商/供应商方向、目标国家、买家条目预算、新公司详情预算和联系人分页预算。
- 买家公司联系人队列：从多个完整买家JSON跨来源去重，逐公司保存状态、尝试次数、批次租约、联系人行数、原始批次引用和错误边界；运行控制页支持同步、领取、暂停、恢复和导出。
- 九阶段流水线：`discovery -> trade_normalization -> buyer_matching -> contact_enrichment -> validation -> drafting -> approval -> sending -> feedback`；任务通过短租约领取，过期可恢复排队。
- 受限流水线执行器：`pipeline-worker.mjs` 只读取 `PIPELINE_INPUT_ROOT` 和 `PIPELINE_ARTIFACT_DIR` 内的 JSON；可自动完成 discovery、贸易归一和买家匹配，物流/中间商候选只标记不删除。
- 联系人阶段输入门槛：只有导入 `kind=netease-contact-enrichment` 的可追溯 JSON 才会生成“人物联系人”和“公司联系方式”数据；缺少输入时停在 `waiting_input`。
- 输入门槛：创建托管采集任务后默认为 `waiting_input`，必须登记网易正常页面结果或已导入文件引用才可排队。
- 检查点与熔断：验证码、操作频繁、权限提示、403/429立即进入 `CIRCUIT_OPEN`；结构/分页异常连续三次熔断；恢复需要 `RECOVER <task-id>` 确认短语并回到金丝雀预算。
- 任务审计与导出：界面显示最近 20 条动作，并可导出当前任务 JSON。
- 本地控制备份：导出邮箱验证、抑制、任务审计和活动草稿，不包含密钥、Cookie或原始联系人数据；备份附带 SHA-256 完整性摘要。
- 备份恢复预检：运行控制页可选择导出的 JSON 校验版本、结构、记录上限、邮箱哈希和完整性摘要，但不会自动恢复或覆盖现有数据。应直接校验原始导出文件；经表格软件或其他工具改写后，完整性摘要会失效并被拒绝。
- 安全合并恢复：预览新增与冲突数量后，输入 `MERGE <摘要前缀>` 才执行；写入前自动保存回滚快照。合并只添加缺失记录，同标识记录始终保留当前版本，因此永久抑制、任务计数、熔断状态和发送历史不会被旧备份回滚。破坏性覆盖恢复仍未开放。
- 幂等发件箱：SMTP连接前写入 `pending`，尝试前写入 `sending`，服务器接受后写入 `accepted`。DATA提交后无法确认结果时写入 `uncertain`，必须人工裁决，不得自动重试。
- 邮件反馈入口：`POST /api/feedback/events` 支持 `unsubscribe`、`complaint`、`hard_bounce`、`soft_bounce`、`reply` 和 `auto_reply`。使用 `eventId + x-feedback-source` 幂等；只保存收件邮箱SHA-256，不保存明文邮箱。退订、投诉和硬退信会立即进入永久抑制名单。
- 新 `complaint` 或 `hard_bounce` 会立即打开持久化发送熔断并隔离目标。服务器在冷却后自主核查对应反馈、抑制/无效状态以及发件箱 `sending/uncertain`；全部通过才自动恢复，24小时内重复投诉转人工介入。临时性 `rate_limit`、`provider_temporary`、`smtp_temporary` 同样按冷却恢复。人工恢复仍可使用 `POST /api/delivery-circuit/recover` 和确认短语 `RECOVER DELIVERY`，但不能绕过安全核查；恢复不会重发邮件。
- 首页“今日任务”表示当日单向业务循环，而不是全局安全门：每日额度用完或当日已无待执行项时显示“当日任务已结束”；退信熔断仍在后台冷却并保留于运行控制，但不覆盖当日已经完成的事实。集中发送请求使用25分钟超时，客户端超时后必须依赖幂等发件箱和下一轮定时器续接，禁止手工重发已接受邮件。

对应数据文件：

- `app/data/contact-validation.json`
- `app/data/suppressions.json`
- `app/data/operations.json`
- `app/data/contact-collection.json`
- `app/data/pipeline.json`
- `app/data/outbox.json`
- `app/data/runtime-state.json`

## API

本地控制接口：

- `GET /api/contact-quality`
- `POST /api/contact-quality/validate`
- `POST /api/contact-quality/status`
- `GET|POST /api/suppressions`
- `GET|POST /api/ops/tasks`
- `GET /api/ops/tasks/:id`
- `POST /api/ops/tasks/:id/actions`
- `POST /api/ops/tasks/:id/recover`
- `GET /api/contact-queues`
- `POST /api/contact-queues/initialize`
- `GET /api/contact-queues/:id`
- `POST /api/contact-queues/:id/claim`
- `POST /api/contact-queues/:id/batches/:batch-id/complete`
- `POST /api/contact-queues/:id/pause|resume`
- `GET /api/contact-queues/:id/boundary-report`
- `GET /api/pipeline`
- `GET /api/pipeline/daily-batch?limit=1000&central=1`（托管集中批次预览；实际可用量由统一容量服务决定）
- `POST /api/pipeline/central-batch/send`（确认短语 `SEND DAILY BATCH`；统一预检后发送）
- `POST /api/pipeline/claim-next`
- `POST /api/pipeline/jobs/:id/resume`
- `POST /api/pipeline/jobs/:id/stage`
- `POST /api/pipeline/jobs/:id/pause|circuit|recover`
- `GET /api/outbox`
- `POST /api/outbox/:id/resolve`
- `POST /api/feedback/events`
- `GET /api/delivery-circuit`
- `POST /api/delivery-circuit/recover`
- `GET /api/local-backup`
- `POST /api/local-backup/validate`
- `POST /api/local-backup/preview`
- `POST /api/local-backup/merge`

- `GET /api/health`
- `GET /api/summary`
- `GET /api/quality`（本地数据质量报告：买家覆盖、联系人可用性、重复、邮箱格式和发送前风险）
- `GET /api/workflow`
- `GET /api/buyers`
- `GET /api/contacts`
- `GET /api/options`
- `GET|POST /api/campaigns`
- `PUT /api/campaigns/:id`
- `POST /api/campaigns/:id/preview`
- `POST /api/campaigns/:id/submit-review`
- `POST /api/campaigns/:id/approve`（需要 `APPROVE <campaign-id>` 确认短语；通过内容、合规和名单门槛后才进入 approved）
- `POST /api/campaigns/:id/simulate-schedule`
- `POST /api/ai/draft`
- `POST /api/ai/drafts`（同一客户资料生成1-3种候选输出类型；只有前端明确采用的候选才写入活动）
- `POST /api/campaigns/:id/send`

## 邮件反馈回调

反馈入口默认关闭。配置独立的 `FEEDBACK_WEBHOOK_SECRET` 后，服务商适配器应发送：

```http
POST /api/feedback/events
Content-Type: application/json
X-Feedback-Secret: <dedicated webhook secret>
X-Feedback-Source: <provider name>

{"eventId":"provider-event-id","type":"complaint","email":"recipient@example.com","messageId":"provider-message-id","occurredAt":"2026-08-04T12:00:00Z"}
```

也可以发送64位小写SHA-256 `recipientHash` 代替邮箱。接口按 `messageId` 优先、收件人哈希其次关联幂等发件箱；重复事件返回200和 `duplicate=true`，新事件返回202。该通用入口不等于服务商已经完成对接：上线前仍需按所选SMTP/ESP的实际签名和字段编写适配器，并完成一次真实回调金丝雀。

当前部署的 AliMail 适配器为 `tools/imap-feedback-poller.py`。它通过 IMAPS 只读打开 Maggie1 收件箱，首次运行仅建立 UID 基线，之后只处理新 UID，并把标准化事件提交到上述接口。可运行 `python tools/imap-feedback-poller.py --self-test` 做离线分类自检；生产由 `dakings-imap-feedback.timer` 调度。不要把 `--dry-run --lookback` 当作真实反馈验收，它只用于读取分类结果且不会推进检查点。

## External purchase and authorization gates

The **System Boundary** page is the source of truth for local readiness and external blockers. The following items are intentionally not simulated by the app:

- 网易账号不是购买项：使用业务方提供的网易外贸账号现场登录并保持正常页面会话。
- 邮箱验证：在职/可投递验证服务订阅，或可追溯的人工验证证据。
- 发件基础设施：发件域名、SMTP credentials, SPF/DKIM/DMARC and bounce handling.
- 合规与业务授权：unsubscribe URL, physical sender address, suppression-list/CRM permissions, approved business claims and image rights.

Administrator access to this computer is not currently required. It cannot replace an external subscription, domain configuration or business approval. `syntax_valid` and `domain_valid` are local checks only; they do not assert deliverability. Managed mode may use the explicitly authorized `domain_valid` minimum policy, while SMTP, compliance fields, suppressions, feedback and batch limits remain mandatory; supervised mode retains explicit batch approval.

## Pipeline worker

## NetEase managed contact queue (2026-08-14)

### Keyword副采集

运行控制中的 `Keyword副采集` 复用同一安全队列。登录网易外贸通并保持业务页打开后，可用以下命令按可见页面采集采购商或供应商结果；HSCode 仍是主采集入口：

```powershell
& "C:\Users\18395\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" `
  ".\tools\netease-keyword-discovery.mjs" "board games" buyer 1
```

脚本输出 `netease-keyword-discovery` JSON 快照，保留关键词、方向、页码、来源网址和安全检查结果，后续可按运行控制的联系人队列交接。验证码、频控、权限或登录失效会立即停止并保留现场，不会绕过平台限制。

前端位置：左侧 `运行控制` → `创建冻结任务` → `采集方式`。支持 `HSCode主采集`、`Keyword副采集` 和 `国家+业务范围第三采集`；按所选模式填写输入，再选择采购商/供应商方向并提交任务。托管授权短语会自动按当前采集方式生成。

### 国家+业务范围第三采集

第三种方式用于小批量验证指定国家的业务匹配度。前端位置同上：选择 `国家+业务范围第三采集`，填写国家（本次示例为 `Poland`）和业务范围关键词（例如 `board games, books, paper packaging`），再选择采购商/供应商方向。执行器先在网易关键词页面检索业务组合，再按结果行中的国家字段只保留目标国家，输出 `netease-country-business-discovery` 检查点 JSON。该模式不会自动发送邮件；只有后续完成联系人补全、验证和发送前核验后，才可进入既有邮件流程。

命令行小样本（需已登录且保持网易业务页）：

```powershell
& "C:\Users\18395\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" `
  ".\tools\netease-country-business-discovery.mjs" "Poland" "board games, books, paper packaging" buyer 1
```

邮件中心客户导出：进入左侧 `邮件中心` → `回信处理台`，勾选每行最左侧复选框，在表格右上角填写 `导出行数` 后点击 `导出`。服务端只保留外部潜在客户回信，内部 Maggie、postmaster、阿里系统通知会被排除；CSV 包含正文、收发件人、主题、附件、状态及 `message_json` 完整原始字段。导出文件只应存放在受控目录。

The queue-level entry point is `tools/netease-contact-supervisor.mjs`. The
plan-level scheduled entry point is `tools/run-managed-hscode-plan.ps1`; it
may invoke the supervisor, but never launches the raw collector directly.
The supervisor owns a workspace lock, reuses the isolated Edge profile on CDP
port 9223, validates fixed page elements, deduplicates ready NetEase pages, and
then runs a bounded collector batch.

Runtime rules:

- Never terminate normal Edge processes. Only a stale process using this
  workspace's `.codex_work/edge-cdp-profile` may be replaced.
- Browser startup waits up to 60 seconds for CDP and 90 seconds for fixed
  business elements. URL text is not a readiness check.
- Search supports Unicode company names and a reviewed core-name fallback for
  trade records that concatenate company, address, and postal text.
- `captcha`, `frequent_operation`, `permission`, HTTP 403, and HTTP 429 open the
  circuit immediately. Local timeouts rotate the item and do not stop the queue.
- A completed queue with failed items requeues the same failed-item signature
  at most once. This prevents both false completion and infinite retry loops.
- Workbook generation runs after a managed batch and again when the queue is
  fully complete.

Manual managed run:

```powershell
& "C:\Users\18395\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" `
  ".\tools\netease-contact-supervisor.mjs"
```

Failed-item recovery API (confirmation is mandatory):

```text
POST /api/contact-queues/:id/retry-failed
{"confirm":"RETRY FAILED <queue-id>"}
```

本地单次处理一个阶段：

```powershell
$env:PIPELINE_API_BASE = "http://127.0.0.1:4173"
$env:PIPELINE_INPUT_ROOT = "D:\zcy\外贸自动化拓客系统\outputs"
$env:PIPELINE_ARTIFACT_DIR = "D:\zcy\外贸自动化拓客系统\app\data\pipeline-artifacts"
node app/pipeline-worker.mjs --drain --max-jobs 6
```

执行器不保存网易 Cookie、不调用未公开接口，也不自行处理验证码。网易可见页面结果应先按 `netease-customs-discovery` 格式落盘，再通过流水线 `resume` 接口登记文件引用。生产发送、OpenAI 出口、邮箱可投递验证和联系人在职验证仍是独立门槛。

## 2026-08-15 production checkpoint

- Queue `collection_e977e59e-8f24-408b-9076-ebcc3bac9f93` is complete: 1,328/1,328 companies, 0 pending, 0 failed, safety state `READY`.
- The final workbook contains two delivery sheets. Source counts are 6,617 platform contact rows, 6,424 parsed rows, and 6,219 deduplicated people.
- Runtime defaults are one Edge CDP session, one claimed company, 15-25 seconds between companies, no more than 20 companies per supervisor invocation, and at least 10 minutes between normal batches.
- Severe platform signals use the 30/45/60/90/120/180 minute adaptive cooldown ladder. Recovery starts with one company. A local control timeout or browser disconnect rotates the item and does not increase platform cooldown.
- The old broad collection task remains paused. The user-authorized Windows task `DaKings Managed HSCode Plan` runs the bounded plan-level entry point daily at 00:05, catches up when the workstation was unavailable, and runs only in the interactive user session so it can reuse the isolated Edge profile.
- Latest deployed project progress is 99% on the nine-stage application metric: acquisition is 100%, outbound-email readiness is 100%, and the feedback/reply loop is 95% pending continued natural-reply attribution. The server synchronizes all ten Maggie inboxes, exposes the Mail Center reply desk, and supports audited same-account replies. Hard limits, suppression, dedupe, circuit and intervention gates remain enforced by the production runtime.

- 2026-08-23 managed-plan checkpoint: five explicitly selected person-level canaries are SMTP accepted with zero failed or uncertain outbox entries. `plans/managed-hscode-plan.json` freezes the current HSCode sequence and default daily budgets; `tools/managed-hscode-plan.mjs` validates and idempotently registers each plan task. Delivery capacity is now read through the unified account-aware capacity service; managed authorization never bypasses CAPTCHA, credential, permission or MFA gates. Production delivery remains locked until all independent safety gates pass.
- Manual-intervention faults send one deduplicated alert per fault category and Beijing business day to `OPS_ALERT_EMAIL`. Alerts use the same SMTP fleet and outbox as business mail, so every pending, sending, accepted, or uncertain alert reduces the remaining capacity reported by the unified delivery-capacity service by one.

## Managed central-batch review

- Managed runs no longer pause at a per-task human approval step after drafting. Collection and drafting continue automatically; eligible draft volume is bounded by the unified delivery-capacity service and marked `central_batch_review_pending`.
- `GET /api/pipeline/daily-batch?limit=1000` previews the next central batch. `POST /api/pipeline/central-batch/send` accepts the exact phrase `SEND DAILY BATCH` and performs one preflight across the selected drafts before writing the outbox and sending.
- The central review still enforces valid email, contact/company fields, draft quality, suppression/global dedupe, two contacts per company per day, SMTP identity/readiness, feedback configuration, circuit state, ten-account limits and the unified delivery-capacity result. Managed qualification uses `domain_valid` as the minimum contact signal; supervised jobs retain the legacy per-batch approval route.
- Managed discovery uses an adaptive floor of `8 x validEmailCompaniesDaily` buyer entries (capped at 2,000) so low email-yield pages do not exhaust discovery before the company/email inventory is replenished. The runner counts distinct send-ready companies first, continues in bounded batches while fewer than 100 are available, and holds collection once that company target is full; message count alone no longer stops collection. The current plan is `1200` buyer entries, `400` company details, `100` valid-email companies and a 500-message capacity baseline subject to account health and safety gates.
- Managed contact qualification now accepts a domain-valid, traceable company contact even when the visible page has no personal name; drafting uses the explicit `Purchasing Team` generic salutation rather than inventing an individual identity. Suppression, company attribution, syntax/domain validation, dedupe, per-company limits and the unified global/account capacity gates remain enforced.
