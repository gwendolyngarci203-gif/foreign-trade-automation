import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(import.meta.dirname, "..");
const node = process.execPath;
const client = path.join(import.meta.dirname, "netease-cdp-client.mjs");
const searchClient = path.join(import.meta.dirname, "netease-playwright-search.mjs");
const service = process.env.COLLECTION_SERVICE || "http://127.0.0.1:4174";
const queueId = process.env.COLLECTION_QUEUE_ID || "collection_e977e59e-8f24-408b-9076-ebcc3bac9f93";
const owner = process.env.COLLECTION_OWNER || "codex-edge-cdp-runner-20260812";
const limit = Math.max(1, Math.min(Number.parseInt(process.argv[2] || "1", 10) || 1, 20));
const safeMinimumDelayMs = Math.max(15_000, Number.parseInt(process.env.COLLECTION_MIN_DELAY_MS || "15000", 10) || 15_000);
const safeMaximumDelayMs = Math.max(safeMinimumDelayMs, Number.parseInt(process.env.COLLECTION_MAX_DELAY_MS || "25000", 10) || 25_000);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minimum, maximum) {
  return Math.floor(minimum + Math.random() * (maximum - minimum + 1));
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

async function scriptJson(script, args, timeout = 45_000) {
  try {
    const { stdout } = await execFileAsync(node, [script, ...args], {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout,
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.stdout) {
      try { return JSON.parse(error.stdout); } catch { /* use control error below */ }
    }
    const diagnostic = String(error.stderr || "").match(/(SEARCH_STATE_MISMATCH|TARGET_CHANGED|EXACT_MODE_LOST|RESULT_NOT_READY|CDP_RUNTIME_TIMEOUT):[^\r\n]*/);
    if (diagnostic) throw new Error(diagnostic[0]);
    throw error;
  }
}

async function collectVisible(companyName, submittedQuery = companyName, contactPage = 1, searchState = null) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const binding = searchState?.targetId
        ? ["--target-id", searchState.targetId, "--result-signature", searchState.resultSignature || ""]
        : [];
      return await scriptJson(client, ["collect-current-visible", companyName, "--submitted-query", submittedQuery, "--contact-page", String(contactPage), ...binding]);
    } catch (error) {
      lastError = error;
      const transientRender = /visible result rows were not located|Current result does not belong/.test(String(error.message || error));
      if (!transientRender || attempt === 3) throw error;
      await delay(700 * attempt);
    }
  }
  throw lastError;
}

function companyQueryVariants(companyName) {
  const aliases = [
    [/^THE BIBLE SOCIETY OF UGANDA/i, "THE BIBLE SOCIETY OF UGANDA"],
    [/^THE CHURCH OF GOSPEL MESSENGERS/i, "THE CHURCH OF GOSPEL MESSENGERS"],
    [/^WORLD VISION DRC EAST ZONE OFFICE/i, "WORLD VISION DRC"],
    [/^WORLD VISION INTERNATIONAL SOUTH SUDAN/i, "WORLD VISION INTERNATIONAL SOUTH SUDAN"],
  ];
  const variants = [companyName];
  for (const [pattern, alias] of aliases) {
    if (pattern.test(companyName) && alias !== companyName) variants.push(alias);
  }
  return variants;
}

async function collectItem(item) {
  let lastError;
  for (const submittedQuery of companyQueryVariants(item.companyName)) {
    try {
      const search = await scriptJson(searchClient, [submittedQuery], 75_000);
      const severe = safetyResult(item, search);
      if (severe) return severe;
      await delay(800);
      const collected = await collectVisible(item.companyName, submittedQuery, item.contactPage || item.contactNextPage || 1, search);
      const postSafety = safetyResult(item, collected.safety || {});
      return postSafety || { ...collected, submittedQuery };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function safetyResult(item, state) {
  if (state.captcha) return { itemId: item.id, query: item.companyName, status: "error", signal: "captcha", alarm: "captcha" };
  if (state.rateLimited) return { itemId: item.id, query: item.companyName, status: "error", signal: "frequent_operation", alarm: "frequent_operation" };
  if (state.accountError) return { itemId: item.id, query: item.companyName, status: "error", signal: "permission", alarm: "account_or_permission_error" };
  return null;
}

function safeFileName(value) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100) || "company";
}

async function finish(batch, item, rawResult) {
  const artifactRelative = `tmp/edge_auto_${safeFileName(item.companyName)}_${Date.now()}.json`;
  const artifactPath = path.join(workspace, artifactRelative);
  const body = { owner, artifactReference: artifactRelative, rawResults: [{ itemId: item.id, query: item.companyName, ...rawResult }] };
  await fs.writeFile(artifactPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return api(`/api/contact-queues/${queueId}/batches/${batch.id}/complete`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

let processed = 0;
for (; processed < limit; processed += 1) {
  const claimed = await api(`/api/contact-queues/${queueId}/claim`, {
    method: "POST",
    body: JSON.stringify({ owner, batchSize: 1, leaseSeconds: 1800 }),
  });
  if (!claimed.batch?.items?.length) break;
  const batch = claimed.batch;
  const item = batch.items[0];
  let result;
  try {
    result = await collectItem(item);
  } catch (error) {
    const message = String(error.message || error).slice(0, 500);
    const disconnected = /ECONNREFUSED|WebSocket|browser.*closed|connectOverCDP|No fixed-element-ready/i.test(message);
    const structured = /^(SEARCH_STATE_MISMATCH|TARGET_CHANGED|EXACT_MODE_LOST|RESULT_NOT_READY|CDP_RUNTIME_TIMEOUT):/.exec(message)?.[1]
      || (/CDP Runtime\.evaluate timed out/i.test(message) ? "CDP_RUNTIME_TIMEOUT" : "");
    result = {
      status: disconnected ? "browser_disconnected" : structured || "error",
      signal: disconnected ? "browser_disconnected" : structured || "control_timeout",
      error: message,
      company: {},
      contacts: [],
    };
  }
  const completed = await finish(batch, item, result);
  const summary = {
    company: item.companyName,
    status: result.status,
    contacts: Array.isArray(result.contacts) ? result.contacts.length : 0,
    queue: completed.queue.status,
    safetyState: completed.queue.safetyState,
    completed: completed.queue.counts.completed,
    remaining: completed.queue.counts.remaining,
  };
  console.log(JSON.stringify(summary));
  if (completed.queue.status === "circuit_open" || ["captcha", "frequent_operation", "permission", "http_403", "http_429"].includes(result.signal)) break;
  // Local controller faults do not indicate a NetEase platform alarm. The
  // queue rotates those items behind untouched work, so keep progressing and
  // leave the failed item pending for a later retry.
  if (processed + 1 < limit) {
    const minimum = Math.max(safeMinimumDelayMs, Number(completed.queue.config.minDelayMs || 0));
    const maximum = Math.max(minimum, safeMaximumDelayMs, Number(completed.queue.config.maxDelayMs || 0));
    await delay(randomDelay(minimum, maximum));
  }
}

console.error(`processed=${processed}`);
