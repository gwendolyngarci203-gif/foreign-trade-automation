import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(import.meta.dirname, "..");
const isWindows = process.platform === "win32";
const node = process.execPath;
const powershell = process.env.POWERSHELL_EXE || "powershell.exe";
const service = process.env.COLLECTION_SERVICE || "http://127.0.0.1:4174";
const queueId = process.env.COLLECTION_QUEUE_ID || "collection_e977e59e-8f24-408b-9076-ebcc3bac9f93";
const operationTaskId = String(process.env.OPERATION_TASK_ID || "").trim();
const operationPage = Math.max(0, Number.parseInt(process.env.OPERATION_PAGE || "0", 10) || 0);
const minimumCooldownMinutes = Math.max(15, Number.parseInt(process.env.COLLECTION_MIN_COOLDOWN_MINUTES || "30", 10) || 30);
const maximumCooldownMinutes = Math.max(minimumCooldownMinutes, Number.parseInt(process.env.COLLECTION_MAX_COOLDOWN_MINUTES || "180", 10) || 180);
const minimumBatchGapMinutes = Math.max(5, Number.parseInt(process.env.COLLECTION_MIN_BATCH_GAP_MINUTES || "10", 10) || 10);
const requestedRunLimit = Number.parseInt(process.env.MANAGED_RUN_LIMIT || "", 10);
const managedRunLimit = Number.isInteger(requestedRunLimit)
  ? Math.max(1, Math.min(requestedRunLimit, 20))
  : 20;
const cooldownSteps = [30, 45, 60, 90, 120, 180]
  .map((minutes) => Math.min(maximumCooldownMinutes, Math.max(minimumCooldownMinutes, minutes)))
  .filter((minutes, index, values) => index === 0 || minutes !== values[index - 1]);
const severeSignals = new Set(["captcha", "frequent_operation", "permission", "http_403", "http_429"]);
const statePath = path.join(workspace, ".codex_work", "netease-supervisor-state.json");
const lockPath = path.join(workspace, ".codex_work", "netease-supervisor.lock");

async function acquireSupervisorLock() {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      return async () => {
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      let owner = null;
      try { owner = JSON.parse(await fs.readFile(lockPath, "utf8")); } catch {}
      let ownerAlive = false;
      const ownerPid = Number(owner?.pid || 0);
      if (Number.isInteger(ownerPid) && ownerPid > 0) {
        try { process.kill(ownerPid, 0); ownerAlive = true; } catch {}
      }
      const stale = stat && Date.now() - stat.mtimeMs > 45 * 60_000;
      const deadOwner = Boolean(owner?.pid) && !ownerAlive;
      if ((!stale && !deadOwner) || attempt === 1) return null;
      await fs.rm(lockPath, { force: true });
    }
  }
  return null;
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch {
    return { version: 2, lastBoundaryAt: "", strikes: 0, safeCompletions: 0, completedAtBoundary: 0, lastRunAt: "" };
  }
}

async function writeState(state) {
  await fs.writeFile(statePath, `${JSON.stringify({ version: 2, ...state }, null, 2)}\n`, "utf8");
}

function cooldownMinutesFor(strikes) {
  return cooldownSteps[Math.min(cooldownSteps.length - 1, Math.max(0, strikes - 1))];
}

function recordBoundary(state, queue) {
  const completed = Number(queue.counts?.completed || 0);
  const legacyProgress = Number(state.safeCompletions || 0);
  const previousBoundaryCompleted = Number(state.completedAtBoundary || 0);
  const progressSinceBoundary = previousBoundaryCompleted > 0
    ? Math.max(0, completed - previousBoundaryCompleted)
    : legacyProgress;

  // The 2026-08-14 production run showed that a 35-minute pause recovered
  // successfully for 22 companies. Treat >=20 safe completions as a recovered
  // window and return to the short probe. Escalate only when the platform
  // re-limits almost immediately after recovery.
  if (!state.lastBoundaryAt) state.strikes = 1;
  else if (progressSinceBoundary >= 20) state.strikes = 1;
  else if (progressSinceBoundary < 5) state.strikes = Math.min(cooldownSteps.length, Math.max(1, Number(state.strikes || 1)) + 1);
  else state.strikes = Math.max(1, Number(state.strikes || 1));

  state.lastBoundaryAt = queue.lastBoundary.at;
  state.completedAtBoundary = completed;
  state.safeCompletions = 0;
  return progressSinceBoundary;
}

