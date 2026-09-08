import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(import.meta.dirname, "..");
const node = process.execPath;
const service = (process.env.COLLECTION_SERVICE || "http://127.0.0.1:4173").replace(/\/+$/, "");
const queueKey = String(process.env.COUNTRY_BUSINESS_QUEUE_KEY || "").trim();
const queueId = String(process.env.COLLECTION_QUEUE_ID || "").trim();
const owner = process.env.COLLECTION_OWNER || "managed-country-business";
const inputRoot = path.resolve(process.env.PIPELINE_INPUT_ROOT || path.join(workspace, "deploy", "runtime-data", "pipeline-inputs"));
const handoffStatePath = path.join(workspace, ".codex_work", "country-business-handoff-state.json");
const discoveryStatePath = path.join(workspace, ".codex_work", "country-business-discovery-state.json");
const poolTarget = Math.max(1, Number(process.env.CONTACT_POOL_TARGET || 5000));

async function runtimeVersion() {
  const files = [
    path.join(workspace, "tools", "run-managed-country-business-collection.mjs"),
    path.join(workspace, "tools", "run-netease-contact-queue.mjs"),
    path.join(workspace, "tools", "netease-country-business-discovery.mjs"),
  ];
  const hash = createHash("sha256");
  for (const file of files) hash.update(await fs.readFile(file));
  return { files: files.map((file) => path.relative(workspace, file).replaceAll("\\", "/")), sha256: hash.digest("hex") };
}

async function ensureBusinessPage() {
  try {
    const result = await execFileAsync(node, [path.join(workspace, "tools", "netease-cdp-client.mjs"), "ensure-business-page"], {
      cwd: workspace,
      encoding: "utf8",
      timeout: Math.max(2 * 60 * 1000, Number(process.env.NETEASE_LOGIN_RECOVERY_TIMEOUT_MS || 15 * 60 * 1000) + 2 * 60 * 1000),
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
    });
    const output = result.stdout.trim();
    return output ? JSON.parse(output) : {};
  } catch (error) {
    const detail = `${error.stderr || ""} ${error.stdout || ""} ${error.message || ""}`.replace(/\s+/g, " ").trim();
    const login = /requires login|MFA|expired session|login recovery timed out|netease_login_required|login_required/i.test(detail);
    console.log(JSON.stringify({ action: "attention_required", reason: login ? "netease_login_required" : "netease_page_not_ready", detail: detail.slice(-800) }));
    return null;
  }
}

