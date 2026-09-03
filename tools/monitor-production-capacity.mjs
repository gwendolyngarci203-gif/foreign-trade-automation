import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const apiBase = String(process.env.PIPELINE_API_BASE || "http://127.0.0.1:4173").replace(/\/+$/, "");
const statePath = path.resolve(process.env.CAPACITY_MONITOR_STATE || "/opt/dakings-prospect-ops/deploy/runtime-data/capacity-monitor.json");
const now = new Date();
const managedCollectionExpectedEveryMinutes = Math.max(1, Number(process.env.COLLECTION_TIMER_MINUTES || 10));

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) }, signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `API ${response.status}`);
  return body;
}

async function browserState() {
  try {
    const pages = await (await fetch("http://127.0.0.1:9224/json/list", { signal: AbortSignal.timeout(5_000) })).json();
    const sessionPresent = pages.some((page) => /waimao\.office\.163\.com/.test(page.url || ""));
    let output = "";
    try {
      ({ stdout: output } = await execFileAsync(process.execPath, [path.join(import.meta.dirname, "netease-cdp-client.mjs"), "inspect"], {
        encoding: "utf8", timeout: 20_000, env: { ...process.env, EDGE_CDP_ENDPOINT: "http://127.0.0.1:9224" },
      }));
    } catch (error) { output = error.stdout || ""; }
    const inspected = JSON.parse(output || "{}");
    return { connected: true, sessionPresent, authenticated: Boolean(inspected.readyTargetId) };
  } catch { return { connected: false, sessionPresent: false }; }
}

async function collectionServiceState() {
  try {
    const { stdout } = await execFileAsync("systemctl", ["show", "dakings-managed-collection.service", "-p", "Result", "-p", "ExecMainStatus", "--no-pager"], { encoding: "utf8", timeout: 5_000 });
    return { healthy: /Result=success/.test(stdout) && /ExecMainStatus=0/.test(stdout), detail: stdout.trim().replace(/\s+/g, " ") };
  } catch (error) { return { healthy: false, detail: String(error.message || error).slice(0, 300) }; }
}

function queueMetrics(queues) {
  const relevant = queues.filter((queue) => String(queue.key || "").startsWith("managed-country-business-"));
  const audits = relevant.flatMap((queue) => queue.audit || []).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const completed = audits.filter((entry) => entry.type === "batch_completed");
  const claimed = new Map(audits.filter((entry) => entry.type === "batch_claimed").map((entry) => [entry.batchId, entry]));
  const durations = completed.map((entry) => Date.parse(entry.at) - Date.parse(claimed.get(entry.batchId)?.at || entry.at)).filter((value) => value >= 0);
  const failures = {};
  for (const entry of completed) {
    const reason = entry.severeSignal && entry.severeSignal !== "none" ? entry.severeSignal
      : entry.controlErrors ? "control_error" : entry.structureSignals ? "structure_error" : "success";
    failures[reason] = Number(failures[reason] || 0) + 1;
  }
  let consecutiveFailures = 0;
  for (const entry of [...completed].reverse()) {
    if (!entry.controlErrors && !entry.structureSignals && (!entry.severeSignal || entry.severeSignal === "none")) break;
    consecutiveFailures += 1;
  }
  const firstAt = relevant.map((queue) => Date.parse(queue.createdAt)).filter(Number.isFinite).sort()[0];
  const hours = firstAt ? Math.max((now.getTime() - firstAt) / 3_600_000, 1 / 60) : 0;
  const companies = relevant.reduce((sum, queue) => sum + Number(queue.counts?.completed || 0), 0);
  const rows = relevant.reduce((sum, queue) => sum + Number(queue.counts?.contactRows || 0), 0);
  return {
    queues: relevant.map((queue) => ({ id: queue.id, key: queue.key, status: queue.status, safetyState: queue.safetyState, counts: queue.counts, updatedAt: queue.updatedAt })),
    companiesPerHour: hours ? Number((companies / hours).toFixed(2)) : 0,
    contactRowsPerHour: hours ? Number((rows / hours).toFixed(2)) : 0,
    averageResponseMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    successRate: completed.length ? Number(((Number(failures.success || 0) / completed.length) * 100).toFixed(2)) : null,
    failureReasons: Object.fromEntries(Object.entries(failures).filter(([key]) => key !== "success")),
    consecutiveFailures,
    lastSuccessAt: [...completed].reverse().find((entry) => !entry.controlErrors && !entry.structureSignals && (!entry.severeSignal || entry.severeSignal === "none"))?.at || null,
    remaining: relevant.reduce((sum, queue) => sum + Number(queue.counts?.remaining || 0), 0),
  };
}

async function alertOnce(state, code, title, details, instructions) {
  const day = now.toISOString().slice(0, 10);
  const key = `${day}:${code}`;
  if (state.alerts?.[key]) return;
  try {
    await api("/api/ops/intervention-alert", { method: "POST", body: JSON.stringify({ code, incidentId: day, title, details, instructions }) });
    state.alerts ||= {};
    state.alerts[key] = now.toISOString();
  } catch (error) {
    state.lastAlertError = String(error.message || error).slice(0, 500);
  }
}

