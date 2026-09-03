# 阿里云公网 IP 部署方法

生产正式入口为 `https://ops.dakingscc.cn/`。`ops` A 记录已指向服务器公网 IP，Nginx 已部署受信任的 Let's Encrypt 证书，HTTP 会永久跳转至 HTTPS。站点仍受 Nginx Basic Auth 保护，未携带内部管理凭据时返回 `401` 属于正常状态。2026-08-24，`dakingscc.cc`与`dakingscc.cn`均已完成MX/SPF/DKIM/DMARC，Maggie1至Maggie10共10个账号均已完成独立客户端密码和本机/服务器SMTP AUTH，全程未进入DATA。阿里企业邮箱不作为营销邮件通道，阿里邮件推送也明确禁止第三方来源、未经许可的开发信；在验收允许该用途的产品、适用地区法律、退订/反馈和联系人证据前，真实邮件发送继续关闭。本项目只允许操作 `/opt/dakings-prospect-ops`。阿里云 Linux优先使用systemd + Nginx；Docker Compose作为镜像仓库可用时的备用方案。HTTPS状态与续期方法见`HTTPS_STATUS.md`。

## 目录

- `compose.yaml`：容器编排与安全限制。
- `Dockerfile`：Node 22 运行镜像。
- `.env.runtime`：运行密钥与可选 AI 代理配置；本机副本必须被版本控制忽略并限制ACL，服务器副本权限必须为 `600`。当前 `kuaipao.pro` 生产路径直连，`OPENAI_PROXY_URL` 为空；代理仅在单独验证后启用。
- `runtime-data/`：活动草稿、邮箱检查、抑制名单、托管流水线、幂等发件箱、AI运行态和本地备份。
- `source/source.json`：只读业务源数据。
- `update.sh`：构建、启动和健康检查。
- `backup.sh`：备份运行态数据并保留 30 天。
- `restore.sh`：校验备份、自动生成恢复前快照、健康检查失败时回滚。
- `healthcheck.sh`：校验服务、端口、健康契约、HTTPS 认证边界、资源阈值和备份新鲜度。
- `assert-isolation.sh`：在部署、更新、备份、恢复和巡检前校验项目路径、符号链接边界、服务用户及工作目录。
- `dakings-prospect-ops.service`：非 root Node 系统服务。
- `dakings-prospect-ops-healthcheck.service/.timer`：每 15 分钟运行一次只读巡检并写入本地状态。
- `dakings-pipeline-worker.service/.timer`：每 2 分钟领取持久流水线阶段；只处理专用目录内的已落盘输入。
- `dakings-netease-browser.service`：服务器持久 Chromium/Xvfb，CDP 只监听 `127.0.0.1:9224`。
- `dakings-managed-collection.service/.timer`：复用同一托管计划执行器完成服务器采集和本机流水线交接；部署默认不启用，生产已在登录和无 SMTP 批次验收后启用。
- `nginx-prospect-ops.conf`：公网 80 端口反向代理、Basic Auth、限速和安全响应头。
- `update-systemd.sh`：加载服务、验证 Nginx 并执行健康检查。
- `deploy-server.py`：仓库内通用部署器；读取仓库外凭据与已核验SSH主机指纹，发布完整应用、图片、脚本、systemd单元和Nginx配置。
- `requirements-deploy.txt`：部署器的固定Python依赖；首次缺失时由一键入口安装到被Git忽略的`.codex_work/python_deps`。
- `one-click-deploy.ps1`：授权 Windows 工作站的一键入口；串联本地测试、服务器备份、Nginx回滚保护、原子上传、浏览器运行时、备份恢复验证、服务器 smoke、重启恢复、四个基础 timer、健康巡检和公网域名 401 边界验收。托管采集 timer 只部署、不改变现有启停状态。

## 首次部署（当前阿里云服务器）

服务器为共享环境。不得读取、修改、移动或恢复其他 `/opt` 项目；所有运维动作必须限定在 `/opt/dakings-prospect-ops`，且先执行：

```bash
cd /opt/dakings-prospect-ops/deploy
./assert-isolation.sh
```

隔离检查失败必须停止，不得绕过。

