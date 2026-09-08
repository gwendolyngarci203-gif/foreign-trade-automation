import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qualifyBuyers } from "./company-qualification.mjs";

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
const EXPECTED_AUTO_SEND_NOOP = /每日发送硬上限|当日额度已用完|重复|已进入发送|发件箱状态|当前没有通过简单核验的集中审核草稿|没有通过简单核验/i;

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
    senderCompany: cleanText(env.PIPELINE_SENDER_COMPANY || "DaKings Printing Company", 200),
    senderName: cleanText(env.PIPELINE_SENDER_NAME, 120),
    senderTitle: cleanText(env.PIPELINE_SENDER_TITLE, 160),
    senderEmail: cleanText(env.PIPELINE_SENDER_EMAIL, 320),
    senderPhone: cleanText(env.PIPELINE_SENDER_PHONE, 120),
    senderWebsite: cleanText(env.PIPELINE_SENDER_WEBSITE, 320),
    companyBusiness: cleanText(
      env.PIPELINE_COMPANY_BUSINESS
        || "DaKings Cultural and Creative Co., Ltd provides book printing, binding, packaging, and post-press finishing services in China.",
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

// Persist the complete in-flight snapshot next to stage artifacts so a worker
// restart can resume from the API's currentStage without losing intermediate
// data.  Atomic rename keeps readers from observing a partial checkpoint.
async function writeCheckpoint(job, stage, payload, config) {
  const directory = path.join(config.artifactRoot, safeSegment(job.id));
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, "checkpoint.json");
  const existing = await fs.readFile(target, "utf8").then(JSON.parse).catch(() => null);
  const contactProgress = payload.contactProgress ?? existing?.contactProgress;
  const checkpoint = {
    schemaVersion: 1,
    companyBatchId: job.id,
    country: job.country || "",
    businessKeywords: Array.isArray(job.businessKeywords) ? job.businessKeywords : [],
    discoveryResults: payload.discoveryResults || null,
    normalizedCompanies: payload.normalizedCompanies || null,
    matchedCompanies: payload.matchedCompanies || null,
    contacts: payload.contacts || null,
    validatedEmails: payload.validatedEmails || null,
    drafts: payload.drafts || null,
    ...(contactProgress ? { contactProgress } : {}),
    currentStage: stage,
    updatedAt: new Date().toISOString(),
  };
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  await fs.rename(temp, target);
  return pathToFileURL(target).href;
}

async function readCheckpoint(job, config) {
  const target = path.join(config.artifactRoot, safeSegment(job.id), "checkpoint.json");
  const checkpoint = await fs.readFile(target, "utf8").then(JSON.parse).catch(() => null);
  if (checkpoint?.companyBatchId !== job.id || checkpoint?.currentStage !== "contact_enrichment") return null;
  return checkpoint;
}

async function checkpointPayload(job, stage, output, config) {
  const refs = Object.fromEntries((job.artifacts || []).map((item) => [item.stage, item.reference]));
  const read = async (name) => refs[name] ? readJsonReference(refs[name], config).catch(() => null) : null;
  return {
    discoveryResults: stage === "discovery" ? output : await read("discovery"),
    normalizedCompanies: stage === "trade_normalization" ? output : await read("trade_normalization"),
    matchedCompanies: stage === "buyer_matching" ? output : await read("buyer_matching"),
    contacts: stage === "contact_enrichment" ? output : await read("contact_enrichment"),
    validatedEmails: stage === "validation" ? output : await read("validation"),
    drafts: stage === "drafting" ? output : await read("drafting"),
  };
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
  const kind = String(source?.kind || "");
  const isHsCode = kind === "netease-customs-discovery";
  const isCountryBusiness = kind === "netease-country-business-discovery";
  const isKeyword = kind === "netease-keyword-discovery";
  if (!(isHsCode || isCountryBusiness || isKeyword) || !Array.isArray(source.records)) {
    throw new InputNeeded("discovery 输入类型不受支持，需为网易HSCode、关键词或国家+业务范围结果");
  }
  if (isHsCode && !/^\d{6,10}$/.test(String(source.query || ""))) throw new InputNeeded("discovery 输入缺少有效 HSCode 查询值");
  if (!isHsCode && !String(source.query || "").trim()) throw new InputNeeded("discovery 输入缺少关键词查询值");
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
    hsCode: isHsCode ? normalizeHsCode(record.hsCode) : "",
    hsCodeDescription: cleanText(record.hsCodeDescription, 500),
    productDescription: cleanText(record.productDescription, 3000),
  })).filter((record) => record.company && (isHsCode ? record.hsCode : true));
  if (!records.length) throw new InputNeeded("discovery 输入没有可用的公司记录");
  return {
    schemaVersion: 1,
    kind: "pipeline-discovery",
    query: isHsCode ? normalizeHsCode(source.query) : cleanText(source.query, 500),
    normalizedHsCode: isHsCode ? normalizeHsCode(source.normalizedHsCode || records[0].hsCode) : "",
    country: isCountryBusiness ? cleanText(source.country, 120) : "",
    businessKeywords: isCountryBusiness && Array.isArray(source.normalizedBusinessKeywords)
      ? source.normalizedBusinessKeywords.map((item) => cleanText(item, 120)).filter(Boolean).slice(0, 8)
      : [],
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
      productDescriptions: [],
      retained: true,
    };
    if (!group.hsCodes.includes(record.hsCode)) group.hsCodes.push(record.hsCode);
    group.amountUsd = Math.max(group.amountUsd || 0, record.amountUsdValue || 0) || null;
    group.transactions = Math.max(group.transactions, record.transactionsValue || 0);
    if (record.latestTradeDate > group.latestTradeDate) group.latestTradeDate = record.latestTradeDate;
    group.hasVisibleContactEntry ||= record.hasContact;
    group.evidenceRows.push({ page: record.page, row: record.row, rowKey: record.rowKey });
    if (record.productDescription && !group.productDescriptions.includes(record.productDescription)) group.productDescriptions.push(record.productDescription);
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

