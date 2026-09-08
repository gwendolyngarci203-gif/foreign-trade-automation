import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { indexValidationResults, prepareManagedPage, registerManagedPlan, validateManagedPlan } from "./managed-hscode-plan.mjs";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(import.meta.dirname, "..");
const isWindows = process.platform === "win32";
const commandArguments = process.argv.slice(2);
const planPath = path.resolve(commandArguments.find((argument) => !argument.startsWith("--")) || "plans/managed-hscode-plan.json");
const handoffOnly = commandArguments.includes("--handoff-only");
const service = (process.env.COLLECTION_SERVICE || "http://127.0.0.1:4174").replace(/\/+$/, "");
const credentialFile = path.resolve(process.env.NETEASE_CREDENTIAL_FILE || "网易外贸通.txt");
const powershell = process.env.POWERSHELL_EXE || "powershell.exe";
const node = process.execPath;
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
const lockPath = path.join(workspace, ".codex_work", "managed-hscode-plan.lock");
const handoffStatePath = path.join(workspace, ".codex_work", "managed-handoff-state.json");
let activeTaskId = "";

async function run(file, args, options = {}) {
  return execFileAsync(file, args, {
    cwd: workspace,
    encoding: "utf8",
    timeout: options.timeout || 30 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, ...(options.env || {}) },
  });
}