```bash
dnf install -y nodejs nginx
systemctl daemon-reload
systemctl enable --now dakings-prospect-ops.service nginx.service dakings-prospect-ops-backup.timer dakings-prospect-ops-healthcheck.timer dakings-pipeline-worker.timer
```

公网入口由 Nginx Basic Auth 和受信任的 Let's Encrypt 证书保护，Web 登录凭据与服务器 root 凭据分离。应用只监听回环地址，公网只经 Nginx 的 HTTPS 入口访问。

正式域名切换已完成：当前账号管理 `dakingscc.cn` 的归属已经核实；`ops.dakingscc.cn` A 记录仅修改 `ops` 子域且未触碰根域现有企业邮箱 MX/SPF。公网 DNS 生效后，已使用 `certbot` 与 Nginx 插件签发该子域证书、通过 `nginx -t`、reload 和 HTTPS 回归验证。证书有效至 2026-11-08，Certbot 已安装自动续期任务。

## DNS 权限验收

必须同时看到以下两个事实，才算“DNS已接通”：

1. 阿里云公网权威解析列表中存在 `dakingscc.cn`，并能在该区新增 `ops` A 记录；
2. 公共解析连续两次返回 `ops.dakingscc.cn -> 39.106.182.40`。

仅看到阿里云首页、ECS资源或登录成功，不算拥有域名解析权限。2026-08-10已在域名列表和云解析控制台同时核实 `dakingscc.cn`，该权限门已关闭；`ops` A记录和受信任证书均已完成。

## 阿里云邮件产品状态

- `dakingscc.cn` 与 `dakingscc.cc` 的根域MX/SPF正常，但DNS记录不等于邮箱产品实例。
- 2026-08-14已购买`dakingscc.cc`企业邮箱并创建`maggie1@dakingscc.cc`至`maggie5@dakingscc.cc`，后台均显示正常；DirectMail仍未开通，也无需在当前阶段购买。
- 企业邮箱使用 `smtp.qiye.aliyun.com` 体系及企业邮箱专用账号/密码；DirectMail使用 `smtpdm.aliyun.com` 体系及DirectMail发信地址/专用凭据，两者不得混用。
- 管理后台保留“所有用户禁止第三方客户端”的全局策略；只对Maggie1至Maggie10按所属邮箱池建立例外，Postmaster继续禁止第三方客户端。
- Maggie1至Maggie10均已完成安全初始化并生成各自独立客户端安全密码；`smtp.qiye.aliyun.com:465` TLS+SMTP AUTH在本机和服务器均通过，测试未进入DATA、未发送邮件。Maggie1另已完成内部双向网页金丝雀。
- 服务器健康接口已确认`ok=true`、`smtpConfigured=true`、`sendingEnabled=false`；SMTP凭据只存在于受限运行环境文件。
- 开通后的完整接入顺序以`项目大要求！/07_邮件模板、域名与SMTP接入方法_V1.4.txt`为准。

开发信模板已固化为 `app/data/email-template-library.json`。模板来自 `开发信模板及配图.docx` 的五类场景，但只保留业务结构；AI 必须改写为自然英文，未经批准不得使用客户背书、OA、33 年经验、15 天交期或配图。字数不合格时自动重写一次。托管模式的结果进入集中批次核验；supervised 模式仍停在人工审批门。

托管模式的草稿与发送容量由统一 delivery-capacity 服务计算，当前配置基线为10账号、每账号50封、全局500封；实际发送仍受抑制、防重、SMTP、反馈、熔断、每公司两位联系人和账号健康状态约束。集中发送使用 `POST /api/pipeline/central-batch/send` 与一次性确认短语 `SEND DAILY BATCH`。

## Docker 备用方案

```bash
cd /opt/dakings-prospect-ops/deploy
cp .env.runtime.example .env.runtime
chmod 600 .env.runtime
chmod +x update.sh backup.sh restore.sh healthcheck.sh
./update.sh
```

浏览器访问：`https://ops.dakingscc.cn/`。没有内部 Basic Auth 凭据时显示 `401` 属于预期保护状态。

## 日常更新

授权工作站推荐直接运行：

```powershell
& ".\deploy\one-click-deploy.ps1"
```