const [pool, queues, health, browser, collectionService] = await Promise.all([api("/api/contact-pool"), api("/api/contact-queues"), api("/api/health"), browserState(), collectionServiceState()]);
const previous = JSON.parse(await fs.readFile(statePath, "utf8").catch(() => "{\"snapshots\":[],\"alerts\":{}}"));
const snapshots = (previous.snapshots || []).filter((item) => Date.parse(item.at) >= now.getTime() - 31 * 86_400_000);
const oldest24h = snapshots.find((item) => Date.parse(item.at) >= now.getTime() - 86_400_000) || snapshots[0];
const lastGrowth = [...snapshots].reverse().find((item) => Number(item.available || 0) !== Number(pool.available || 0));
const stagnantHours = lastGrowth ? (now.getTime() - Date.parse(lastGrowth.at)) / 3_600_000 : snapshots.length ? (now.getTime() - Date.parse(snapshots[0].at)) / 3_600_000 : 0;
const dailyGrowth = oldest24h ? pool.available - Number(oldest24h.available || 0) : 0;
const hours = oldest24h ? Math.max((now.getTime() - Date.parse(oldest24h.at)) / 3_600_000, 1 / 60) : 0;
const growthPerDay = hours ? Number((dailyGrowth / hours * 24).toFixed(2)) : 0;
const dailyConsumed = Number(health.delivery?.daily?.used || 0);
const netDailyGrowth = growthPerDay - dailyConsumed;
const etaDays = netDailyGrowth > 0 ? Number((pool.gap / netDailyGrowth).toFixed(2)) : null;
const collection = queueMetrics(queues.items || []);
const report = {
  schemaVersion: 1, checkedAt: now.toISOString(), inventory: { ...pool, growth24h: dailyGrowth, projectedDailyGrowth: growthPerDay, dailyConsumption: dailyConsumed, netDailyGrowth, etaDays, stagnantHours: Number(stagnantHours.toFixed(2)) },
  collection: { ...collection, service: collectionService, mode: pool.gap <= 0 ? "maintenance" : collection.remaining > 0 ? "collecting" : "replenishing" },
  login: { ...browser, status: browser.connected && browser.sessionPresent && browser.authenticated && !collection.queues.some((queue) => queue.safetyState === "CIRCUIT_OPEN") ? "authenticated" : "attention_required" },
  timers: { managedCollectionExpectedEveryMinutes, pipelineWorkerExpectedEveryMinutes: 2 },
};
previous.collectionServiceConsecutiveFailures = collectionService.healthy ? 0 : Number(previous.collectionServiceConsecutiveFailures || 0) + 1;
previous.snapshots = [...snapshots, { at: report.checkedAt, available: pool.available, sent: pool.counts?.SENT || 0, companiesPerHour: collection.companiesPerHour }].slice(-3000);
previous.latest = report;
previous.alerts ||= {};
if (collection.consecutiveFailures > 3) await alertOnce(previous, "collection_failed_3", "采集连续失败超过3次", `当前库存：${pool.available}；最近24小时增长：${dailyGrowth}；失败分布：${JSON.stringify(collection.failureReasons)}`, "检查网易会话和采集队列；修复后定时器会自动重试。");
if (previous.collectionServiceConsecutiveFailures > 3) await alertOnce(previous, "collection_service_failed_3", "自动采集服务连续失败超过3次", `当前库存：${pool.available}；服务状态：${collectionService.detail}`, "检查网易登录、验证码和自动补充 discovery；恢复后定时器会自动继续。");
if (report.login.status === "attention_required") await alertOnce(previous, "netease_login_invalid", "网易登录状态失效", `当前库存：${pool.available}；浏览器连接：${browser.connected}；会话页：${browser.sessionPresent}`, "重新扫码登录服务器网易会话；登录后无需手工重跑。");
for (const threshold of [3000, 5000]) if (pool.available >= threshold) await alertOnce(previous, `inventory_${threshold}`, `联系人库存达到${threshold}`, `当前库存：${pool.available}；最近24小时增长：${dailyGrowth}；预计日净增长：${netDailyGrowth}`, "无需介入；继续观察库存和每日消耗。");
const priorRates = snapshots.map((item) => Number(item.companiesPerHour || 0)).filter((value) => value > 0);
if (collection.remaining > 0 && priorRates.length >= 4 && collection.companiesPerHour < Math.max(...priorRates) * 0.5) await alertOnce(previous, "collection_speed_drop_50", "采集速度下降超过50%", `当前速度：${collection.companiesPerHour}家公司/小时；近期基线：${Math.max(...priorRates)}家公司/小时。`, "检查响应时间、登录状态和失败分布；系统会自动退避，不要手工提高并发。");
if (pool.gap > 0 && stagnantHours >= 6) await alertOnce(previous, "inventory_no_growth_6h", "联系人库存连续6小时没有增长", `当前库存：${pool.available}；目标：${pool.target}；缺口：${pool.gap}；停滞：${stagnantHours.toFixed(1)}小时。`, "检查自动补充队列、网易登录状态和最近失败分布；修复后定时器会自动继续。");
await fs.mkdir(path.dirname(statePath), { recursive: true });
await fs.writeFile(statePath, `${JSON.stringify(previous, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report));
