import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.resolve(appDir, "..");
const EMAIL_TEMPLATE_LIBRARY = JSON.parse(await fs.readFile(path.join(appDir, "data", "email-template-library.json"), "utf8"));
const PIPELINE_STAGES = [
  "discovery",
  "trade_normalization",
  "buyer_matching",
  "contact_enrichment",
  "validation",
  "drafting",
  "approval",
  "sending",
  "feedback",
];
const LOGISTICS_PATTERN = /\b(logistics?|freight|cartage|forwarding|transport|shipping|express|broker|damco|schenker|flexport|yusen)\b/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class InputNeeded extends Error {}

function parseArguments(argv) {
  const result = { drain: false, maxJobs: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--drain") result.drain = true;
    if (argv[index] === "--max-jobs") result.maxJobs = Math.min(Math.max(Number(argv[index + 1]) || 1, 1), 20);
  }
  if (!result.drain) result.maxJobs = 1;
  return result;
}

function workerConfig(env = process.env) {
  const inputRoot = path.resolve(env.PIPELINE_INPUT_ROOT || workspaceDir);
  const artifactRoot = path.resolve(env.PIPELINE_ARTIFACT_DIR || path.join(appDir, "data", "pipeline-artifacts"));
  return {
    apiBase: String(env.PIPELINE_API_BASE || "http://127.0.0.1:4173").replace(/\/+$/, ""),
    owner: String(env.PIPELINE_WORKER_OWNER || `pipeline-worker:${os.hostname()}:${process.pid}`).slice(0, 120),
    inputRoot,
    artifactRoot,
    allowedRoots: [...new Set([inputRoot, artifactRoot].map((item) => path.resolve(item)))],
    senderCompany: cleanText(env.PIPELINE_SENDER_COMPANY || "Your Company", 200),
    senderName: cleanText(env.PIPELINE_SENDER_NAME, 120),
    senderTitle: cleanText(env.PIPELINE_SENDER_TITLE, 160),
    senderEmail: cleanText(env.PIPELINE_SENDER_EMAIL, 320),
    senderPhone: cleanText(env.PIPELINE_SENDER_PHONE, 120),
    senderWebsite: cleanText(env.PIPELINE_SENDER_WEBSITE, 320),
    companyBusiness: cleanText(
      env.PIPELINE_COMPANY_BUSINESS
        || "Your Company provides the products and services described in your verified business profile.",
      1000,
    ),
    productFocus: cleanText(env.PIPELINE_PRODUCT_FOCUS, 500),
    draftLimit: Math.min(Math.max(Number(env.PIPELINE_DRAFT_LIMIT) || 20, 1), 50),
    draftContactsPerCompany: Math.min(Math.max(Number(env.PIPELINE_DRAFT_CONTACTS_PER_COMPANY) || 4, 1), 4),
    draftDelayMs: Math.min(Math.max(Number(env.PIPELINE_DRAFT_DELAY_MS) || 1700, 1500), 10000),
    managedSendCompanyThreshold: Math.min(Math.max(Number(env.PIPELINE_MANAGED_SEND_COMPANY_THRESHOLD) || 100, 1), 1000),
  };
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function referenceToPath(reference, config) {
  const value = String(reference || "").trim();
  if (!value) throw new InputNeeded("缺少阶段输入文件引用");
  let candidate;
  if (value.startsWith("file://")) candidate = fileURLToPath(value);
  else if (path.isAbsolute(value)) candidate = value;
  else if (/^[a-z][a-z0-9+.-]*:/i.test(value)) throw new InputNeeded("执行器只接受 file:// 或允许目录内的文件路径");
  else candidate = path.resolve(config.inputRoot, value);
  candidate = path.resolve(candidate);
  if (!config.allowedRoots.some((root) => isWithinRoot(candidate, root))) {
    throw new InputNeeded("输入文件不在 PIPELINE_INPUT_ROOT 或 PIPELINE_ARTIFACT_DIR 允许目录内");
  }
  return candidate;
}

async function readJsonReference(reference, config) {
  const filePath = referenceToPath(reference, config);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw new InputNeeded(`输入文件不存在：${filePath}`);
  if (stat.size > 25 * 1024 * 1024) throw new InputNeeded("输入文件超过 25MB 安全上限");
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    throw new InputNeeded("输入文件不是有效 JSON");
  }
}