async function api(pathname, options = {}) {
  const response = await fetch(`${service}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json; charset=utf-8", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`API ${response.status}: ${body.error || pathname}`);
  return body;
}

async function run(file, args, options = {}) {
  return execFileAsync(file, args, {
    cwd: options.cwd || workspace,
    encoding: "utf8",
    timeout: options.timeout || 30 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
}

async function ensureRuntimeReady({ reload = false } = {}) {
  if (isWindows) {
    await run(powershell, [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", path.join(workspace, "tools", "start-netease-collection-runtime.ps1"),
    ], { timeout: 90_000 });
  }
  if (reload) {
    // Refresh once after cooldown. Never use a reload loop to hide or hammer a
    // platform boundary; the following fixed-element inspection and canary are
    // the actual recovery checks.
    await run(node, [path.join(workspace, "tools", "netease-cdp-client.mjs"), "reload-ready"], { timeout: 45_000 });
  }
  const { stdout } = await run(node, [path.join(workspace, "tools", "netease-cdp-client.mjs"), "inspect"], { timeout: 45_000 });
  const inspection = JSON.parse(stdout);
  const ready = inspection.pages?.find((page) => page.targetId === inspection.readyTargetId)?.state;
  if (!ready?.businessReady || ready.checks?.captcha || ready.checks?.rateLimited || ready.checks?.accountError) {
    throw new Error("NetEase page failed fixed-element or safety inspection");
  }
}

async function rebuildWorkbook() {
  const builderDir = path.join(workspace, "tmp", "contacts_workbook_20260811");
  const builder = path.join(builderDir, "build_all_contacts_20260813.mjs");
  try {
    await fs.access(builder);
  } catch {
    return false;
  }
  await run(node, [builder], { cwd: builderDir, timeout: 10 * 60 * 1000 });
  return true;
}

async function managedBudget(queue) {
  const remaining = operationTaskId ? Number(queue.counts?.remaining || 0) : 20;
  return Math.max(0, Math.min(managedRunLimit, remaining));
}

async function recordManagedCompletions(queue) {
  if (!operationTaskId) return 0;
  let recorded = 0;
  for (const item of (queue.items || []).filter((candidate) => candidate.status === "completed")) {
    const base = `${queue.id}:${item.id}`;
    const pageKey = `${base}:contact-page:${Number(item.contactPage || 0)}`;
    const checkpoint = { company: item.companyName, page: operationPage, extracted: item.contactRows, note: `managed queue ${queue.id}` };
    const actions = [
      { type: "company_search", count: 1, key: `${base}:company_search` },
      { type: "company_detail", count: 1, key: `${base}:company_detail` },
      { type: "contact_page", count: Number(item.contactPage || 0) > 0 ? 1 : 0, key: pageKey },
      { type: "raw_contact_row", count: Number(item.lastContactRowsDelta || 0), key: `${pageKey}:rows` },
    ];
    for (const action of actions) {
      if (action.count < 1) continue;
      await api(`/api/ops/tasks/${operationTaskId}/actions`, {
        method: "POST",
        body: JSON.stringify({ type: action.type, count: action.count, signal: "none", idempotencyKey: action.key, checkpoint }),
      });
    }
    recorded += 1;
  }
  return recorded;
}

async function main() {
  let before = await api(`/api/contact-queues/${queueId}?items=1`);
  const reconciledCompletions = await recordManagedCompletions(before);
  const state = await readState();
  const failedIds = (before.items || []).filter((item) => item.status === "failed").map((item) => item.id).sort();
  const failedSignature = failedIds.join(",");
  const retriedSignatures = new Set(Array.isArray(state.retriedFailedSignatures) ? state.retriedFailedSignatures : []);
  if (before.counts.remaining === 0 && failedIds.length && !retriedSignatures.has(failedSignature)) {
    await api(`/api/contact-queues/${queueId}/retry-failed`, {
      method: "POST",
      body: JSON.stringify({ confirm: `RETRY FAILED ${queueId}`, itemIds: failedIds }),
    });
    retriedSignatures.add(failedSignature);
    state.retriedFailedSignatures = [...retriedSignatures].slice(-20);
    await writeState(state);
    before = await api(`/api/contact-queues/${queueId}?items=1`);
  }
  if (before.counts.remaining === 0) {
    const workbookRebuilt = await rebuildWorkbook();
    console.log(JSON.stringify({ action: "complete", counts: before.counts, workbookRebuilt, managedCompletionsRecorded: reconciledCompletions }));
    return;
  }

  if (before.status === "running" || before.counts.leased > 0) {
    console.log(JSON.stringify({ action: "skip_active_lease", counts: before.counts, activeBatchId: before.activeBatchId }));
    return;
  }

  let budget = await managedBudget(before);
  if (budget < 1) {
    console.log(JSON.stringify({ action: "daily_budget_exhausted", taskId: operationTaskId, counts: before.counts }));
    return;
  }
  if (before.status === "circuit_open") {
    const boundaryAt = Date.parse(before.lastBoundary?.at || "");
    const severe = severeSignals.has(before.lastBoundary?.signal);
    let progressSinceBoundary = Number(state.safeCompletions || 0);
    if (severe && before.lastBoundary?.at && state.lastBoundaryAt !== before.lastBoundary.at) {
      progressSinceBoundary = recordBoundary(state, before);
      await writeState(state);
    }
    const cooldownMinutes = cooldownMinutesFor(Math.max(1, state.strikes));
    const cooldownMs = cooldownMinutes * 60_000;
    const remainingCooldownMs = Number.isFinite(boundaryAt) ? Math.max(0, boundaryAt + cooldownMs - Date.now()) : cooldownMs;
    if (severe && remainingCooldownMs > 0) {
      console.log(JSON.stringify({
        action: "cooldown",
        signal: before.lastBoundary.signal,
        boundaryAt: before.lastBoundary.at,
        adaptiveStrike: state.strikes,
        cooldownMinutes,
        remainingCooldownMinutes: Math.ceil(remainingCooldownMs / 60_000),
        progressSinceBoundary,
        counts: before.counts,
      }));
      return;
    }
    await ensureRuntimeReady({ reload: true });
    await api(`/api/contact-queues/${queueId}/resume`, {
      method: "POST",
      body: JSON.stringify({ confirm: `RECOVER COLLECTION ${queueId}` }),
    });
    budget = 1;
  } else if (before.status === "ready") {
    const lastRunAt = Date.parse(state.lastRunAt || "");
    const remainingGapMs = Number.isFinite(lastRunAt)
      ? Math.max(0, lastRunAt + minimumBatchGapMinutes * 60_000 - Date.now())
      : 0;
    if (remainingGapMs > 0) {
      console.log(JSON.stringify({
        action: "batch_gap",
        minimumBatchGapMinutes,
        remainingGapMinutes: Math.ceil(remainingGapMs / 60_000),
        counts: before.counts,
      }));
      return;
    }
    await ensureRuntimeReady();
  } else {
    console.log(JSON.stringify({ action: "skip_state", status: before.status, counts: before.counts }));
    return;
  }

  let runOutput = "";
  let workbookRebuilt = false;
  try {
    const execution = await run(node, [path.join(workspace, "tools", "run-netease-contact-queue.mjs"), String(budget)], { timeout: 30 * 60 * 1000 });
    runOutput = execution.stdout.trim();
  } finally {
    workbookRebuilt = await rebuildWorkbook();
  }

  const after = await api(`/api/contact-queues/${queueId}?items=1`);
  const managedCompletionsRecorded = await recordManagedCompletions(after);
  const completedDelta = Math.max(0, Number(after.counts.completed || 0) - Number(before.counts.completed || 0));
  if (after.status !== "circuit_open" && completedDelta > 0) {
    state.lastRunAt = new Date().toISOString();
    state.safeCompletions = Number(state.safeCompletions || 0) + completedDelta;
    if (state.safeCompletions >= 20 && state.strikes > 1) {
      state.strikes -= 1;
      state.safeCompletions = 0;
    }
  }
  await writeState(state);
  console.log(JSON.stringify({
    action: budget === 1 ? "canary" : "batch",
    budget,
    status: after.status,
    safetyState: after.safetyState,
    counts: after.counts,
    lastBoundary: after.lastBoundary,
    workbookRebuilt,
    outputLines: runOutput ? runOutput.split(/\r?\n/).length : 0,
    adaptiveStrike: state.strikes,
    nextCooldownMinutes: cooldownMinutesFor(Math.max(1, state.strikes)),
    minimumBatchGapMinutes,
    managedCompletionsRecorded,
  }));
}

const releaseLock = await acquireSupervisorLock();
if (!releaseLock) {
  console.log(JSON.stringify({ action: "skip_supervisor_locked", lockPath }));
} else {
  try {
    await main();
  } finally {
    await releaseLock();
  }
}