async function api(pathname, options = {}) {
  const response = await fetch(`${service}${pathname}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `API ${response.status}`);
  return body;
}

async function runQueue(id, budget) {
  const result = await execFileAsync(node, [path.join(workspace, "tools", "run-netease-contact-queue.mjs"), String(budget)], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 3 * 60 * 60 * 1000,
    env: { ...process.env, EDGE_CDP_ENDPOINT: process.env.EDGE_CDP_ENDPOINT || "http://127.0.0.1:9224", COLLECTION_SERVICE: service, COLLECTION_QUEUE_ID: id, COLLECTION_OWNER: owner },
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function text(value, maximum = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

async function handoffCompleted(queue) {
  const state = JSON.parse(await fs.readFile(handoffStatePath, "utf8").catch(() => "{\"queues\":{}}"));
  if (state.queues?.[queue.id]) return { handedOff: true, duplicate: true, ...state.queues[queue.id] };
  const queueDetail = await api(`/api/contact-queues/${queue.id}?items=1`);
  const completed = (queueDetail.items || []).filter((item) => item.status === "completed" && item.artifactReference);
  const artifacts = [];
  for (const item of completed) {
    const relative = String(item.artifactReference || "").replaceAll("\\", "/");
    if (!relative.startsWith("deploy/runtime-data/contact-collection-batches/") && !/^tmp\/edge_auto_[^/]+\.json$/.test(relative)) continue;
    try { artifacts.push(JSON.parse(await fs.readFile(path.join(workspace, relative), "utf8"))); } catch { /* retry next timer */ }
  }
  const raw = artifacts.flatMap((artifact) => artifact.results || artifact.rawResults || []);
  const contacts = raw.flatMap((result) => Array.isArray(result.contacts) ? result.contacts.map((contact) => ({
    company: text(result.company?.name || result.query), name: text(contact.name), title: text(contact.title),
    email: text(contact.email).toLowerCase(), phone: text(contact.phone), website: text(result.company?.website),
    domain: text(result.company?.domain), source: "网易外贸通国家+业务范围采集",
  })) : []);
  const companies = [...new Map(raw.map((result) => [text(result.company?.name || result.query).toLowerCase(), text(result.company?.name || result.query)]).filter(([key]) => key)).values()];
  if (!contacts.length || !companies.length) return { handedOff: false, reason: "no_contact_rows" };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const folder = path.join(inputRoot, `managed_country_business_${stamp}`);
  await fs.mkdir(folder, { recursive: true });
  const discoveryName = "netease_country_business_page_001.json";
  const enrichmentName = "netease_contact_enrichment_001.json";
  const discovery = { schemaVersion: 1, kind: "netease-country-business-discovery", query: queue.label || queue.key, country: "Poland", normalizedBusinessKeywords: ["board games", "books", "paper packaging"], capturedAt: new Date().toISOString(), records: companies.map((company, index) => ({ page: 1, row: index + 1, rowKey: `queue-${queue.id}-${index + 1}`, company, country: "Poland", hasContact: contacts.some((contact) => contact.company === company), productDescription: "board games, books, paper packaging" })) };
  const enrichment = { schemaVersion: 1, kind: "netease-contact-enrichment", records: contacts, counts: { companiesProcessed: companies.length }, pageNumber: 1, handoffKey: queue.id };
  await Promise.all([
    fs.writeFile(path.join(folder, discoveryName), `${JSON.stringify(discovery, null, 2)}\n`, "utf8"),
    fs.writeFile(path.join(folder, enrichmentName), `${JSON.stringify(enrichment, null, 2)}\n`, "utf8"),
  ]);
  const tasks = (await api("/api/ops/tasks")).items || [];
  const task = tasks.find((item) => item.collectionMode === "country_business" && String(item.country || "").toLowerCase() === "poland");
  if (!task) return { handedOff: false, reason: "country_business_task_missing", contacts: contacts.length };
  const job = await api("/api/pipeline/jobs", { method: "POST", body: JSON.stringify({ operationTaskId: task.id }) });
  const discoveryReference = path.relative(inputRoot, path.join(folder, discoveryName)).replaceAll("\\", "/");
  const enrichmentReference = path.relative(inputRoot, path.join(folder, enrichmentName)).replaceAll("\\", "/");
  await api(`/api/pipeline/jobs/${job.id}/resume`, { method: "POST", body: JSON.stringify({ inputReference: discoveryReference }) });
  await execFileAsync(node, [path.join(workspace, "app", "pipeline-worker.mjs"), "--drain", "--max-jobs", "6"], { cwd: workspace, timeout: 30 * 60 * 1000, env: process.env });
  const afterDiscovery = ((await api("/api/pipeline")).jobs || []).find((item) => item.id === job.id);
  if (afterDiscovery?.currentStage === "contact_enrichment" && afterDiscovery.status === "waiting_input") {
    await api(`/api/pipeline/jobs/${job.id}/resume`, { method: "POST", body: JSON.stringify({ inputReference: enrichmentReference }) });
    await execFileAsync(node, [path.join(workspace, "app", "pipeline-worker.mjs"), "--drain", "--max-jobs", "6"], { cwd: workspace, timeout: 30 * 60 * 1000, env: process.env });
  }
  const result = { handedOff: true, contacts: contacts.length, companies: companies.length, jobId: job.id, completedAt: new Date().toISOString() };
  state.queues ||= {};
  state.queues[queue.id] = result;
  await fs.mkdir(path.dirname(handoffStatePath), { recursive: true });
  await fs.writeFile(handoffStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return result;
}

async function createNextQueue(queues) {
  const state = JSON.parse(await fs.readFile(discoveryStatePath, "utf8").catch(() => "{\"nextPage\":2}"));
  const page = Math.max(1, Number(state.nextPage || 2));
  const outputDir = path.join(inputRoot, "managed_country_business_discovery");
  const strategies = [
    "board games, books, paper packaging",
    "Poland board games books packaging",
    "Warsaw board games books packaging",
    "Krakow board games books packaging",
    "Wroclaw paper packaging printing",
    "Poznan books publishing printing",
    "Gdansk games packaging manufacturer",
  ];
  const start = Math.max(0, Number(state.strategyIndex || 0)) % strategies.length;
  let result;
  let strategyIndex = start;
  const failures = [];
  const discoveryPath = path.join(outputDir, `netease_country_business_page_${String(page).padStart(3, "0")}.json`);
  for (let offset = 0; offset < strategies.length; offset++) {
    strategyIndex = (start + offset) % strategies.length;
    const businessQuery = strategies[strategyIndex];
    try {
      const discoveryStartedAt = Date.now();
      result = await execFileAsync(node, [path.join(workspace, "tools", "netease-country-business-discovery.mjs"), "Poland", businessQuery, "buyer", String(page), outputDir], {
        cwd: workspace, encoding: "utf8", timeout: 5 * 60 * 1000, env: process.env, maxBuffer: 4 * 1024 * 1024,
      });
      // Discovery emits JSON diagnostics as well as a pretty-printed summary.
      // Consume the canonical file instead of treating mixed stdout as one JSON value.
      const discoveryStat = await fs.stat(discoveryPath);
      if (discoveryStat.mtimeMs < discoveryStartedAt - 1_000) throw new Error("discovery output was not refreshed");
      const snapshot = JSON.parse(await fs.readFile(discoveryPath, "utf8"));
      if (snapshot.kind !== "netease-country-business-discovery" || !Array.isArray(snapshot.records) || !snapshot.records.length) {
        throw new Error("discovery output missing usable company records");
      }
      result.discovery = snapshot;
      break;
    } catch (error) {
      const detail = `${error.stderr || ""} ${error.message || ""}`;
      failures.push({ strategy: businessQuery, reason: detail.replace(/\s+/g, " ").slice(-500) });
    }
  }
  if (!result?.stdout) {
    console.log(JSON.stringify({ action: "collection_strategies_exhausted", page, failures }));
    return null;
  }
  const discovery = result.discovery;
  discovery.outputPath = discoveryPath;
  const processedNames = [];
  for (const existing of queues.filter((item) => String(item.key || "").startsWith(queueKey))) {
    const detail = await api(`/api/contact-queues/${existing.id}?items=1`);
    processedNames.push(...(detail.items || []).map((item) => item.companyName));
  }
  const sourcePath = path.relative(workspace, path.resolve(discovery.outputPath)).replaceAll("\\", "/");
  const created = await api("/api/contact-queues/initialize", {
    method: "POST",
    body: JSON.stringify({
      key: `${queueKey}-page-${String(page).padStart(3, "0")}`,
      label: `Poland country-business strategy ${strategyIndex + 1} page ${page}`,
      sources: [{ sourceId: `country-business-poland-strategy-${strategyIndex + 1}-page-${page}`, path: sourcePath }],
      processedNames: [...new Set(processedNames)],
      config: { batchSize: 20, minDelayMs: 12000, maxDelayMs: 18000, leaseSeconds: 1800, maxAttempts: 3 },
    }),
  });
  await fs.mkdir(path.dirname(discoveryStatePath), { recursive: true });
  await fs.writeFile(discoveryStatePath, `${JSON.stringify({ nextPage: page + 1, lastPage: page, strategyIndex: (strategyIndex + 1) % strategies.length, queueId: created.id, createdAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  return created;
}

const [queuesResponse, pool] = await Promise.all([api("/api/contact-queues"), api("/api/contact-pool")]);
const queues = queuesResponse.items || [];
console.log(JSON.stringify({ action: "managed_collection_start", runtime: await runtimeVersion(), cdp: process.env.EDGE_CDP_ENDPOINT || "http://127.0.0.1:9224" }));
let queue = queues
  .filter((item) => (queueId && item.id === queueId) || (queueKey && (item.key === queueKey || item.key.startsWith(queueKey))))
  .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))[0];
if (pool.available >= Math.min(pool.target || poolTarget, poolTarget)) {
  console.log(JSON.stringify({ action: "inventory_maintenance", available: pool.available, target: pool.target || poolTarget }));
  process.exit(0);
}
if (!await ensureBusinessPage()) process.exit(0);
if (!queue || !queue.counts?.remaining) {
  const previousHandoff = queue ? await handoffCompleted(queue) : null;
  queue = await createNextQueue(queues);
  if (!queue) process.exit(0);
  console.log(JSON.stringify({ action: "country_business_queue_created", available: pool.available, target: pool.target || poolTarget, previousHandoff, queueId: queue.id, queueKey: queue.key, counts: queue.counts }));
}
if (queue.status === "circuit_open") throw new Error(`国家+业务队列处于熔断：${queue.lastBoundary?.signal || "unknown"}`);
if (queue.counts?.remaining) {
  const rows = await runQueue(queue.id, Math.max(1, Math.min(Number(process.env.COLLECT_BATCH_SIZE || 20), Number(queue.counts.remaining))));
  const latest = (await api("/api/contact-queues")).items.find((item) => item.id === queue.id) || queue;
  console.log(JSON.stringify({ action: "country_business_collection", queueId: queue.id, queueKey: queue.key, before: queue.counts, results: rows, handoff: await handoffCompleted(latest) }));
}