部署逻辑现保存在 Git 的 `deploy/deploy-server.py`，不再依赖被忽略的历史部署脚本或采集输出。密码仍只从被 Git 忽略的本机 `公网ip和账号密码.txt` 读取；SSH 主机指纹只从 `.codex_work/known_hosts` 读取并使用拒绝未知主机策略。Python依赖缺失时会按`requirements-deploy.txt`安装到`.codex_work/python_deps`。只有在本地测试已经单独通过时才可使用 `-SkipLocalTests`。服务器健康契约中的本机 HTTPS 401 是硬门；工作站公网路径检查默认作为补充信息，因为当前网络曾返回 403/连接重置。仅在已知网络正常时使用 `-RequireWorkstationPublic401` 把工作站 401 也设为硬门。不得为了得到 200 而移除 Basic Auth。

新维护电脑只需从私有Git仓库取得代码，并通过线下受控方式恢复两项本机材料：服务器三行凭据文件、已人工核验的SSH `known_hosts`。不得把这两项放入Git、聊天或交接文档。首次新服务器仍需人工创建`prospectops`用户、固定目录、权限600的`.env.runtime`、只读`source/source.json`、Basic Auth、DNS和Certbot证书；一键入口用于已经完成这些基础准备的正式服务器或恢复服务器，不冒充云主机裸机初始化器。

上传新代码后运行：

```bash
cd /opt/dakings-prospect-ops/deploy
./backup.sh
./update.sh
```

当前正式环境使用 systemd，不依赖 Docker Hub：

```bash
systemctl status dakings-prospect-ops.service nginx.service
journalctl -u dakings-prospect-ops.service -n 100 --no-pager
systemctl restart dakings-prospect-ops.service
nginx -t && systemctl reload nginx.service
curl http://127.0.0.1:4173/api/health
systemctl start dakings-prospect-ops-healthcheck.service
cat /opt/dakings-prospect-ops/deploy/runtime-data/ops-health.json
```

## 备份与恢复

每日 02:30 由 `dakings-prospect-ops-backup.timer` 触发备份，并附加最多 15 分钟随机延迟。备份位于 `/opt/dakings-prospect-ops/deploy/backups/`，保留 30 天，只包含 `runtime-data/`，不包含服务器密码、Web 密码、OpenAI key 或 SMTP 密码。

```bash
cd /opt/dakings-prospect-ops/deploy
./backup.sh
tar -tzf backups/runtime-data-YYYYMMDD-HHMMSS.tar.gz >/dev/null
./restore.sh --verify backups/runtime-data-YYYYMMDD-HHMMSS.tar.gz
./restore.sh backups/runtime-data-YYYYMMDD-HHMMSS.tar.gz
```

`--verify`只在项目目录下的临时目录完整解包并核对`pipeline.json`、`outbox.json`和`runtime-state.json`，不会停止服务或替换运行态；一键部署每次自动执行。真实恢复会先生成 `pre-restore-*.tar.gz`，停止应用、在临时目录解包、收紧属主并重启。健康检查失败会自动恢复原运行目录。生产恢复前仍应记录选择的备份文件、操作者和恢复原因。

## 免费健康巡检

`dakings-prospect-ops-healthcheck.timer` 每 15 分钟触发一次，带最多 2 分钟随机延迟。巡检固定检查：

- Node 与 Nginx 服务状态。
- 受控出站代理服务状态和本机监听范围由独立部署记录维护；代理不会改变默认路由。
- 4173 是否只监听回环地址。
- `/api/health` 是否满足 `ok=true`、`sourceLoaded=true`、AI 模型 `gpt-5.6-sol`、`sendingEnabled=false`。
- 前端首页 HTML、`app.js`、`styles.css` 可访问且包含应用挂载点；库存 API 返回可解析的公司库存、草稿池和当日状态字段。采集队列的历史控制边界不会被误报为前端故障。
- 本机未认证 HTTPS 是否返回 401。
- 磁盘使用率是否低于 85%，内存使用率是否低于 90%。
- 最新运行态备份是否在 36 小时内并能通过 `tar` 完整性校验。

