import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function bounded(value, fallback, minimum, maximum) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(Math.max(number, minimum), maximum) : fallback;
}

export function validateManagedPlan(input) {
  if (input?.schemaVersion !== 1 || input?.mode !== "managed") throw new Error("计划必须是 schemaVersion=1 且 mode=managed");
  const planId = String(input.planId || "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
  if (!planId) throw new Error("计划缺少 planId");
  const collectionMode = ["hscode", "keyword", "country_business"].includes(input.collectionMode) ? input.collectionMode : "hscode";
  const seen = new Set();
  const hsCodes = (Array.isArray(input.hsCodes) ? input.hsCodes : []).map((item) => {
    const hsCode = String(item?.hsCode || "").trim();
    if (!/^\d{4,10}$/.test(hsCode)) throw new Error(`无效 HSCode：${hsCode || "(empty)"}`);
    if (seen.has(hsCode)) throw new Error(`计划包含重复 HSCode：${hsCode}`);
    seen.add(hsCode);
    return {
      hsCode,
      direction: item.direction === "supplier" ? "supplier" : "buyer",
      countries: [...new Set((Array.isArray(item.countries) ? item.countries : []).map(String).map((value) => value.trim()).filter(Boolean))].slice(0, 20),
      startPage: bounded(item.startPage, 1, 1, 10000),
    };
  });
  if (collectionMode === "hscode" && !hsCodes.length) throw new Error("计划至少需要一个 HSCode");
  const marketTargetProfile = collectionMode === "country_business" ? input.marketTargetProfile : null;
  if (collectionMode === "country_business" && (!String(marketTargetProfile?.country || "").trim()
    || !Array.isArray(marketTargetProfile?.industryKeywords) || !marketTargetProfile.industryKeywords.length)) {
    throw new Error("country_business 计划需要 marketTargetProfile.country 和 industryKeywords");
  }
  const emailSends = bounded(input.dailyBudgets?.emailSends, 20, 1, 1000);
  const maxContactsPerCompanyDaily = 2;
  const collectionReserve = Math.min(400, Math.max(5, Math.ceil(emailSends / maxContactsPerCompanyDaily)));
  const validEmailCompanies = bounded(input.dailyBudgets?.validEmailCompanies, collectionReserve, 1, 200);
  const managedDiscoveryFloor = Math.min(2000, Math.max(100, validEmailCompanies * 8));
  const dailyBudgets = {
    buyerEntries: Math.max(bounded(input.dailyBudgets?.buyerEntries, managedDiscoveryFloor, 1, 2000), managedDiscoveryFloor),
    companyDetails: bounded(input.dailyBudgets?.companyDetails, collectionReserve, 1, 400),
    validEmailCompanies,
    contactPages: bounded(input.dailyBudgets?.contactPages, 25, 1, 400),
    emailSends,
    globalEmailHardCap: bounded(input.dailyBudgets?.globalEmailHardCap, 500, 1, 1000),
  };
  if (dailyBudgets.companyDetails < collectionReserve) throw new Error(`公司采集预算必须至少覆盖每日发送目标（每家公司最多${maxContactsPerCompanyDaily}位联系人，共${collectionReserve}家）`);
  if (dailyBudgets.emailSends > dailyBudgets.globalEmailHardCap) throw new Error("计划邮件预算不能超过全局硬上限");
  return {
    schemaVersion: 1,
    planId,
    mode: "managed",
    collectionMode,
    marketTargetProfile: marketTargetProfile ? {
      country: String(marketTargetProfile.country).trim(),
      industryKeywords: marketTargetProfile.industryKeywords.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 8),
      excludeKeywords: Array.isArray(marketTargetProfile.excludeKeywords) ? marketTargetProfile.excludeKeywords.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 8) : [],
      direction: marketTargetProfile.direction === "supplier" ? "supplier" : "buyer",
    } : null,
    authorizedBy: String(input.authorizedBy || "plan-owner").trim().slice(0, 120) || "plan-owner",
    hsCodes,
    dailyBudgets,
    deliveryPolicy: { maxContactsPerCompanyDaily, validEmailCompaniesDaily: validEmailCompanies, draftContactsPerCompany: maxContactsPerCompanyDaily * 2, dailyDraftTarget: emailSends, reviewMode: "central_batch" },
    mandatoryHumanGates: ["captcha", "credential_error", "permission", "mfa"],
  };
}

