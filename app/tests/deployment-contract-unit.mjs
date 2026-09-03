import assert from "node:assert/strict";
import fs from "node:fs";

const deployer = fs.readFileSync("deploy/deploy-server.py", "utf8");
const oneClick = fs.readFileSync("deploy/one-click-deploy.ps1", "utf8");
const server = fs.readFileSync("app/server.mjs", "utf8");
const frontend = fs.readFileSync("app/public/app.js", "utf8");
const index = fs.readFileSync("app/public/index.html", "utf8");
const nginx = fs.readFileSync("deploy/nginx-prospect-ops.conf", "utf8");
const restore = fs.readFileSync("deploy/restore.sh", "utf8");
const healthcheck = fs.readFileSync("deploy/healthcheck.sh", "utf8");
const managedTask = fs.readFileSync("tools/install-managed-hscode-task.ps1", "utf8");
const managedRunner = fs.readFileSync("tools/run-managed-hscode-plan.ps1", "utf8");
const managedNodeRunner = fs.readFileSync("tools/run-managed-hscode-plan.mjs", "utf8");
const contactSupervisor = fs.readFileSync("tools/netease-contact-supervisor.mjs", "utf8");
const handoffPipeline = fs.readFileSync("tools/handoff-managed-pipeline.py", "utf8");