结果原子写入 `runtime-data/ops-health.json`，权限为 `600`，不含密码、密钥或联系人明文。失败时脚本返回非零并写入 systemd journal，不会自动重启服务、开放端口或改变发送开关。

HSCode业务流水线使用持久化短租约：服务重启后，过期的 `running` 任务可重新排队。缺少网易正常页面结果、遇到验证码或权限提示时，必须停在 `waiting_input` 或 `circuit_open`，不得自动绕过。邮件发送前先写入 `outbox.json`；`accepted`、`sending`和 `uncertain` 记录禁止自动重试。

流水线执行器只允许读取：

- `runtime-data/pipeline-inputs/`：人工或浏览器金丝雀确认后上传的网易可见页面结果。
- `runtime-data/pipeline-artifacts/`：执行器生成的 discovery、贸易归一、买家匹配和后续阶段产物。

执行器不会持有网易 Cookie，也不会发起网易页面请求。`discovery -> trade_normalization -> buyer_matching` 可以自动推进；没有 `netease-contact-enrichment` 输入时，`contact_enrichment` 必须停在 `waiting_input`。物流/货代候选只标记复核，不从全量名单中删除。

## 邮件服务商反馈回调

应用提供通用 `POST /api/feedback/events` 接口，支持 `unsubscribe`、`complaint`、`hard_bounce`、`soft_bounce`、`reply` 和 `auto_reply`。在 `.env.runtime` 中设置独立的 `FEEDBACK_WEBHOOK_SECRET` 后，回调必须携带 `X-Feedback-Secret`；建议同时携带稳定的 `X-Feedback-Source` 服务商标识。密钥不得复用 OpenAI key、SMTP密码或Web密码。

事件按 `eventId + source` 幂等。运行态只保存收件邮箱SHA-256、域名、事件类型、时间和发件箱关联，不保存回调中的明文邮箱。退订、投诉和硬退信立即写入永久抑制名单；软退信、回复和自动回复只记录事件。

当前生产采用 `tools/imap-feedback-poller.py` 每五分钟只读轮询 Maggie1 至 Maggie10 的 AliMail 收件箱。首次为每个账号缓存最近50封邮件供前端统一查看，但不把历史邮件重复提交为反馈；后续只按各账号独立 UID 检查点读取新增邮件，并判断 `reply`、`auto_reply`、`unsubscribe`、`hard_bounce`、`soft_bounce`、`complaint`。适配器不标记已读、不移动或删除邮件，单账号最多保留最近200封纯文本解析结果；附件只显示存在标记，暂不下载或在网页打开。

十账号客户端授权码存放在 `/opt/dakings-prospect-ops/deploy/mailbox-accounts.json`，属主 `prospectops`、权限 `600`，不属于 `runtime-data`，不会进入日常运行态备份或Git。前端 `邮件中心` 只能取得账号状态、邮件数据和发送审计，任何接口都不返回密码。人工新建邮件一次只允许一个收件人，必须确认正常商务用途；回复收件人固定为原邮件发件人，并由原收件账号SMTP发出。人工通信与开发信均经过统一容量服务；当前开发信仍受 `EMAIL_SENDING_ENABLED=false`、用途423硬门和合规门控约束。

任何新投诉或硬退信都会打开持久化发送熔断并隔离对应目标。服务器在 `DELIVERY_CIRCUIT_COOLDOWN_MINUTES`（默认60分钟）后自主核查反馈事件、抑制/无效记录以及发件箱 `sending/uncertain`；通过后自动恢复，24小时内重复投诉会保持熔断并发送介入告警。临时性 `rate_limit`、`provider_temporary` 或 `smtp_temporary` 使用同一冷却恢复门。人工 `RECOVER DELIVERY` 也不能绕过核查；恢复不改变生产发送开关，不重发已接受邮件。完整矩阵见 `deploy/CIRCUIT_RECOVERY.md`。

```bash
systemctl status dakings-imap-feedback.timer
systemctl show dakings-imap-feedback.service -p Result -p ExecMainStatus
journalctl -u dakings-imap-feedback.service -n 100 --no-pager
```