function numericAmount(value) {
  const parsed = Number.parseFloat(String(value || "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function companyKey(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]+/g, " ").trim();
}

export function selectManagedCompanies(snapshot, plan, hsCode, excludedCompanies = new Set()) {
  if (snapshot?.kind !== "netease-customs-discovery" || snapshot?.source?.query !== hsCode) {
    throw new Error(`发现文件与 HSCode ${hsCode} 不匹配`);
  }
  if (snapshot.safety?.captcha || snapshot.safety?.rateLimited || snapshot.safety?.accountError) {
    throw new Error("发现文件包含平台安全信号，禁止继续");
  }
  const planItem = plan.hsCodes.find((item) => item.hsCode === hsCode);
  const allowedCountries = new Set((planItem?.countries || []).map((item) => String(item).trim().toLowerCase()));
  const excluded = new Set([...excludedCompanies].map(companyKey));
  const limit = plan.dailyBudgets.companyDetails;
  return (Array.isArray(snapshot.records) ? snapshot.records : [])
    .filter((item) => item.hasContact && String(item.company || "").trim())
    .filter((item) => !allowedCountries.size || allowedCountries.has(String(item.country || "").trim().toLowerCase()))
    .filter((item) => !excluded.has(companyKey(item.company)))
    .sort((left, right) => numericAmount(right.amountUsd) - numericAmount(left.amountUsd)
      || Number(left.row || 0) - Number(right.row || 0))
    .slice(0, limit);
}

export function indexValidationResults(emails, items) {
  return Object.fromEntries(emails.slice(0, items.length).map((email, index) => [email, items[index]]));
}

async function request(apiBase, pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `API ${response.status}`);
  return body;
}

export async function registerManagedPlan(plan, apiBase) {
  const existing = await request(apiBase, "/api/ops/tasks");
  const results = [];
  const items = plan.collectionMode === "country_business" ? [{ hsCode: "", direction: plan.marketTargetProfile.direction, countries: [plan.marketTargetProfile.country], country: plan.marketTargetProfile.country, businessKeywords: plan.marketTargetProfile.industryKeywords, keyword: plan.marketTargetProfile.industryKeywords.join(" ") }] : plan.hsCodes;
  for (const item of items) {
    const authorizationKey = plan.collectionMode === "country_business" ? `${item.country}:${item.businessKeywords.join(",")}` : item.hsCode;
    const prior = existing.items.find((task) => (
      task.collectionMode === (plan.collectionMode || "hscode")
      && (plan.collectionMode === "country_business" ? task.country === item.country && JSON.stringify(task.businessKeywords || []) === JSON.stringify(item.businessKeywords) : task.hsCode === item.hsCode)
      && task.automation?.mode === "managed"
      && task.automation?.planId === plan.planId
    ));
    if (prior) {
      await request(apiBase, `/api/ops/tasks/${prior.id}`, {
        method: "PUT",
        body: JSON.stringify({
          budgets: {
            buyerEntriesDaily: plan.dailyBudgets.buyerEntries,
            companyDetailsDaily: plan.dailyBudgets.companyDetails,
            validEmailCompaniesDaily: plan.dailyBudgets.validEmailCompanies,
            contactPagesDaily: plan.dailyBudgets.contactPages,
            emailSendsDaily: plan.dailyBudgets.emailSends,
          },
          confirm: `AUTHORIZE MANAGED ${authorizationKey}`,
        }),
      });
      results.push({ hsCode: item.hsCode, taskId: prior.id, action: "reused" });
      continue;
    }
    const task = await request(apiBase, "/api/ops/tasks", {
      method: "POST",
      body: JSON.stringify({
        ...item,
        budgets: {
          buyerEntriesDaily: plan.dailyBudgets.buyerEntries,
          companyDetailsDaily: plan.dailyBudgets.companyDetails,
          validEmailCompaniesDaily: plan.dailyBudgets.validEmailCompanies,
          contactPagesDaily: plan.dailyBudgets.contactPages,
          emailSendsDaily: plan.dailyBudgets.emailSends,
        },
        automation: {
          mode: "managed",
          planId: plan.planId,
          authorizedBy: plan.authorizedBy,
          confirm: `AUTHORIZE MANAGED ${authorizationKey}`,
        },
      }),
    });
    results.push({ hsCode: item.hsCode, taskId: task.id, action: "created" });
  }
  return { planId: plan.planId, results };
}

export async function prepareManagedPage(plan, file, apiBase) {
  const snapshotPath = path.resolve(file);
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  const hsCode = String(snapshot.source?.query || "");
  const planItem = plan.hsCodes.find((item) => item.hsCode === hsCode);
  if (!planItem) throw new Error(`计划不包含 HSCode ${hsCode || "(empty)"}`);
  const pageNumber = Number.parseInt(snapshot.source?.pageNumber, 10);
  if (!Number.isInteger(pageNumber) || pageNumber < planItem.startPage) throw new Error("发现文件页码早于计划起始页");
  const registration = await registerManagedPlan(plan, apiBase);
  const taskId = registration.results.find((item) => item.hsCode === hsCode)?.taskId;
  let task = await request(apiBase, `/api/ops/tasks/${taskId}`);
  if (Number(task.checkpoint?.page || 0) < pageNumber) {
    task = await request(apiBase, `/api/ops/tasks/${taskId}/actions`, {
      method: "POST",
      body: JSON.stringify({
        type: "buyer_entry",
        count: snapshot.records.length,
        signal: "none",
        idempotencyKey: `${plan.planId}:${hsCode}:page:${pageNumber}:buyers`,
        checkpoint: {
          page: pageNumber,
          extracted: snapshot.records.length,
          note: `managed discovery ${path.basename(snapshotPath)}`,
        },
      }),
    });
  }

  const queueKey = `${plan.planId}_${hsCode}_page_${pageNumber}`;
  const queueList = await request(apiBase, "/api/contact-queues");
  const existingQueue = queueList.items.find((item) => item.key === queueKey);
  if (existingQueue) {
    const existing = await request(apiBase, `/api/contact-queues/${existingQueue.id}?items=1`);
    return {
      planId: plan.planId,
      hsCode,
      pageNumber,
      taskId,
      queueId: existing.id,
      queueStatus: existing.status,
      selectedCompanies: (existing.items || []).map((item) => item.companyName),
      counters: task.counters,
    };
  }
  const relatedQueues = queueList.items.filter((item) => String(item.key || "").toLowerCase().includes(`_${hsCode}_page`));
  const relatedDetails = await Promise.all(relatedQueues.map((item) => request(apiBase, `/api/contact-queues/${item.id}?items=1`)));
  const excludedCompanies = new Set(relatedDetails.flatMap((queue) => (queue.items || []).map((item) => item.companyName)));
  const selected = selectManagedCompanies(snapshot, plan, hsCode, excludedCompanies);
  if (!selected.length) {
    return {
      planId: plan.planId,
      hsCode,
      pageNumber,
      taskId,
      queueId: "",
      queueStatus: "no_candidates",
      selectedCompanies: [],
      counters: task.counters,
    };
  }

  const sourceDir = path.join(path.dirname(snapshotPath), "managed");
  const sourcePath = path.join(sourceDir, `hscode_${hsCode}_page_${String(pageNumber).padStart(3, "0")}_companies.json`);
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(sourcePath, `${JSON.stringify({
    schemaVersion: 1,
    kind: "managed-contact-source",
    planId: plan.planId,
    hsCode,
    pageNumber,
    sourceSnapshot: path.relative(path.resolve(import.meta.dirname, ".."), snapshotPath).replaceAll("\\", "/"),
    records: selected,
  }, null, 2)}\n`, "utf8");

  const workspace = path.resolve(import.meta.dirname, "..");
  const queue = await request(apiBase, "/api/contact-queues/initialize", {
    method: "POST",
    body: JSON.stringify({
      key: queueKey,
      label: `Managed HSCode ${hsCode} page ${pageNumber} contacts`,
      sources: [{ sourceId: `${hsCode}_page_${pageNumber}`, path: path.relative(workspace, sourcePath) }],
      processedResultPaths: [],
      processedNames: [],
      config: { batchSize: 1, minDelayMs: 15000, maxDelayMs: 25000, leaseSeconds: 1800, maxAttempts: 3 },
    }),
  });
  return {
    planId: plan.planId,
    hsCode,
    pageNumber,
    taskId,
    queueId: queue.id,
    queueStatus: queue.status,
    selectedCompanies: selected.map((item) => item.company),
    counters: task.counters,
  };
}

async function main() {
  const [command = "validate", file = "plans/managed-hscode-plan.json", argument = process.env.MANAGED_PLAN_API_BASE || "http://127.0.0.1:4173", optionalApiBase] = process.argv.slice(2);
  const plan = validateManagedPlan(JSON.parse(await fs.readFile(path.resolve(file), "utf8")));
  if (command === "validate") return console.log(JSON.stringify(plan, null, 2));
  if (command === "register") return console.log(JSON.stringify(await registerManagedPlan(plan, argument.replace(/\/+$/, "")), null, 2));
  if (command === "prepare") return console.log(JSON.stringify(await prepareManagedPage(plan, argument, (optionalApiBase || process.env.MANAGED_PLAN_API_BASE || "http://127.0.0.1:4173").replace(/\/+$/, "")), null, 2));
  throw new Error("用法：managed-hscode-plan.mjs validate|register <plan.json> [apiBase] | prepare <plan.json> <snapshot.json> [apiBase]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