for (const required of [
  "app/public/assets/email",
  "tools/imap-feedback-poller.py",
  "dakings-pipeline-worker.timer",
  "dakings-prospect-ops-backup.timer",
  "dakings-prospect-ops-healthcheck.timer",
  "dakings-imap-feedback.timer",
  "dakings-netease-browser.service",
  "dakings-managed-collection.service",
  "dakings-managed-collection.timer",
  "install-netease-browser.sh",
]) assert.match(deployer, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

assert.doesNotMatch(deployer, /outputs\//, "deployment must not depend on ignored generated outputs");
assert.match(oneClick, /deploy\\deploy-server\.py/);
assert.match(oneClick, /requirements-deploy\.txt/);
assert.doesNotMatch(nginx, /style-src[^;]*unsafe-inline/);
assert.match(restore, /--verify/);
assert.match(restore, /mktemp -d \.\/runtime-data\.verify/);
assert.match(healthcheck, /OPS_EXPECTED_SENDING/, "health check must validate the configured sending state");
assert.match(healthcheck, /allowUnverified === false/, "health check must keep unverified delivery disabled");
assert.doesNotMatch(healthcheck, /circuit\?\.open === false/, "an open delivery circuit is safe runtime state, not an application health failure");
assert.match(deployer, /Result --value\)\\\" = success &&/, "deployment must propagate a failed healthcheck oneshot");
assert.match(managedTask, /schtasks\.exe \/Create/);
assert.match(managedTask, /\/SC MINUTE \/MO \$RepeatMinutes/);
assert.match(managedRunner, /--mode collection/);
assert.match(managedRunner, /LASTEXITCODE -eq 3/);
assert.match(managedRunner, /-ServerOnly/);
assert.ok(managedRunner.indexOf("--handoff-only") < managedRunner.indexOf("--mode collection"));
assert.match(managedRunner, /Tee-Object -FilePath \$logPath -Append/);
assert.match(managedNodeRunner, /managed_network_failure/);
assert.match(managedNodeRunner, /daily-batch\?limit=1000&reserve=1&central=1/);
assert.match(managedNodeRunner, /managed_inventory_full/);
assert.doesNotMatch(managedNodeRunner, /daily_buyer_budget_exhausted/);
assert.match(managedNodeRunner, /verification: "netease_business_page_ready"/);
assert.match(managedNodeRunner, /managed_daily_collection_locked/);
assert.match(managedNodeRunner, /candidate\.counts\?\.pending/);
assert.doesNotMatch(managedNodeRunner, /candidate\.counts\?\.remaining \|\| 0\) > 0/);
assert.match(managedNodeRunner, /LOCK MANAGED COLLECTION/);
assert.match(managedNodeRunner, /刷新服务器登录页/);
assert.match(contactSupervisor, /process\.kill\(ownerPid, 0\)/);
assert.match(handoffPipeline, /at_review = job\.get\("currentStage"\) == "approval"/);
assert.match(handoffPipeline, /mode\": \"central_batch\"/);

const preflight = fs.readFileSync("tools/run-managed-preflight.py", "utf8");
assert.match(preflight, /daily-batch\?limit=1000&reserve=1&central=1/);

const planSync = fs.readFileSync("tools/sync-managed-plan.py", "utf8");
assert.match(planSync, /remote\.api\("PUT", f"\/api\/ops\/tasks\/\{plan\['sourceTaskId'\]\}"/);

const runtime = fs.readFileSync("tools/start-netease-collection-runtime.ps1", "utf8");
assert.match(runtime, /latestRuntimeWrite -gt \$process\.CreationDate/);

const handoff = fs.readFileSync("tools/handoff-managed-pipeline.py", "utf8");
assert.match(handoff, /page:\{page_number\}:buyers/);
assert.match(handoff, /def completed_handoff\(job\):/);
assert.match(handoff, /delivered = completed_handoff\(job\)/);
assert.match(handoff, /按已发送状态幂等返回/);
assert.doesNotMatch(handoff, /clamp_actions_to_task_budget/);

const browserService = fs.readFileSync("deploy/dakings-netease-browser.service", "utf8");
assert.match(browserService, /127\.0\.0\.1.*9224/);
assert.doesNotMatch(browserService, /0\.0\.0\.0.*9224/);
assert.match(browserService, /LANG=zh_CN\.UTF-8/);

const browserInstaller = fs.readFileSync("deploy/install-netease-browser.sh", "utf8");
assert.match(browserInstaller, /playwright-core@1\.62\.1/);
assert.match(browserInstaller, /swapon \/swapfile/);

const serverLogin = fs.readFileSync("tools/server-netease-login.py", "utf8");
assert.match(serverLogin, /finally:/);
assert.match(serverLogin, /rm -f/);

const managedService = fs.readFileSync("deploy/dakings-managed-collection.service", "utf8");
const managedTimer = fs.readFileSync("deploy/dakings-managed-collection.timer", "utf8");
assert.match(managedService, /COLLECTION_SERVICE=http:\/\/127\.0\.0\.1:4173/);
assert.match(managedService, /MANAGED_HANDOFF_LOCAL=1/);
assert.match(managedService, /PLAYWRIGHT_MODULE=.*browser-runtime\/node_modules\/playwright-core/);
assert.match(managedService, /PLAYWRIGHT_MODULE_PATH=.*browser-runtime\/node_modules\/playwright-core/);
assert.doesNotMatch(managedService, /systemctl restart dakings-netease-browser\.service/, "Managed batches must preserve the persistent browser session");
assert.match(managedTimer, /OnCalendar=.*05\/15/);
assert.doesNotMatch(deployer, /enable --now dakings-managed-collection\.timer/, "Managed collection timer must remain disabled until the server canary passes");
assert.doesNotMatch(deployer, /h\.delivery\?\.circuit\?\.open/, "A safely open delivery circuit is valid runtime state and must not block code deployment");
assert.match(server, /\/api\/pipeline\/central-batch\/send/);
assert.match(server, /\/api\/pipeline\/drafts/);
assert.match(server, /status === "batch_review"/);
assert.match(server, /legacy_managed_approval_migrated/);
assert.match(server, /await maybeRecoverDeliveryCircuit\(\)/, "delivery recovery must be checked before health and sends");
assert.match(server, /"hard_bounce",\s+"complaint",/, "quarantined feedback circuits must enter autonomous recovery checks");
assert.match(server, /outbox_sending_or_uncertain/, "circuit recovery must reject active or uncertain outbox state");
assert.match(server, /recipient_not_suppressed/, "feedback target must be quarantined before recovery");
assert.match(server, /deliveryCircuitHistory/, "circuit recoveries must remain auditable");
assert.match(fs.readFileSync("app/pipeline-worker.mjs", "utf8"), /delivery_circuit_requires_intervention/);
assert.match(fs.readFileSync("app/pipeline-worker.mjs", "utf8"), /inventory\.managedCycle\?\.collectionLocked/);
assert.match(server, /status: "circuit_open"/, "a feedback circuit opened during a batch must stop later sends");
assert.match(server, /await transitionOutbox\(outboxEntry, "sending"\);\s+await maybeRecoverDeliveryCircuit\(\);\s+if \(runtimeStateStore\.deliveryCircuit\.open\)/, "SMTP call must be guarded after claiming an outbox entry");
assert.match(server, /managedDiscoveryFloor/);
assert.match(server, /if \(task\.automation\?\.mode === "managed"\) return null;/);
assert.match(server, /managed_runtime_verified_recovery/);
assert.match(server, /function managedDailyCycleState\(/);
assert.match(server, /production_sending_started/);
assert.match(server, /\/api\/managed-cycle\/lock/);
assert.match(server, /今日采集已锁定/);
assert.match(server, /currentSendableCount/);
assert.match(server, /if \(dailyComplete\)[\s\S]{0,500}else if \(circuitOpen\)/, "completed daily work must take precedence over a cooldown-only circuit in the overview");
assert.match(server, /今日发送额度已完成；退信熔断仍在后台冷却/);
assert.doesNotMatch(contactSupervisor, /companyDetailsDaily[^\n]*- used/);
assert.match(server, /function mailboxSenderPriority\(/);
assert.match(server, /type: "managed_plan_replaced"/);
assert.match(frontend, /centralBatchSendButton/);
assert.match(frontend, /overviewManagedPlanForm/);
assert.match(frontend, /renderDrafts/);
assert.match(frontend, /activeQueue\.counts\?\.processed/);
assert.match(frontend, /30_000/);
assert.match(index, /data-view="drafts"/);
assert.match(frontend, /集中批次核验/);

console.log("deployment contract unit passed");