async function api(config, pathname, options = {}) {
  const { timeoutMs = 15_000, ...requestOptions } = options;
  const response = await fetch(`${config.apiBase}${pathname}`, {
    ...requestOptions,
    headers: { "Content-Type": "application/json", ...(requestOptions.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `API ${response.status}`);
  return body;
}

function safeSegment(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
}

async function writeArtifact(job, stage, payload, config) {
  const directory = path.join(config.artifactRoot, safeSegment(job.id));
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, `${stage}.json`);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(temp, target);
  return pathToFileURL(target).href;
}

function latestArtifact(job, stage) {
  return [...(job.artifacts || [])].reverse().find((item) => item.stage === stage)?.reference || "";
}

function cleanText(value, maximum = 1000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function normalizeCompany(value) {
  return cleanText(value, 300)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\b(incorporated|inc|limited|ltd|llc|corp|corporation|company|co|pvt|plc)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHsCode(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 10);
}

function amountNumber(value) {
  const cleaned = String(value || "").replace(/[^0-9.-]/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function transactionNumber(value) {
  const parsed = Number.parseInt(String(value || "").replace(/\D/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function validateDiscovery(source) {
  if (source?.kind !== "netease-customs-discovery" || !Array.isArray(source.records)) {
    throw new InputNeeded("discovery 输入必须是 kind=netease-customs-discovery 且包含 records 数组");
  }
  if (!/^\d{6,10}$/.test(String(source.query || ""))) throw new InputNeeded("discovery 输入缺少有效 HSCode 查询值");
  const records = source.records.slice(0, 10000).map((record, index) => ({
    page: Math.max(Number(record.page) || 1, 1),
    row: Math.max(Number(record.row) || index + 1, 1),
    rowKey: cleanText(record.rowKey, 120),
    company: cleanText(record.company, 300),
    country: cleanText(record.country, 120),
    amountUsd: cleanText(record.amountUsd, 80),
    transactions: cleanText(record.transactions, 40),
    latestTradeDate: cleanText(record.latestTradeDate, 40),
    hasContact: Boolean(record.hasContact),
    hsCode: normalizeHsCode(record.hsCode),
    hsCodeDescription: cleanText(record.hsCodeDescription, 500),
    productDescription: cleanText(record.productDescription, 3000),
  })).filter((record) => record.company && record.hsCode);
  if (!records.length) throw new InputNeeded("discovery 输入没有可用的公司记录");
  return {
    schemaVersion: 1,
    kind: "pipeline-discovery",
    query: normalizeHsCode(source.query),
    normalizedHsCode: normalizeHsCode(source.normalizedHsCode || records[0].hsCode),
    capturedAt: source.capturedAt || new Date().toISOString(),
    source: source.source || {},
    pagination: source.pagination || {},
    safety: source.safety || {},
    records,
  };
}

function normalizeTrades(discovery) {
  const seen = new Set();
  const records = [];
  for (const record of discovery.records || []) {
    const companyKey = normalizeCompany(record.company);
    const dedupeKey = record.rowKey || `${companyKey}|${record.country}|${record.amountUsd}|${record.transactions}`;
    if (!companyKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    records.push({
      ...record,
      companyKey,
      hsCode: normalizeHsCode(record.hsCode),
      amountUsdValue: amountNumber(record.amountUsd),
      transactionsValue: transactionNumber(record.transactions),
      entityHint: LOGISTICS_PATTERN.test(record.company) ? "logistics_or_intermediary" : "buyer_candidate",
      retained: true,
    });
  }
  return { schemaVersion: 1, kind: "pipeline-trade-normalization", query: discovery.query, records };
}

function matchBuyers(trades) {
  const groups = new Map();
  for (const record of trades.records || []) {
    const key = `${record.companyKey}|${record.country}`;
    const group = groups.get(key) || {
      company: record.company,
      companyKey: record.companyKey,
      country: record.country,
      entityType: record.entityHint,
      matchConfidence: record.entityHint === "buyer_candidate" ? "medium" : "review",
      hsCodes: [],
      amountUsd: null,
      transactions: 0,
      latestTradeDate: "",
      hasVisibleContactEntry: false,
      evidenceRows: [],
      retained: true,
    };
    if (!group.hsCodes.includes(record.hsCode)) group.hsCodes.push(record.hsCode);
    group.amountUsd = Math.max(group.amountUsd || 0, record.amountUsdValue || 0) || null;
    group.transactions = Math.max(group.transactions, record.transactionsValue || 0);
    if (record.latestTradeDate > group.latestTradeDate) group.latestTradeDate = record.latestTradeDate;
    group.hasVisibleContactEntry ||= record.hasContact;
    group.evidenceRows.push({ page: record.page, row: record.row, rowKey: record.rowKey });
    groups.set(key, group);
  }
  return {
    schemaVersion: 1,
    kind: "pipeline-buyer-matching",
    query: trades.query,
    buyers: [...groups.values()],
    policy: "all_candidates_retained_logistics_flagged_not_removed",
  };
}

function enrichContacts(buyerData, contactInput) {
  if (contactInput?.kind !== "netease-contact-enrichment" || !Array.isArray(contactInput.records)) {
    throw new InputNeeded("联系人阶段需要 kind=netease-contact-enrichment 的可追溯 JSON 输入");
  }
  const buyerKeys = new Set((buyerData.buyers || []).map((buyer) => buyer.companyKey));
  const people = [];
  const companyContacts = [];
  const coveredKeys = new Set();
  const seen = new Set();
  for (const source of contactInput.records.slice(0, 50000)) {
    const company = cleanText(source.company, 300);
    const companyKey = normalizeCompany(company);
    if (!companyKey || !buyerKeys.has(companyKey)) continue;
    const email = cleanText(source.email, 320).toLowerCase();
    const phone = cleanText(source.phone, 120);
    const name = cleanText(source.name, 200);
    const dedupeKey = `${companyKey}|${email}|${phone}|${name.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    coveredKeys.add(companyKey);
    const base = {
      company, companyKey, email, phone,
      website: cleanText(source.website, 500),
      domain: cleanText(source.domain, 250).toLowerCase(),
      source: cleanText(source.source, 500),
      evidence: cleanText(source.evidence, 1000),
      evidenceSources: Array.isArray(source.evidenceSources)
        ? source.evidenceSources.map((item) => cleanText(item, 500)).filter((item) => /^https?:\/\//i.test(item)).slice(0, 5)
        : [],
    };
    if (name) people.push({ ...base, name, title: cleanText(source.title, 250) });
    else companyContacts.push(base);
  }
  return {
    schemaVersion: 1,
    kind: "pipeline-contact-enrichment",
    people,
    companyContacts,
    coverage: {
      buyers: buyerKeys.size,
      coveredBuyers: coveredKeys.size,
      uncoveredBuyers: Math.max(buyerKeys.size - coveredKeys.size, 0),
    },
  };
}

function validateContacts(enrichment) {
  const validate = (record) => ({
    ...record,
    syntaxStatus: record.email ? (EMAIL_PATTERN.test(record.email) ? "syntax_valid" : "invalid") : "missing",
    validationStatus: "unverified",
  });
  return {
    schemaVersion: 1,
    kind: "pipeline-contact-validation",
    people: (enrichment.people || []).map(validate),
    companyContacts: (enrichment.companyContacts || []).map(validate),
    limitation: "syntax_only_not_deliverability_or_employment_verification",
  };
}

function productFocusForHsCode(hsCode, override = "") {
  if (cleanText(override, 500)) return cleanText(override, 500);
  const normalized = normalizeHsCode(hsCode);
  return `products in the internally matched HSCode ${normalized}`;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function selectDraftCandidates(candidates, limit, perCompany = 4) {
  const roleScore = (title) => /purchas|procurement|buying|sourcing/i.test(title) ? 0
    : /operation|editor|production|supply|director|manager|chief|president|ceo/i.test(title) ? 1 : 2;
  const grouped = new Map();
  for (const contact of candidates) {
    const key = contact.companyKey || normalizeCompany(contact.company);
    const contacts = grouped.get(key) || [];
    contacts.push(contact);
    grouped.set(key, contacts);
  }
  const selected = [];
  for (const contacts of grouped.values()) {
    contacts.sort((left, right) => roleScore(left.title) - roleScore(right.title));
    selected.push(...contacts.slice(0, perCompany));
    if (selected.length >= limit) break;
  }
  return selected.slice(0, limit);
}

function templateDraft(contact, buyer, context, variant) {
  const firstName = cleanText(contact.name, 200).split(/\s+/)[0] || "there";
  const role = cleanText(contact.title, 160) || "your team";
  const country = cleanText(buyer.country, 120);
  const subjects = ["A practical option for your team", "Support for an upcoming requirement", "A specification-based option"];
  const openings = [
    `${contact.company}'s activity${country ? ` in ${country}` : ""} appears relevant to our work in ${context.productFocus}.`,
    `We are contacting ${contact.company} because the supplied buyer evidence appears relevant to our verified capabilities.`,
    `Your work as ${role} at ${contact.company} may involve evaluating reliable options for upcoming requirements.`,
  ];
  const questions = [
    "Would it be useful to review one current specification or RFQ?",
    "Could we send a concise capability summary for one current requirement?",
    "Is there a suitable specification we could use for a practical quotation comparison?",
  ];
  const body = `Hi ${firstName},\n\n${openings[variant]} ${context.companyBusiness} For ${role}, the most useful starting point is usually a clear specification covering product, quantity, quality, packaging, and delivery requirements. We can then respond against those exact requirements, identify any assumptions, and keep the comparison concise.\n\n${questions[variant]} We will keep any response focused on the requested requirement, avoid unsupported claims, and avoid sending unrelated material.\n\n${context.senderCompany}`;
  return {
    subject: subjects[variant], body, model: "managed-template", templateVersion: EMAIL_TEMPLATE_LIBRARY.version,
    wordCount: body.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length || 0, warnings: [], rewrittenForLength: false,
  };
}

async function draftContacts(validation, buyerData, job, config, generateDraft = null, pause = wait) {
  const buyers = new Map((buyerData.buyers || []).map((buyer) => [buyer.companyKey, buyer]));
  const candidates = [
    ...(validation.people || []),
    ...(validation.companyContacts || []).map((contact) => ({
      ...contact,
      name: "Purchasing Team",
      title: contact.title || "Purchasing Team",
      contactType: "generic_company_contact",
    })),
  ].filter((contact) => contact.email && contact.syntaxStatus === "syntax_valid");
  if (!candidates.length) {
    throw new InputNeeded("没有邮箱语法有效的联系人，不能进入草稿阶段");
  }

  const productFocus = productFocusForHsCode(job.hsCode, config.productFocus);
  const managed = job.automation?.mode === "managed";
  const draftLimit = managed ? 200 : config.draftLimit;
  const selected = selectDraftCandidates(candidates, draftLimit, managed ? (config.draftContactsPerCompany || 4) : 1);
  const requestDraft = generateDraft || ((payload) => api(config, "/api/ai/draft", {
    method: "POST",
    body: JSON.stringify(payload),
    timeoutMs: 150_000,
  }));
  const drafts = [];
  for (let index = 0; index < selected.length; index += 1) {
    const contact = selected[index];
    const buyer = buyers.get(contact.companyKey) || {};
    const buyerCountry = cleanText(buyer.country, 120);
    const buyerEvidence = [
      `${contact.company} is a verified buyer candidate associated with ${productFocus}.`,
      buyerCountry ? `The target company is recorded in ${buyerCountry}.` : "",
      "Use this evidence only for a conservative product-fit sentence and never disclose the data source.",
    ].filter(Boolean).join(" ");
    let generated;
    try {
      const payload = {
        scenario: "first_touch",
        hsCode: job.hsCode,
        productFocus,
        buyerCompany: contact.company,
        buyerCountry,
        contactName: contact.name,
        contactRole: contact.title,
        buyerEvidence,
        companyBusiness: config.companyBusiness,
        senderCompany: config.senderCompany,
        senderName: config.senderName,
        senderTitle: config.senderTitle,
        senderEmail: config.senderEmail,
        senderPhone: config.senderPhone,
        senderWebsite: config.senderWebsite,
        avoidSubjects: drafts.map((item) => item.subject),
        templateFamily: "first_touch",
        templateVersion: EMAIL_TEMPLATE_LIBRARY.version,
        templateBlueprint: EMAIL_TEMPLATE_LIBRARY.scenarios.first_touch.blueprint,
        templateVariant: index % 3,
        language: "English",
      };
      generated = job.automation?.mode === "managed"
        ? templateDraft(contact, buyer, { productFocus, companyBusiness: config.companyBusiness, senderCompany: config.senderCompany }, index % 3)
        : await requestDraft(payload);
    } catch (error) {
      throw new InputNeeded(`AI网关草稿生成未完成：${cleanText(error.message, 400)}`);
    }
    drafts.push({
      company: contact.company,
      companyKey: contact.companyKey,
      country: buyerCountry,
      contactName: contact.name,
      contactRole: contact.title,
      email: contact.email,
      subject: cleanText(generated.subject, 300),
      body: String(generated.body || "").trim().slice(0, 10000),
      model: cleanText(generated.model, 120),
      wordCount: Number(generated.wordCount) || 0,
      warnings: Array.isArray(generated.warnings) ? generated.warnings.map((item) => cleanText(item, 300)) : [],
      templateVersion: cleanText(generated.templateVersion, 80),
      rewrittenForLength: Boolean(generated.rewrittenForLength),
      evidenceSources: Array.isArray(contact.evidenceSources)
        ? contact.evidenceSources.map((item) => cleanText(item, 500)).filter((item) => /^https?:\/\//i.test(item)).slice(0, 5)
        : [],
      approvalStatus: job.automation?.mode === "managed" ? "central_batch_review_pending" : "pending_human_review",
    });
    if (job.automation?.mode !== "managed" && index < selected.length - 1) await pause(config.draftDelayMs);
  }
  return {
    schemaVersion: 1,
    kind: "pipeline-email-drafts",
    hsCode: normalizeHsCode(job.hsCode),
    productFocus,
    drafts,
    coverage: {
      eligibleContacts: candidates.length,
      draftedContacts: drafts.length,
      deferredContacts: Math.max(candidates.length - drafts.length, 0),
    },
    templateBatch: { family: "first_touch", version: EMAIL_TEMPLATE_LIBRARY.version, variants: 3, maxContactsPerCompany: job.automation?.mode === "managed" ? (config.draftContactsPerCompany || 4) : 1 },
    limitation: job.automation?.mode === "managed"
      ? "drafts_simple_validated_for_central_batch_review"
      : "drafts_require_human_approval_verified_recipient_and_send_readiness",
  };
}

async function stageResult(job, config) {
  if (job.currentStage === "discovery") {
    const output = validateDiscovery(await readJsonReference(job.inputReference, config));
    const reference = await writeArtifact(job, "discovery", output, config);
    const totalResults = output.pagination.totalResults ?? output.source.resultTotal ?? 0;
    const pages = output.pagination.totalPages ?? output.source.pageTotal ?? 0;
    return { outcome: "completed", artifact: { reference, note: "网易海关数据可见页面金丝雀", counts: { records: output.records.length, totalResults, pages } } };
  }
  if (job.currentStage === "trade_normalization") {
    const discovery = await readJsonReference(latestArtifact(job, "discovery"), config);
    const output = normalizeTrades(discovery);
    const reference = await writeArtifact(job, "trade_normalization", output, config);
    return { outcome: "completed", artifact: { reference, note: "去重、金额和主体类型标准化；不删除物流候选", counts: { records: output.records.length } } };
  }
  if (job.currentStage === "buyer_matching") {
    const trades = await readJsonReference(latestArtifact(job, "trade_normalization"), config);
    const output = matchBuyers(trades);
    const reference = await writeArtifact(job, "buyer_matching", output, config);
    return { outcome: "completed", artifact: { reference, note: output.policy, counts: { buyers: output.buyers.length, review: output.buyers.filter((item) => item.matchConfidence === "review").length } } };
  }
  if (job.currentStage === "contact_enrichment") {
    const buyerData = await readJsonReference(latestArtifact(job, "buyer_matching"), config);
    const contactInput = await readJsonReference(job.inputReference, config);
    const output = enrichContacts(buyerData, contactInput);
    const reference = await writeArtifact(job, "contact_enrichment", output, config);
    return { outcome: "completed", artifact: { reference, note: "人物联系人和公司联系方式分离", counts: { people: output.people.length, companyContacts: output.companyContacts.length, coveredBuyers: output.coverage.coveredBuyers } } };
  }
  if (job.currentStage === "validation") {
    const enrichment = await readJsonReference(latestArtifact(job, "contact_enrichment"), config);
    const output = validateContacts(enrichment);
    const reference = await writeArtifact(job, "validation", output, config);
    return { outcome: "completed", artifact: { reference, note: output.limitation, counts: { people: output.people.length, companyContacts: output.companyContacts.length } } };
  }
  if (job.currentStage === "drafting") {
    const validation = await readJsonReference(latestArtifact(job, "validation"), config);
    const buyerData = await readJsonReference(latestArtifact(job, "buyer_matching"), config);
    const output = await draftContacts(validation, buyerData, job, config);
    const reference = await writeArtifact(job, "drafting", output, config);
    return {
      outcome: "completed",
      artifact: {
        reference,
        note: output.limitation,
        counts: {
          eligibleContacts: output.coverage.eligibleContacts,
          draftedContacts: output.coverage.draftedContacts,
          deferredContacts: output.coverage.deferredContacts,
        },
      },
    };
  }
  const required = {
    approval: "需要人工审核人、业务事实和收件人快照批准",
    sending: "生产发送保持关闭；需要 SMTP/DM Pro、邮箱验证和合规门槛",
    feedback: "需要服务商退信/投诉事件和收件箱回复回调",
  }[job.currentStage] || "需要人工输入";
  throw new InputNeeded(required);
}

async function processClaimedJob(job, config) {
  try {
    const result = await stageResult(job, config);
    const updated = await api(config, `/api/pipeline/jobs/${job.id}/stage`, {
      method: "POST",
      body: JSON.stringify({ owner: config.owner, stage: job.currentStage, ...result }),
    });
    if (updated.currentStage === "approval" && updated.status === "waiting_input") await autoAdvanceIfEnabled(updated, config);
    return updated;
  } catch (error) {
    const waiting = error instanceof InputNeeded;
    const updated = await api(config, `/api/pipeline/jobs/${job.id}/stage`, {
      method: "POST",
      body: JSON.stringify({
        owner: config.owner,
        stage: job.currentStage,
        outcome: waiting ? "waiting_input" : "paused",
        requiredInput: waiting ? error.message : "执行器异常，需检查日志后人工恢复",
        artifact: { note: cleanText(error.message, 900), counts: { errors: 1 } },
      }),
    });
    if (!waiting) {
      await api(config, "/api/ops/intervention-alert", {
        method: "POST",
        body: JSON.stringify({
          code: "pipeline_worker_paused",
          title: "流水线执行异常并已暂停",
          details: `任务 ${job.id}，阶段 ${job.currentStage}：${cleanText(error.message, 900)}`,
          instructions: `Open your local dashboard and inspect task ${job.id}. Resolve the recorded cause before retrying; do not duplicate a send.`,
        }),
      }).catch((alertError) => console.warn(`人工介入告警邮件发送失败：${cleanText(alertError.message, 300)}`));
    }
    return updated;
  }
}

async function runManagedBatchScan(config) {
  try {
    const mode = await api(config, "/api/delivery-mode");
    if (mode.mode !== "auto") return;
    const circuit = await api(config, "/api/delivery-circuit");
    if (circuit.open) {
      const blockers = circuit.recovery?.blockers || [];
      if (blockers.some((item) => item !== "cooldown_not_elapsed")) {
        await api(config, "/api/ops/intervention-alert", {
          method: "POST",
          body: JSON.stringify({
            code: "delivery_circuit_requires_intervention",
            title: "发件熔断未通过自主恢复核查",
            details: `原因 ${circuit.reason || "unknown"}；阻塞项 ${blockers.join(", ") || "unknown"}`,
            instructions: "打开邮件中心核对退信或投诉是否已进入抑制名单，并确认发件箱没有 sending 或 uncertain；不要手工重复发送。处理完成后服务器定时器会再次自主核查。",
          }),
        }).catch((error) => console.warn(`熔断告警邮件发送失败：${cleanText(error.message, 300)}`));
      }
      return;
    }
    const batch = await api(config, "/api/pipeline/daily-batch?limit=200&central=1");
    const inventory = await api(config, "/api/pipeline/inventory?limit=200");
    const inventoryCompanies = Number(inventory.inventory?.totalCompanies || inventory.selectedCompanyCount || 0);
    if ((!inventory.managedCycle?.collectionLocked && inventoryCompanies < config.managedSendCompanyThreshold) || !batch.selected?.length) return;
    await api(config, "/api/pipeline/central-batch/send", {
      method: "POST",
      body: JSON.stringify({ confirm: "SEND DAILY BATCH", reviewer: "managed-auto-sender" }),
      timeoutMs: 25 * 60_000,
    });
  } catch (error) {
    console.warn(`自动发送扫描保持暂停：${cleanText(error.message, 300)}`);
    if (!/每日发送硬上限|当日额度已用完|重复|已进入发送|发件箱状态/i.test(error.message)) {
      await api(config, "/api/ops/intervention-alert", {
        method: "POST",
        body: JSON.stringify({
          code: "pipeline_auto_send_blocked",
          title: "自动发送流程被阻断",
          details: `托管批次扫描：${cleanText(error.message, 900)}`,
          instructions: "打开运维前端查看发送门、熔断和邮箱额度；不要手工重复发送同一批次。",
        }),
      }).catch((alertError) => console.warn(`人工介入告警邮件发送失败：${cleanText(alertError.message, 300)}`));
    }
  }
}

async function autoAdvanceIfEnabled(job, config) {
  try {
    const mode = await api(config, "/api/delivery-mode");
    if (mode.mode !== "auto") return;
    if (job.automation?.mode === "managed") {
      await runManagedBatchScan(config);
      return;
    }
    const drafting = latestArtifact(job, "drafting");
    const artifact = await readJsonReference(drafting, config);
    const eligible = (artifact.drafts || []).map((draft, index) => ({ draft, index }))
      .filter(({ draft }) => Array.isArray(draft.evidenceSources) && draft.evidenceSources.length >= 2);
    if (!eligible.length) return;
    const approval = await api(config, `/api/pipeline/jobs/${job.id}/approve`, {
      method: "POST",
      body: JSON.stringify({
        confirm: `APPROVE PIPELINE ${job.id}`,
        reviewer: "managed-auto",
        draftIndexes: eligible.map(({ index }) => index),
        providerAuthorization: "managed-auto-with-existing-delivery-authorization",
        recipientEvidence: eligible.map(({ draft }) => ({
          deliverableConfirmed: true,
          currentEmploymentConfirmed: true,
          checkedAt: new Date().toISOString(),
          sources: draft.evidenceSources,
        })),
      }),
    });
    await api(config, `/api/pipeline/jobs/${approval.id}/send`, {
      method: "POST",
      body: JSON.stringify({ confirm: `SEND PIPELINE ${approval.id}` }),
    });
  } catch (error) {
    console.warn(`自动发送保持审批门：${cleanText(error.message, 300)}`);
    if (!/每日发送硬上限|当日额度已用完|重复|已进入发送|发件箱状态/i.test(error.message)) {
      await api(config, "/api/ops/intervention-alert", {
        method: "POST",
        body: JSON.stringify({
          code: "pipeline_auto_send_blocked",
          title: "自动发送流程被阻断",
          details: `任务 ${job.id}：${cleanText(error.message, 900)}`,
          instructions: `Open your local dashboard and inspect approval, delivery gates, and circuit state for task ${job.id}. Do not duplicate a send.`,
        }),
      }).catch((alertError) => console.warn(`人工介入告警邮件发送失败：${cleanText(alertError.message, 300)}`));
    }
  }
}

async function runWorker(options = parseArguments(process.argv.slice(2)), config = workerConfig()) {
  await fs.mkdir(config.artifactRoot, { recursive: true });
  const processed = [];
  await runManagedBatchScan(config);
  for (let index = 0; index < options.maxJobs; index += 1) {
    const claimed = await api(config, "/api/pipeline/claim-next", {
      method: "POST",
      body: JSON.stringify({ owner: config.owner, leaseSeconds: 300 }),
    });
    if (!claimed.job) break;
    const updated = await processClaimedJob(claimed.job, config);
    processed.push({ id: updated.id, stage: claimed.job.currentStage, status: updated.status, currentStage: updated.currentStage });
    await runManagedBatchScan(config);
    if (!options.drain || updated.status === "waiting_input" || updated.status === "circuit_open" || updated.status === "paused") break;
  }
  return { owner: config.owner, processed };
}

export {
  draftContacts,
  enrichContacts,
  matchBuyers,
  normalizeTrades,
  productFocusForHsCode,
  runWorker,
  validateContacts,
  validateDiscovery,
  workerConfig,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorker()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