function mergeContactEnrichment(target, source) {
  const seen = new Set([
    ...(target.people || []),
    ...(target.companyContacts || []),
  ].map((item) => `${item.companyKey}|${item.email}|${item.phone}|${String(item.name || "").toLowerCase()}`));
  for (const type of ["people", "companyContacts"]) {
    for (const item of source[type] || []) {
      const key = `${item.companyKey}|${item.email}|${item.phone}|${String(item.name || "").toLowerCase()}`;
      if (!seen.has(key)) target[type].push(item);
      seen.add(key);
    }
  }
}

function isCompanyContactDataError(error) {
  return ["NO_CONTACTS", "NO_EMAIL", "INVALID_COMPANY_DATA"].includes(error?.code);
}

async function enrichContactsWithCheckpoint(job, buyerData, contactInput, config) {
  if (contactInput?.kind !== "netease-contact-enrichment" || !Array.isArray(contactInput.records)) {
    throw new InputNeeded("联系人阶段需要 kind=netease-contact-enrichment 的可追溯 JSON 输入");
  }
  const checkpoint = await readCheckpoint(job, config);
  const priorProgress = checkpoint?.contactProgress || {};
  const completedCompanies = Array.isArray(priorProgress.completedCompanies) ? [...priorProgress.completedCompanies] : [];
  const failedCompanies = Array.isArray(priorProgress.failedCompanies) ? [...priorProgress.failedCompanies] : [];
  const completedIds = new Set([...completedCompanies, ...failedCompanies].map((item) => item.companyId));
  const output = checkpoint?.contacts?.kind === "pipeline-contact-enrichment"
    ? { ...checkpoint.contacts, people: [...(checkpoint.contacts.people || [])], companyContacts: [...(checkpoint.contacts.companyContacts || [])] }
    : { schemaVersion: 1, kind: "pipeline-contact-enrichment", people: [], companyContacts: [], coverage: {} };
  const buyers = buyerData.buyers || [];

  for (const buyer of buyers) {
    const companyId = cleanText(buyer.companyId || buyer.rowKey || buyer.companyKey || buyer.company, 300);
    if (completedIds.has(companyId)) continue;
    await writeCheckpoint(job, "contact_enrichment", {
      ...(await checkpointPayload(job, "contact_enrichment", output, config)),
      contactProgress: { stage: "contact_enrichment", completedCompanies, failedCompanies, currentCompanyId: companyId },
    }, config);
    try {
      const records = contactInput.records.filter((record) => normalizeCompany(record.company) === buyer.companyKey);
      mergeContactEnrichment(output, enrichContacts({ ...buyerData, buyers: [buyer] }, { ...contactInput, records }));
      completedCompanies.push({ companyId, companyName: cleanText(buyer.company, 300), completedAt: new Date().toISOString() });
      completedIds.add(companyId);
    } catch (error) {
      if (!isCompanyContactDataError(error)) {
        const contactProgress = {
          stage: "contact_enrichment",
          completedCompanies,
          failedCompanies,
          currentCompanyId: companyId,
          error: { companyId, reason: cleanText(error.message, 500), at: new Date().toISOString() },
        };
        await writeCheckpoint(job, "contact_enrichment", {
          ...(await checkpointPayload(job, "contact_enrichment", output, config)),
          contactProgress,
        }, config).catch((checkpointError) => {
          console.error(JSON.stringify({ event: "contact_checkpoint_error_write_failed", batchId: job.id, companyId, error: cleanText(checkpointError.message, 500) }));
        });
        throw error;
      }
      failedCompanies.push({ companyId, reason: cleanText(error.message, 500) });
      completedIds.add(companyId);
    }
    const coveredBuyers = new Set([...output.people, ...output.companyContacts].map((item) => item.companyKey)).size;
    output.coverage = { buyers: buyers.length, coveredBuyers, uncoveredBuyers: Math.max(buyers.length - coveredBuyers, 0) };
    await writeArtifact(job, "contact_enrichment", output, config);
    try {
      await writeCheckpoint(job, "contact_enrichment", {
        ...(await checkpointPayload(job, "contact_enrichment", output, config)),
        contactProgress: { stage: "contact_enrichment", completedCompanies, failedCompanies, currentCompanyId: null },
      }, config);
    } catch (error) {
      console.error(JSON.stringify({ event: "contact_artifact_saved_checkpoint_failed", batchId: job.id, companyId, error: cleanText(error.message, 500) }));
      throw error;
    }
  }
  return output;
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
  if (normalized.startsWith("490300")) {
    return "children's picture, drawing, coloring, and activity books, including related binding and finishing";
  }
  return `printed products in the internally matched HSCode ${normalized}`;
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
  const subjects = ["Book production for your team", "Printing support for upcoming titles", "A practical book production option"];
  const openings = [
    `${contact.company}'s publishing activity${country ? ` in ${country}` : ""} appears relevant to our production work in ${context.productFocus}.`,
    `We are contacting ${contact.company} because its book programs appear relevant to our printing, binding, and finishing capabilities.`,
    `Your work as ${role} at ${contact.company} may involve evaluating reliable production options for upcoming book programs.`,
  ];
  const questions = [
    "Would it be useful to review one current specification or RFQ?",
    "Could we send a concise capability summary for a current or upcoming title?",
    "Is there a suitable specification we could use for a practical quotation comparison?",
  ];
  const body = `Hi ${firstName},\n\n${openings[variant]} ${context.companyBusiness} We can support short or repeat production runs with coordinated prepress, binding, packaging, and post-press finishing. For ${role}, the most useful starting point is usually a clear specification covering format, page count, materials, quantity, finishing, and delivery timing.\n\n${questions[variant]} We will keep any response focused on the requested format and avoid sending unrelated material.\n\n${context.senderCompany}`;
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

  const productFocus = productFocusForHsCode(job.hsCode, config.productFocus || (job.businessKeywords || []).join(", "));
  const managed = job.automation?.mode === "managed";
  const draftLimit = managed ? 500 : config.draftLimit;
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
    await writeCheckpoint(job, "discovery", await checkpointPayload(job, "discovery", output, config), config);
    const totalResults = output.pagination.totalResults ?? output.source.resultTotal ?? 0;
    const pages = output.pagination.totalPages ?? output.source.pageTotal ?? 0;
    return { outcome: "completed", artifact: { reference, note: "网易海关数据可见页面金丝雀", counts: { records: output.records.length, totalResults, pages } } };
  }
  if (job.currentStage === "trade_normalization") {
    const discovery = await readJsonReference(latestArtifact(job, "discovery"), config);
    const output = normalizeTrades(discovery);
    const reference = await writeArtifact(job, "trade_normalization", output, config);
    await writeCheckpoint(job, "trade_normalization", await checkpointPayload(job, "trade_normalization", output, config), config);
    return { outcome: "completed", artifact: { reference, note: "去重、金额和主体类型标准化；不删除物流候选", counts: { records: output.records.length } } };
  }
  if (job.currentStage === "buyer_matching") {
    const trades = await readJsonReference(latestArtifact(job, "trade_normalization"), config);
    const qualification = await api(config, "/api/company-qualification").catch(() => ({ enabled: false }));
    const output = qualifyBuyers(matchBuyers(trades), qualification);
    const reference = await writeArtifact(job, "buyer_matching", output, config);
    await writeCheckpoint(job, "buyer_matching", await checkpointPayload(job, "buyer_matching", output, config), config);
    return { outcome: "completed", artifact: { reference, note: output.policy, counts: { buyers: output.buyers.length, review: output.buyers.filter((item) => item.matchConfidence === "review").length } } };
  }
  if (job.currentStage === "contact_enrichment") {
    const buyerData = await readJsonReference(latestArtifact(job, "buyer_matching"), config);
    const contactInput = await readJsonReference(job.inputReference, config);
    const qualified = buyerData.qualification?.enabled ? { ...buyerData, buyers: buyerData.buyers.filter((buyer) => buyer.qualification?.passed) } : buyerData;
    const output = await enrichContactsWithCheckpoint(job, qualified, contactInput, config);
    const reference = await writeArtifact(job, "contact_enrichment", output, config);
    await writeCheckpoint(job, "contact_enrichment", await checkpointPayload(job, "contact_enrichment", output, config), config);
    return { outcome: "completed", artifact: { reference, note: "人物联系人和公司联系方式分离", counts: { people: output.people.length, companyContacts: output.companyContacts.length, coveredBuyers: output.coverage.coveredBuyers } } };
  }
  if (job.currentStage === "validation") {
    const enrichment = await readJsonReference(latestArtifact(job, "contact_enrichment"), config);
    const output = validateContacts(enrichment);
    const reference = await writeArtifact(job, "validation", output, config);
    await writeCheckpoint(job, "validation", await checkpointPayload(job, "validation", output, config), config);
    return { outcome: "completed", artifact: { reference, note: output.limitation, counts: { people: output.people.length, companyContacts: output.companyContacts.length } } };
  }
  if (job.currentStage === "drafting") {
    const validation = await readJsonReference(latestArtifact(job, "validation"), config);
    const buyerData = await readJsonReference(latestArtifact(job, "buyer_matching"), config);
    const output = await draftContacts(validation, buyerData, job, config);
    const reference = await writeArtifact(job, "drafting", output, config);
    await writeCheckpoint(job, "drafting", await checkpointPayload(job, "drafting", output, config), config);
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
          instructions: `打开 https://ops.dakingscc.cn/ 查看任务 ${job.id} 的当前阶段和错误记录，并在 Codex 项目对话回复“处理流水线任务 ${job.id}”。查明原因前不要重复发送。`,
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
    const batch = await api(config, "/api/pipeline/daily-batch?limit=1000&central=1");
    const inventory = await api(config, "/api/pipeline/inventory?limit=1000");
    const inventoryCompanies = Number(inventory.inventory?.totalCompanies || inventory.selectedCompanyCount || 0);
    if ((!inventory.managedCycle?.collectionLocked && inventoryCompanies < config.managedSendCompanyThreshold) || !batch.selected?.length) return;
    await api(config, "/api/pipeline/central-batch/send", {
      method: "POST",
      body: JSON.stringify({ confirm: "SEND DAILY BATCH", reviewer: "managed-auto-sender" }),
      timeoutMs: 25 * 60_000,
    });
  } catch (error) {
    const expectedNoop = EXPECTED_AUTO_SEND_NOOP.test(error.message);
    if (!expectedNoop) console.warn(`自动发送扫描保持暂停：${cleanText(error.message, 300)}`);
    // A completed/filtered batch can legitimately have no remaining sendable drafts.
    // Keep alerts for real delivery, quota, circuit, and state failures.
    if (!expectedNoop) {
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
    const expectedNoop = EXPECTED_AUTO_SEND_NOOP.test(error.message);
    if (!expectedNoop) console.warn(`自动发送保持审批门：${cleanText(error.message, 300)}`);
    if (!expectedNoop) {
      await api(config, "/api/ops/intervention-alert", {
        method: "POST",
        body: JSON.stringify({
          code: "pipeline_auto_send_blocked",
          title: "自动发送流程被阻断",
          details: `任务 ${job.id}：${cleanText(error.message, 900)}`,
          instructions: `打开 https://ops.dakingscc.cn/ 查看任务 ${job.id} 的审批、发送门和熔断状态，并在 Codex 项目对话回复“处理自动发送阻断 ${job.id}”。不要手工重复发送同一任务。`,
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
  enrichContactsWithCheckpoint,
  matchBuyers,
  normalizeTrades,
  productFocusForHsCode,
  runWorker,
  validateContacts,
  validateDiscovery,
  writeCheckpoint,
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
