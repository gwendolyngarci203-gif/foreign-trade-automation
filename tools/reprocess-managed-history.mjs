import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.resolve(toolDir, "..");
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_VALID_STATUSES = new Set(["domain_valid", "deliverable", "accept_all"]);

function normalizeCompany(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\b(incorporated|inc|limited|ltd|llc|corp|corporation|company|co|pvt|plc)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clean(value, limit = 1000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function emailFingerprint(email) {
  return crypto.createHash("sha256").update(clean(email, 320).toLowerCase()).digest("hex");
}

function validEmail(email) {
  return EMAIL_PATTERN.test(clean(email, 320).toLowerCase());
}

function relativeEvidence(reference, workspaceRoot) {
  const value = clean(reference, 1000);
  if (!value) return "";
  const candidate = path.resolve(workspaceRoot, value.replace(/^file:\/\//i, ""));
  return candidate.startsWith(`${workspaceRoot}${path.sep}`) ? candidate : "";
}

async function walk(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const item = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walk(item));
    else files.push(item);
  }
  return files;
}

function evidenceUrls(record, company = {}) {
  return [...new Set([
    record.website,
    company.website,
    record.linkedin,
    ...(Array.isArray(record.evidenceSources) ? record.evidenceSources : []),
  ].map((value) => clean(value, 500)).filter((value) => /^https?:\/\/[^\s]+$/i.test(value)))].slice(0, 5);
}

function qualifyRecord(record, validationByHash, suppressionHashes) {
  const company = clean(record.company, 300);
  const email = clean(record.email, 320).toLowerCase();
  const reasons = [];
  if (!company) reasons.push("missing_company");
  if (!validEmail(email)) reasons.push("invalid_email");
  const hash = email ? emailFingerprint(email) : "";
  const validationStatus = validationByHash.get(hash) || "unverified";
  const suppressed = Boolean(hash && suppressionHashes.has(hash));
  if (suppressed) reasons.push("suppressed");
  if (!clean(record.source) && !clean(record.evidence)) reasons.push("missing_source");
  return {
    ...record,
    company,
    companyKey: normalizeCompany(company),
    email,
    name: clean(record.name, 200),
    title: clean(record.title, 250),
    source: clean(record.source || "NetEase visible contact row", 500),
    evidence: clean(record.evidence, 1000),
    evidenceSources: evidenceUrls(record),
    emailHash: hash,
    validationStatus,
    domainStatus: DOMAIN_VALID_STATUSES.has(validationStatus) ? "validated" : "syntax_only",
    qualificationStatus: reasons.length ? "rejected" : "qualified",
    qualificationReasons: reasons,
    contactNameFallback: clean(record.name) ? "" : "Purchasing Team",
  };
}

function mergeRecord(existing, candidate) {
  if (!existing) return candidate;
  const merged = { ...existing };
  for (const field of ["company", "name", "title", "phone", "website", "domain", "source", "evidence"]) {
    if (!clean(merged[field]) && clean(candidate[field])) merged[field] = candidate[field];
  }
  merged.evidenceSources = [...new Set([...(existing.evidenceSources || []), ...(candidate.evidenceSources || [])])].slice(0, 5);
  merged.rawSources = [...new Set([...(existing.rawSources || []), ...(candidate.rawSources || [])])].slice(0, 10);
  return merged;
}

async function loadJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function reprocessHistory({ workspaceRoot = workspaceDir, outputRoot = path.join(workspaceDir, "outputs", "history_reprocessed"), targetCompanies = 100 } = {}) {
  const outputBase = path.resolve(outputRoot);
  const historyFiles = (await walk(path.join(workspaceRoot, "outputs")))
    .filter((file) => /netease_contact_enrichment_page_.*\.json$/i.test(file) && !file.startsWith(`${outputBase}${path.sep}`))
    .sort();
  const validationStore = await loadJson(path.join(workspaceRoot, "app", "data", "contact-validation.json"));
  const suppressionStore = await loadJson(path.join(workspaceRoot, "app", "data", "suppressions.json"));
  const validationByHash = new Map((validationStore.records || []).map((item) => [item.emailHash, item.status]));
  const suppressionHashes = new Set((suppressionStore.records || []).map((item) => item.emailHash));
  const pages = new Map();
  const globalByEmail = new Map();
  const rawEvidenceFiles = new Set();
  const evidencePages = new Map();

  for (const file of historyFiles) {
    const payload = await loadJson(file);
    const pageNumber = Number(payload.pageNumber || file.match(/page_(\d+)/i)?.[1] || 0);
    if (!pageNumber) continue;
    const page = pages.get(pageNumber) || { pageNumber, sourceFiles: [], emailKeys: new Set(), companies: new Set() };
    page.sourceFiles.push(path.relative(workspaceRoot, file));
    const linkedCompanies = new Set();
    for (const source of payload.records || []) {
      const companyKey = normalizeCompany(source.company);
      if (companyKey) linkedCompanies.add(companyKey);
      if (source.evidence) {
        const evidencePath = relativeEvidence(source.evidence, workspaceRoot);
        if (evidencePath) {
          rawEvidenceFiles.add(evidencePath);
          const linkedPages = evidencePages.get(evidencePath) || new Set();
          linkedPages.add(pageNumber);
          evidencePages.set(evidencePath, linkedPages);
        }
      }
      const record = qualifyRecord({ ...source, evidence: source.evidence || path.relative(workspaceRoot, file) }, validationByHash, suppressionHashes);
      if (!record.companyKey || !record.emailHash) continue;
      const existing = globalByEmail.get(record.email);
      const merged = mergeRecord(existing, record);
      globalByEmail.set(record.email, merged);
      page.emailKeys.add(record.email);
    }
    page.companies = linkedCompanies;
    pages.set(pageNumber, page);
  }

  // Raw evidence occasionally contains email rows that the old exporter dropped.
  for (const evidencePath of rawEvidenceFiles) {
    const raw = await loadJson(evidencePath).catch(() => null);
    for (const result of raw?.rawResults || []) {
      if (result.status && result.status !== "collected") continue;
      const company = result.company?.name || result.expectedCompany || "";
      const companyKey = normalizeCompany(company);
      const linkedPageNumbers = evidencePages.get(evidencePath) || new Set();
      const page = [...pages.values()].find((candidate) => linkedPageNumbers.has(candidate.pageNumber) && candidate.companies.has(companyKey))
        || [...pages.values()].find((candidate) => linkedPageNumbers.has(candidate.pageNumber));
      if (!page) continue;
      for (const contact of result.contacts || []) {
        if (!contact.email) continue;
        const record = qualifyRecord({
          ...contact,
          company: company || page.records[0]?.company,
          website: contact.website || result.company?.website,
          domain: contact.domain || result.company?.domain,
          evidence: path.relative(workspaceRoot, evidencePath),
          source: contact.source || "NetEase raw visible contact row",
          evidenceSources: [result.company?.website, contact.linkedin].filter(Boolean),
        }, validationByHash, suppressionHashes);
        const merged = mergeRecord(globalByEmail.get(record.email), record);
        globalByEmail.set(record.email, { ...merged, rawSources: [...new Set([...(merged.rawSources || []), path.relative(workspaceRoot, evidencePath)])] });
        page.emailKeys.add(record.email);
      }
    }
  }

  const records = [...globalByEmail.values()];
  const qualified = records.filter((record) => record.qualificationStatus === "qualified");
  const companyOrder = [...new Set(qualified.map((record) => record.companyKey).filter(Boolean))].slice(0, Math.max(1, targetCompanies));
  const allowedCompanies = new Set(companyOrder);
  for (const record of records) {
    record.qualifiedCompany = allowedCompanies.has(record.companyKey);
    if (record.qualificationStatus === "qualified" && !record.qualifiedCompany) {
      record.qualificationStatus = "deferred_company_cap";
    }
  }

  await fs.mkdir(outputBase, { recursive: true });
  const pageResults = [];
  for (const page of [...pages.values()].sort((left, right) => left.pageNumber - right.pageNumber)) {
    const outputRecords = records.filter((record) => page.emailKeys.has(record.email));
    const qualifiedRecords = outputRecords.filter((record) => record.qualificationStatus === "qualified" && record.qualifiedCompany);
    const output = {
      schemaVersion: 2,
      kind: "netease-contact-enrichment",
      query: "4903000",
      hsCode: "4903000",
      pageNumber: page.pageNumber,
      handoffKey: "history-reprocessed-v2",
      reprocessedAt: new Date().toISOString(),
      policy: "low_threshold_company_email_source; name_employment_and_two_source_checks_not_required",
      counts: {
        records: outputRecords.length,
        qualifiedRecords: qualifiedRecords.length,
        rejectedRows: outputRecords.length - qualifiedRecords.length,
        companiesProcessed: new Set(outputRecords.map((record) => record.companyKey).filter(Boolean)).size,
        qualifiedCompanies: new Set(qualifiedRecords.map((record) => record.companyKey)).size,
      },
      records: outputRecords,
      sourceFiles: page.sourceFiles,
    };
    const target = path.join(outputBase, `netease_contact_enrichment_page_${String(page.pageNumber).padStart(3, "0")}.json`);
    await fs.writeFile(target, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    pageResults.push({ page: page.pageNumber, file: path.relative(workspaceRoot, target), records: outputRecords.length, qualified: qualifiedRecords.length, companies: output.counts.companiesProcessed });
  }
  const report = {
    schemaVersion: 1,
    kind: "managed-history-reprocess-report",
    generatedAt: new Date().toISOString(),
    policy: "公司非空 + 邮箱语法有效 + 来源可追溯 + 抑制检查；姓名、在职证明和两条独立来源不是硬门槛",
    inputFiles: historyFiles.length,
    rawEvidenceFiles: rawEvidenceFiles.size,
    totalUniqueContacts: records.length,
    qualifiedContacts: qualified.filter((record) => record.qualifiedCompany).length,
    rejectedContacts: records.filter((record) => record.qualificationStatus !== "qualified").length,
    qualifiedCompanies: allowedCompanies.size,
    targetCompanies: Math.max(1, targetCompanies),
    pages: pageResults,
    statusBreakdown: Object.fromEntries([...new Set(records.map((record) => record.validationStatus))].map((status) => [status, records.filter((record) => record.validationStatus === status).length])),
    suppressionExcluded: records.filter((record) => record.qualificationReasons?.includes("suppressed")).length,
  };
  await fs.writeFile(path.join(outputBase, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function selfTest() {
  const validation = new Map([[emailFingerprint("named@example.test"), "domain_valid"]]);
  const suppression = new Set([emailFingerprint("blocked@example.test")]);
  assert(qualifyRecord({ company: "Acme Co", email: "generic@example.test", source: "visible" }, validation, suppression).qualificationStatus === "qualified");
  assert(qualifyRecord({ company: "Acme Co", email: "blocked@example.test", source: "visible" }, validation, suppression).qualificationStatus === "rejected");
  const merged = mergeRecord(null, qualifyRecord({ company: "Acme", email: "x@example.test", source: "visible" }, validation, suppression));
  assert(mergeRecord(merged, { ...merged, name: "Purchasing Team" }).name === "Purchasing Team");
  console.log(JSON.stringify({ ok: true, check: "managed_history_reprocess" }));
}

function assert(condition) {
  if (!condition) throw new Error("self-test failed");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.argv.includes("--self-test")) selfTest();
else if (isMain) {
  const outputRoot = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  reprocessHistory({ outputRoot })
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

export { emailFingerprint, mergeRecord, qualifyRecord, reprocessHistory };