async function api(pathname, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${service}${pathname}`, {
        ...options,
        headers: { "content-type": "application/json", ...(options.headers || {}) },
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${pathname} -> ${body.error || `API ${response.status}`}`);
      return body;
    } catch (error) {
      lastError = error;
      const transient = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|socket hang up/i.test(String(error?.message || error));
      if (!transient || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function stageInputReference(sourcePath) {
  const inputRoot = path.resolve(process.env.PIPELINE_INPUT_ROOT || path.join(workspace, "deploy", "runtime-data", "pipeline-inputs"));
  const relative = path.join("managed", "country-business", path.basename(sourcePath));
  const target = path.resolve(inputRoot, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(sourcePath, target);
  return relative.replaceAll("\\", "/");
}

async function validateEnrichment(enrichmentPath) {
  if (!enrichmentPath) return { emails: 0, statusCounts: {}, results: {} };
  const payload = JSON.parse(await fs.readFile(path.join(workspace, enrichmentPath), "utf8"));
  const emails = [...new Set((payload.records || []).map((item) => String(item.email || "").trim().toLowerCase()).filter(Boolean))];
  const counts = {};
  const results = {};
  for (let offset = 0; offset < emails.length; offset += 25) {
    const batch = emails.slice(offset, offset + 25);
    const result = await api("/api/contact-quality/validate", {
      method: "POST",
      body: JSON.stringify({ emails: batch, mode: "domain" }),
    });
    for (const item of result.results || []) counts[item.status] = Number(counts[item.status] || 0) + 1;
    Object.assign(results, indexValidationResults(batch, result.results || []));
  }
  return { emails: emails.length, statusCounts: counts, results };
}

async function qualifyEnrichment(enrichmentPath, validation) {
  if (!enrichmentPath) return { eligible: 0, rejected: 0, reasons: {} };
  const payload = JSON.parse(await fs.readFile(path.join(workspace, enrichmentPath), "utf8"));
  const suppressions = await api("/api/suppressions");
  const suppressed = new Set((suppressions.items || []).map((item) => String(item.fingerprint || "")).filter(Boolean));
  const reasons = {};
  const eligible = [];
  const originalCount = (payload.records || []).length;
  for (const record of payload.records || []) {
    const email = String(record.email || "").trim().toLowerCase();
    const checks = [];
    if (!record.company) checks.push("missing_company");
    if (!/^https?:\/\//i.test(String(record.source || "")) && !record.evidence) checks.push("missing_traceable_source");
    if (validation.results[email]?.status !== "domain_valid") checks.push(`email_${validation.results[email]?.status || "not_checked"}`);
    if (suppressed.has(crypto.createHash("sha256").update(email).digest("hex").slice(0, 12))) checks.push("suppressed");
    if (checks.length) { checks.forEach((reason) => { reasons[reason] = Number(reasons[reason] || 0) + 1; }); continue; }
    eligible.push(record);
  }
  payload.records = eligible;
  payload.counts = { ...(payload.counts || {}), contactRows: eligible.length, qualifiedRows: eligible.length, rejectedRows: originalCount - eligible.length };
  await fs.writeFile(path.join(workspace, enrichmentPath), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { eligible: eligible.length, rejected: originalCount - eligible.length, reasons };
}

async function findDiscoverySnapshot(hsCode, pageNumber) {
  const suffix = `_hscode_${hsCode}_discovery_checkpoint`;
  const fileName = `netease_customs_page_${String(pageNumber).padStart(3, "0")}.json`;
  const directories = await fs.readdir(path.join(workspace, "outputs"), { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const directory of directories.filter((item) => item.isDirectory() && item.name.endsWith(suffix))) {
    const candidate = path.join(workspace, "outputs", directory.name, fileName);
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat) candidates.push({ path: candidate, modifiedAt: stat.mtimeMs });
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  if (!candidates.length) throw new Error(`缺少 HSCode ${hsCode} 第 ${pageNumber} 页发现快照`);
  return candidates[0].path;
}

function businessDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

function manualInterventionAlert(message) {
  const text = String(message || "");
  if (/动作将超过当日预算|预算：(?:buyer_entry|company_detail|qualified_company|contact_page)/i.test(text)) return {
    code: "managed_budget_exhausted",
    title: "托管任务达到当日采集预算",
    instructions: "系统已停止本次交接，不要重复点击或重启网易浏览器；下一次北京时间日切后会自动继续，或先在运行控制查看剩余预算。",
  };
  if (/mandatory credential|session stopped|credential_error|登录|会话/i.test(text)) return {
    code: "netease_login_required",
    title: "网易外贸通需要重新登录",
    instructions: "打开 Codex 项目对话并回复“处理网易登录异常”或“处理网络登录异常”；系统会刷新服务器登录页并生成新的二维码。扫码完成后回复“已登录”，系统自动核验业务页并继续当前批次。不要复用旧二维码；除非系统明确提示页面卡死，不要手工重启服务器上的网易浏览器。",
  };
  if (/captcha|验证码/i.test(text)) return {
    code: "netease_captcha",
    title: "网易外贸通出现验证码",
    instructions: "打开 Codex 项目对话并回复“处理网易验证码”，在当前服务器浏览器会话中完成人机验证。不要重复提交或绕过验证码。",
  };
  if (/\bmfa\b|短信验证|身份验证|二次验证/i.test(text)) return {
    code: "netease_mfa",
    title: "网易外贸通需要身份验证",
    instructions: "打开 Codex 项目对话并回复“处理网易身份验证”，按页面要求完成短信或二次验证；不要修改密码或解绑安全手机。",
  };
  if (/permission|权限|\b403\b/i.test(text)) return {
    code: "netease_permission",
    title: "网易外贸通权限或403异常",
    instructions: "登录网易外贸通确认当前账号仍有海关数据和联系人查询权限，然后在 Codex 项目对话回复“权限已确认”。不要连续重试受限页面。",
  };
  if (/\b429\b|frequent.operation|操作频繁|rate.?limit|频控/i.test(text)) return {
    code: "netease_rate_limited",
    title: "网易外贸通触发频控",
    instructions: "暂时不要人工重复点击或重启浏览器。在 Codex 项目对话回复“处理网易频控”，由系统核对冷却时间和页面状态后恢复。",
  };
  if (/circuit|熔断/i.test(text)) return {
    code: "managed_pipeline_circuit",
    title: "托管流程进入熔断状态",
    instructions: "打开 https://ops.dakingscc.cn/ 查看熔断原因，并在 Codex 项目对话回复“处理托管熔断”。查明原因前不要手工解除熔断或重复发送。",
  };
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|网络|连接超时/i.test(text)) return {
    code: "managed_network_failure",
    title: "托管任务网络或服务连接异常",
    instructions: "打开 https://ops.dakingscc.cn/ 查看健康状态和托管任务日志；确认服务器网络、应用服务与网易页面仍在线后，在 Codex 项目对话回复“处理托管网络异常”。不要重复启动多个托管任务。",
  };
  return null;
}

function safetySignalForAlert(alert) {
  return {
    netease_login_required: "permission",
    netease_captcha: "captcha",
    netease_mfa: "permission",
    netease_permission: "permission",
    netease_rate_limited: "frequent_operation",
  }[alert?.code] || "";
}

async function openManagedCircuit(alert, details) {
  const signal = safetySignalForAlert(alert);
  if (!activeTaskId || !signal) return null;
  try {
    const updated = await api(`/api/ops/tasks/${activeTaskId}/actions`, {
      method: "POST",
      body: JSON.stringify({
        type: "checkpoint",
        count: 1,
        signal,
        checkpoint: { page: 0, extracted: 0, note: `托管运行门异常：${String(details || "").slice(0, 300)}` },
      }),
    });
    return { signal, incidentId: `${activeTaskId}:${updated.updatedAt || new Date().toISOString()}` };
  } catch (error) {
    // An already-open circuit is the expected idempotent retry outcome.
    if (!/任务已熔断|423|CIRCUIT_OPEN/i.test(String(error.message || ""))) {
      console.error(`托管任务熔断状态写入失败：${error.message}`);
    }
    return null;
  }
}

async function ensureLoggedIn() {
  if (isWindows) {
    await run(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(workspace, "tools", "start-netease-collection-runtime.ps1"), "-SkipPageValidation"], { timeout: 90_000 });
  }
  try {
    await run(node, [path.join(workspace, "tools", "netease-cdp-client.mjs"), "ready-target"], { timeout: 45_000 });
  } catch (error) {
    try {
      await run(node, [path.join(workspace, "tools", "netease-cdp-client.mjs"), "ensure-business-page"], { timeout: 95_000 });
      await run(node, [path.join(workspace, "tools", "netease-cdp-client.mjs"), "ready-target"], { timeout: 45_000 });
      return;
    } catch {}
    if (!isWindows) throw new Error("NetEase server session stopped at a mandatory credential, CAPTCHA, permission, or MFA gate");
    await fs.access(credentialFile);
    const login = await run(node, [path.join(workspace, "tools", "netease-cdp-client.mjs"), "login-from-file", credentialFile], { timeout: 90_000 });
    const result = JSON.parse(login.stdout);
    if (!["success", "logged_in"].includes(result.status)) throw new Error(`NetEase login stopped at mandatory gate: ${result.status}`);
    await run(node, [path.join(workspace, "tools", "netease-cdp-client.mjs"), "ensure-business-page"], { timeout: 95_000 });
    await run(node, [path.join(workspace, "tools", "netease-cdp-client.mjs"), "ready-target"], { timeout: 45_000 });
  }
}

function queuePage(queue) {
  return Number.parseInt(String(queue.key || "").match(/_page_(\d+)$/)?.[1] || "0", 10);
}

async function acquireManagedLock() {
  try {
    return await fs.open(lockPath, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner = null;
    try { owner = JSON.parse(await fs.readFile(lockPath, "utf8")); } catch {}
    const pid = Number(owner?.pid || 0);
    if (!pid) {
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs < 5 * 60_000) return null;
    }
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = true; } catch {}
    }
    if (alive) return null;
    await fs.rm(lockPath, { force: true });
    return fs.open(lockPath, "wx");
  }
}

async function writeEnrichment(queue, item, pageNumber, queueItems, handoffKey) {
  const records = [];
  for (const queueItem of queueItems) {
    const references = queueItem.contactArtifacts?.length ? queueItem.contactArtifacts : [queueItem.artifactReference];
    for (const reference of references.filter(Boolean)) {
      const artifactPath = path.resolve(workspace, reference);
      const relative = path.relative(workspace, artifactPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("联系人产物越出工作区");
      const artifact = JSON.parse(await fs.readFile(artifactPath, "utf8"));
      for (const result of Array.isArray(artifact.rawResults) ? artifact.rawResults : []) {
        for (const contact of Array.isArray(result.contacts) ? result.contacts : []) {
        const evidenceSources = [result.company?.website, contact.linkedin, contact.source]
          .map((value) => String(value || "").trim())
          .filter((value) => /^https?:\/\//i.test(value));
          records.push({
          company: queueItem.companyName,
          name: String(contact.name || "").trim(),
          title: String(contact.title || "").trim(),
          email: String(contact.email || "").trim().toLowerCase(),
          phone: String(contact.phone || "").trim(),
          linkedin: String(contact.linkedin || "").trim(),
          source: String(contact.source || "NetEase visible company result").trim(),
          evidence: relative.replaceAll("\\", "/"),
          evidenceSources: [...new Set(evidenceSources)].slice(0, 5),
          });
        }
      }
    }
  }
  const outputDir = path.join(workspace, "outputs", `${businessDate().replaceAll("-", "")}_hscode_${item.hsCode}_managed`);
  const outputPath = path.join(outputDir, `netease_contact_enrichment_page_${String(pageNumber).padStart(3, "0")}_${handoffKey}.json`);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: "netease-contact-enrichment",
    planId: queue.key.split(`_${item.hsCode}_page_`)[0],
    hsCode: item.hsCode,
    pageNumber,
    handoffKey,
    capturedAt: new Date().toISOString(),
    counts: {
      companiesProcessed: queueItems.length,
      contactRows: records.length,
    },
    records,
  }, null, 2)}\n`, "utf8");
  return path.relative(workspace, outputPath).replaceAll("\\", "/");
}

async function readHandoffState() {
  return JSON.parse(await fs.readFile(handoffStatePath, "utf8").catch(() => '{"version":1,"queues":{}}'));
}

async function writeHandoffState(state) {
  await fs.mkdir(path.dirname(handoffStatePath), { recursive: true });
  const temporary = `${handoffStatePath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(temporary, handoffStatePath);
}

async function handoffToServer(snapshotPath, enrichmentPath) {
  if (!enrichmentPath) return null;
  const python = process.env.PYTHON_EXE || (isWindows
    ? await fs.access(bundledPython).then(() => bundledPython).catch(() => "python")
    : "/usr/bin/python3");
  const args = [path.join(workspace, "tools", "handoff-managed-pipeline.py"), snapshotPath, path.join(workspace, enrichmentPath)];
  if (!isWindows || process.env.MANAGED_HANDOFF_LOCAL === "1") args.push("--local");
  const result = await run(python, args, {
    timeout: 35 * 60_000,
    env: { PYTHONPATH: path.join(workspace, ".codex_work", "python_deps") },
  });
  return JSON.parse(result.stdout.trim());
}

async function handoffCompleted(queue, item, pageNumber, snapshotPath) {
  if (queue.safetyState === "CIRCUIT_OPEN") return null;
  const state = await readHandoffState();
  const handedOff = new Set(state.queues?.[queue.id] || []);
  const queueItems = (queue.items || []).filter((candidate) => {
    if (candidate.status !== "completed") return false;
    const references = candidate.contactArtifacts?.length ? candidate.contactArtifacts : [candidate.artifactReference];
    return references.some((reference) => reference && !handedOff.has(`${candidate.id}:${reference}`)
      && !(handedOff.has(candidate.id) && references.length === 1));
  });
  if (!queueItems.length) return null;
  const handoffKey = crypto.createHash("sha256").update(queueItems.map((candidate) => candidate.id).sort().join("\n")).digest("hex").slice(0, 12);
  const enrichmentPath = await writeEnrichment(queue, item, pageNumber, queueItems, handoffKey);
  const validation = await validateEnrichment(enrichmentPath);
  const qualification = await qualifyEnrichment(enrichmentPath, validation);
  const serverHandoff = qualification.eligible ? await handoffToServer(snapshotPath, enrichmentPath) : null;
  state.version = 1;
  state.queues ||= {};
  const handedOffKeys = queueItems.flatMap((candidate) => {
    const references = candidate.contactArtifacts?.length ? candidate.contactArtifacts : [candidate.artifactReference];
    return references.filter(Boolean).map((reference) => `${candidate.id}:${reference}`);
  });
  state.queues[queue.id] = [...new Set([...(state.queues[queue.id] || []), ...handedOffKeys])];
  await writeHandoffState(state);
  return { enrichmentPath, handoffKey, itemIds: queueItems.map((candidate) => candidate.id), validation: { emails: validation.emails, statusCounts: validation.statusCounts }, qualification, serverHandoff };
}

async function readSendInventory(plan) {
  const batch = await api("/api/pipeline/daily-batch?limit=1000&reserve=1&central=1");
  const selected = Array.isArray(batch.selected) ? batch.selected.length : 0;
  const companies = new Set((batch.selected || [])
    .map((item) => String(item.company || "").trim().toLowerCase())
    .filter(Boolean));
  const dailyRemaining = Number(batch.remaining);
  const senderRemaining = Number(batch.senderCapacity?.remaining);
  const target = Math.min(
    plan.dailyBudgets.emailSends,
    Number.isFinite(dailyRemaining) ? Math.max(dailyRemaining, 0) : plan.dailyBudgets.emailSends,
    Number.isFinite(senderRemaining) ? Math.max(senderRemaining, 0) : plan.dailyBudgets.emailSends,
  );
  return {
    selected,
    companyCount: Number(batch.inventory?.totalCompanies ?? companies.size),
    previousRemainingCompanies: Number(batch.inventory?.previousRemainingCompanies || 0),
    todayQualifiedCompanies: Number(batch.inventory?.todayQualifiedCompanies || 0),
    companyTarget: Number(batch.inventory?.target || plan.dailyBudgets.validEmailCompanies || 100),
    target,
    gap: Math.max(target - selected, 0),
    ready: selected >= target,
    batch,
  };
}

async function lockIfInventoryReached(plan, taskId, today, inventory, extra = {}) {
  const companyTarget = Number(plan.dailyBudgets.validEmailCompanies || 100);
  if (inventory.companyCount < companyTarget) return false;
  const cycle = await api("/api/managed-cycle/lock", {
    method: "POST",
    body: JSON.stringify({ confirm: "LOCK MANAGED COLLECTION" }),
  });
  console.log(JSON.stringify({
    action: "managed_inventory_full",
    reason: "qualified_company_target_reached",
    planId: plan.planId,
    taskId,
    businessDate: today,
    ...extra,
    managedCycle: cycle,
    inventory: { selected: inventory.selected, companyCount: inventory.companyCount, companyTarget, target: inventory.target, gap: inventory.gap },
  }));
  return true;
}

async function main() {
  const plan = validateManagedPlan(JSON.parse(await fs.readFile(planPath, "utf8")));
  if (plan.collectionMode === "country_business") {
    const profile = plan.marketTargetProfile;
    const today = businessDate();
    const outputDir = path.join(workspace, "outputs", `${today.replaceAll("-", "")}_country_business_discovery_checkpoint`);
    await run(node, [path.join(workspace, "tools", "netease-country-business-discovery.mjs"), profile.country,
      profile.industryKeywords.join(","), profile.direction, "1", outputDir, profile.excludeKeywords.join(",")], { timeout: 120_000 });
    const artifact = path.join(outputDir, "netease_country_business_page_001.json");
    await registerManagedPlan(plan, service);
    const python = process.env.PYTHON_EXE || (isWindows ? await fs.access(bundledPython).then(() => bundledPython).catch(() => "python") : "/usr/bin/python3");
    const result = await run(python, [path.join(workspace, "tools", "handoff-managed-pipeline.py"), artifact, "--plan", planPath, "--local"], { timeout: 35 * 60_000 });
    console.log(JSON.stringify({ action: "country_business_pipeline", collectionMode: "country_business", artifact, handoff: JSON.parse(result.stdout.trim()), stopAfter: "buyer_matching" }));
    return;
  }
  if (plan.hsCodes.length !== 1) throw new Error("当前桌面托管执行器每次只运行一个 HSCode");
  const item = plan.hsCodes[0];
  const registration = await registerManagedPlan(plan, service);
  const taskId = registration.results[0].taskId;
  activeTaskId = taskId;
  const task = await api(`/api/ops/tasks/${taskId}`);
  const today = businessDate();
  const managedCycle = await api("/api/managed-cycle");
  if (managedCycle.collectionLocked) {
    console.log(JSON.stringify({ action: "managed_daily_collection_locked", planId: plan.planId, taskId, businessDate: today, managedCycle }));
    return;
  }
  const queues = (await api("/api/contact-queues")).items
    .filter((queue) => String(queue.key || "").startsWith(`${plan.planId}_${item.hsCode}_page_`))
    .sort((left, right) => queuePage(right) - queuePage(left));
  const latestQueue = queues[0];
  const latestPage = latestQueue ? queuePage(latestQueue) : 0;
  const latestSnapshot = latestQueue ? await findDiscoverySnapshot(item.hsCode, latestPage) : "";
  const latestCurrent = latestQueue ? await api(`/api/contact-queues/${latestQueue.id}?items=1`) : null;
  const latestHandoff = latestCurrent ? await handoffCompleted(latestCurrent, item, latestPage, latestSnapshot) : null;
  if (handoffOnly) {
    console.log(JSON.stringify({ action: "managed_handoff_check", planId: plan.planId, taskId, queueId: latestQueue?.id || "", pageNumber: latestPage, handoff: latestHandoff }));
    return;
  }
  const initialInventory = await readSendInventory(plan);
  if (await lockIfInventoryReached(plan, taskId, today, initialInventory)) return;
  const reprocessPage = Number.parseInt(process.env.MANAGED_REPROCESS_PAGE || "0", 10);
  let queue = reprocessPage > 0
    ? queues.find((candidate) => queuePage(candidate) === reprocessPage)
    : queues.find((candidate) => Number(candidate.counts?.pending || 0) > 0);
  if (reprocessPage > 0 && !queue) throw new Error(`缺少待重处理的第 ${reprocessPage} 页联系人队列`);
  // Prefer the latest completed queue as the durable progress marker. Older
  // tasks can retain a zero checkpoint after a handoff; restarting from that
  // value re-runs the same completed page forever and never grows inventory.
  let pageNumber = queue
    ? queuePage(queue)
    : Math.max(item.startPage, latestPage + 1, Number(task.checkpoint?.page || 0) + 1);
  let snapshotPath = queue ? await findDiscoverySnapshot(item.hsCode, pageNumber) : "";
  let priorHandoff = queue?.id === latestQueue?.id ? latestHandoff : null;
  if (queue) {
    if (queue.id !== latestQueue?.id) {
      const current = await api(`/api/contact-queues/${queue.id}?items=1`);
      priorHandoff = await handoffCompleted(current, item, pageNumber, snapshotPath);
    }
  }
  const queueInventory = await readSendInventory(plan);
  if (await lockIfInventoryReached(plan, taskId, today, queueInventory, { pageNumber, priorHandoff })) return;
  await ensureLoggedIn();
  const verifiedTask = await api(`/api/ops/tasks/${taskId}`);
  if (verifiedTask.safetyState === "CIRCUIT_OPEN") {
    await api(`/api/ops/tasks/${taskId}/recover`, {
      method: "POST",
      body: JSON.stringify({ verification: "netease_business_page_ready" }),
    });
  }
  while (!queue) {
    const inventoryBeforeDiscovery = await readSendInventory(plan);
    if (await lockIfInventoryReached(plan, taskId, today, inventoryBeforeDiscovery, { pageNumber })) return;
    const outputDir = path.join(workspace, "outputs", `${today.replaceAll("-", "")}_hscode_${item.hsCode}_discovery_checkpoint`);
    await run(node, [path.join(workspace, "tools", "netease-hscode-discovery.mjs"), item.hsCode, String(pageNumber), outputDir], { timeout: 120_000 });
    snapshotPath = path.join(outputDir, `netease_customs_page_${String(pageNumber).padStart(3, "0")}.json`);
    const prepared = await prepareManagedPage(plan, snapshotPath, service);
    if (prepared.queueId) {
      queue = await api(`/api/contact-queues/${prepared.queueId}`);
      break;
    }
    pageNumber += 1;
  }
  if (!snapshotPath) snapshotPath = await findDiscoverySnapshot(item.hsCode, pageNumber);

  const execution = await run(node, [path.join(workspace, "tools", "netease-contact-supervisor.mjs")], {
    env: { COLLECTION_SERVICE: service, COLLECTION_QUEUE_ID: queue.id, OPERATION_TASK_ID: taskId, OPERATION_PAGE: String(pageNumber) },
  });
  const after = await api(`/api/contact-queues/${queue.id}?items=1`);
  const handoff = await handoffCompleted(after, item, pageNumber, snapshotPath);
  console.log(JSON.stringify({ action: "managed_cycle", planId: plan.planId, taskId, queueId: queue.id, pageNumber, priorHandoff, handoff, supervisor: JSON.parse(execution.stdout.trim()) }));
}

let lock;
try {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  lock = await acquireManagedLock();
  if (!lock) {
    console.log(JSON.stringify({ action: "skip_managed_runner_locked" }));
  } else {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await main();
  }
} catch (error) {
  if (error.code === "EEXIST") console.log(JSON.stringify({ action: "skip_managed_runner_locked" }));
  else {
    const alert = manualInterventionAlert(error.message);
    if (alert) {
      try {
        const circuit = await openManagedCircuit(alert, error.message);
        const notified = await api("/api/ops/intervention-alert", {
          method: "POST",
          body: JSON.stringify({ ...alert, details: error.message, ...(circuit?.incidentId ? { incidentId: circuit.incidentId } : {}) }),
        });
        console.error(JSON.stringify({ action: "intervention_alert", code: alert.code, status: notified.status, duplicate: notified.duplicate }));
      } catch (alertError) {
        console.error(`人工介入告警邮件发送失败：${alertError.message}`);
      }
    }
    console.error(error.message);
    process.exitCode = 1;
  }
} finally {
  await lock?.close().catch(() => {});
  if (lock) await fs.rm(lockPath, { force: true }).catch(() => {});
}