`inactive (dead)` 是 oneshot 执行结束后的正常状态，应以 `Result=success`、`ExecMainStatus=0`、timer 为 active 和检查点递增为准。当前已完成真实账号只读登录、历史邮件 dry-run 和首个 UID 基线；最终验收等待下一封自然新回复进入反馈事件，不为测试重复发送邮件。

```bash
systemctl status dakings-pipeline-worker.timer
systemctl start dakings-pipeline-worker.service
journalctl -u dakings-pipeline-worker.service -n 100 --no-pager
```

```bash
systemctl status dakings-prospect-ops-healthcheck.timer
systemctl show dakings-prospect-ops-healthcheck.service -p Result -p ExecMainStatus
journalctl -u dakings-prospect-ops-healthcheck.service -n 100 --no-pager
cat /opt/dakings-prospect-ops/deploy/runtime-data/ops-health.json
```

oneshot 巡检服务执行完成后显示 `inactive (dead)` 属于正常状态；应以 `Result=success`、`ExecMainStatus=0`、状态 JSON 的 `state=ok` 和 timer 下一次触发时间为准。

## 公网访问

- HTTP 80 只用于跳转到 HTTPS。
- HTTPS 443 使用 `ops.dakingscc.cn` 的受信任证书和独立 Basic Auth；未认证请求返回 `401`。
- 本次配置未变更阿里云安全组、根域 DNS、MX、SPF 或 NS。
- Web 登录凭据保存在本地 `服务器后台访问账号.txt`，不要写入代码、文档或聊天。
- 证书状态、到期日与手工复核命令见 `HTTPS_STATUS.md`。

## Docker 备用运维

只有镜像仓库可用并明确切换到 Compose 时才使用：

```bash
docker compose ps
docker compose logs --tail=100
docker compose restart
docker compose down
```

## 安全边界

- 不把服务器密码、OpenAI key、SMTP 密码写入代码、镜像或 Word 文档。
- 不读取或修改服务器上的其他项目；不建立指向项目根目录外的符号链接；只使用 `prospectops` 和固定工作目录运行本项目服务。
- 不把 `FEEDBACK_WEBHOOK_SECRET` 写入代码、日志、聊天或Word文档；仅保存在权限600的服务器环境文件中。
- 不开放应用的 4173 端口，只允许 Nginx 从 `127.0.0.1` 访问。
- 容器使用非 root 用户、只读文件系统、全部 capability 移除。
- `EMAIL_SENDING_ENABLED=false` 和 `EMAIL_ALLOW_UNVERIFIED=false` 由 Compose 强制覆盖。
- 当前正式入口为 `https://ops.dakingscc.cn/`，使用受信任的 Let's Encrypt 证书和独立 Basic Auth；HTTPS就绪不代表邮件发件就绪。

## 2026-08-14发件阶段交接

- 当前采集批次已完成1,328/1,328家公司；采集自动任务保持暂停。
- 用户准备购买企业邮箱。近期目标是低量逐人定制并接收回复，先购买一个企业邮箱产品，不同时开通DirectMail。
- 开通后先创建1个主发件账号和1个公司自有测试收件账号，再生成独立SMTP客户端专用密码。
- 凭据只写入本项目`.env.runtime`且权限600；先做TLS+AUTH，不进入SMTP DATA。
- AUTH成功后再验收SPF、DKIM、DMARC、Reply-To、实体地址、退订和服务商回调。
- 首次发送只允许1封内部金丝雀。验收通过前保持`EMAIL_SENDING_ENABLED=false`与`EMAIL_ALLOW_UNVERIFIED=false`。

## 2026-08-14 DNS身份验收增量

- `dakingscc.cc`原有三条MX、唯一SPF和mail/smtp/pop3/imap CNAME保持不变。
- 新增TXT `default._domainkey`，公共DNS返回完整2048位DKIM；阿里企业邮箱后台“立即验证”显示通过。
- 新增TXT `_dmarc`，策略为`p=none`并将聚合/取证报告发送至`postmaster@dakingscc.cc`。
- DMARC暂不提升到`quarantine`或`reject`。先完成内部金丝雀、邮件头对齐检查和报告观察。
- DNS身份记录通过不等于允许真实外发；服务器继续保持`EMAIL_SENDING_ENABLED=false`和`EMAIL_ALLOW_UNVERIFIED=false`。
