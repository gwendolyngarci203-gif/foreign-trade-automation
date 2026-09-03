import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  draftContacts,
  enrichContacts,
  enrichContactsWithCheckpoint,
  matchBuyers,
  normalizeTrades,
  validateContacts,
  validateDiscovery,
  writeCheckpoint,
  workerConfig,
} from "../pipeline-worker.mjs";

const countryDiscovery = validateDiscovery({
  kind: "netease-country-business-discovery",
  query: "board games books paper packaging",
  country: "Poland",
  records: [{ company: "Polish Games Sp. z o.o.", country: "Poland", page: 1, row: 1 }],
});
assert.equal(countryDiscovery.records.length, 1);
assert.equal(countryDiscovery.records[0].hsCode, "");

const workerSource = await fs.readFile(new URL("../pipeline-worker.mjs", import.meta.url), "utf8");
assert.match(workerSource, /timeoutMs:\s*150_000/, "AI drafting must allow the local API to finish its bounded upstream request");
assert.match(workerSource, /const draftLimit = managed \? 500 : config\.draftLimit/, "managed drafting must target the full 500-message daily batch");
assert.match(workerSource, /daily-batch\?limit=1000&central=1/, "managed worker must scan existing central-batch drafts");
assert.match(workerSource, /pipeline\/inventory\?limit=1000/, "managed worker must gate sending on combined company inventory");
assert.match(workerSource, /central-batch\/send[\s\S]{0,300}timeoutMs:\s*25\s*\*\s*60_000/, "managed central sending must outlive a full sequential SMTP batch");
assert.match(workerSource, /await runManagedBatchScan\(config\)/, "managed worker must scan before and after claimed work");
assert.match(workerSource, /当前没有通过简单核验的集中审核草稿\|没有通过简单核验/, "empty managed batches must not raise intervention alerts");

const discovery = validateDiscovery({
  kind: "netease-customs-discovery",
  query: "4903000",
  normalizedHsCode: "490300",
  pagination: {},
  source: { resultTotal: 31607, pageTotal: 500 },
  records: [
    { rowKey: "a", company: "Publisher Inc.", country: "美国", hsCode: "4903000000", amountUsd: "10,000.00", transactions: "8", hasContact: true },
    { rowKey: "b", company: "Forward Freight LLC", country: "美国", hsCode: "490300", amountUsd: "未公开", transactions: "2", hasContact: false },
  ],
});
assert.equal(discovery.records.length, 2);
assert.equal(discovery.source.resultTotal, 31607);
assert.equal(discovery.source.pageTotal, 500);

const trades = normalizeTrades(discovery);
assert.equal(trades.records.length, 2);
assert.equal(trades.records.find((item) => item.company === "Forward Freight LLC").amountUsdValue, null);
assert.equal(trades.records.find((item) => item.company === "Forward Freight LLC").entityHint, "logistics_or_intermediary");

const buyers = matchBuyers(trades);
assert.equal(buyers.buyers.length, 2);
assert.ok(buyers.buyers.every((item) => item.retained));

const enrichment = enrichContacts(buyers, {
  kind: "netease-contact-enrichment",
  records: [
    { company: "Publisher Inc.", name: "Alice Buyer", title: "Purchasing Manager", email: "alice@example.test", source: "visible-detail", evidenceSources: ["https://www.linkedin.com/in/alice-buyer"] },
    { company: "Publisher Inc.", name: "", email: "info@example.test", phone: "+1 555 0000", source: "company-site" },
    { company: "Unknown Co.", name: "Ignored", email: "ignored@example.test", source: "unmatched" },
  ],
});
assert.equal(enrichment.people.length, 1);
assert.equal(enrichment.companyContacts.length, 1);
assert.equal(enrichment.coverage.coveredBuyers, 1);
assert.equal(enrichment.coverage.uncoveredBuyers, 1);
assert.deepEqual(enrichment.people[0].evidenceSources, ["https://www.linkedin.com/in/alice-buyer"]);

const checkpointRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pipeline-company-resume-"));
try {
  const checkpointConfig = { artifactRoot: checkpointRoot, inputRoot: checkpointRoot, allowedRoots: [checkpointRoot] };
  const checkpointJob = { id: "company-resume", country: "Poland", businessKeywords: ["board games"], artifacts: [] };
  const checkpointBuyers = { buyers: Array.from({ length: 50 }, (_, index) => ({ company: `Company ${index + 1}`, companyKey: String(index + 1) })) };
  const checkpointContacts = { kind: "netease-contact-enrichment", records: checkpointBuyers.buyers.flatMap((buyer, index) => [1, 2].map((number) => ({ company: buyer.company, name: `Contact ${number}`, email: `c${index + 1}-${number}@example.test` }))) };
  const partial = await enrichContactsWithCheckpoint(checkpointJob, { buyers: checkpointBuyers.buyers.slice(0, 20) }, checkpointContacts, checkpointConfig);
  assert.equal(partial.people.length, 40);
  const resumed = await enrichContactsWithCheckpoint(checkpointJob, checkpointBuyers, checkpointContacts, checkpointConfig);
  assert.equal(resumed.people.length, 100);
  assert.equal(new Set(resumed.people.map((item) => `${item.companyKey}|${item.email}`)).size, 100);
  const checkpoint = JSON.parse(await fs.readFile(path.join(checkpointRoot, "company-resume", "checkpoint.json"), "utf8"));
  assert.equal(checkpoint.contactProgress.completedCompanies.length, 50);
  assert.equal(checkpoint.contactProgress.failedCompanies.length, 0);
  assert.equal(checkpoint.contactProgress.currentCompanyId, null);

  await writeCheckpoint(checkpointJob, "validation", { validatedEmails: { people: resumed.people } }, checkpointConfig);
  const validationCheckpoint = JSON.parse(await fs.readFile(path.join(checkpointRoot, "company-resume", "checkpoint.json"), "utf8"));
  assert.equal(validationCheckpoint.currentStage, "validation");
  assert.equal(validationCheckpoint.contactProgress.completedCompanies.length, 50);
  assert.equal(validationCheckpoint.contactProgress.failedCompanies.length, 0);
  assert.equal(validationCheckpoint.contactProgress.currentCompanyId, null);

  const businessError = Object.assign(new Error("company has no usable contact data"), { code: "INVALID_COMPANY_DATA" });
  const businessRecord = { get company() { throw businessError; } };
  await enrichContactsWithCheckpoint(
    { id: "company-business-error", artifacts: [] },
    { buyers: [{ company: "Business Error", companyKey: "business error" }] },
    { kind: "netease-contact-enrichment", records: [businessRecord] },
    checkpointConfig,
  );
  const businessCheckpoint = JSON.parse(await fs.readFile(path.join(checkpointRoot, "company-business-error", "checkpoint.json"), "utf8"));
  assert.equal(businessCheckpoint.contactProgress.failedCompanies.length, 1);

  const runtimeRecord = { get company() { throw new Error("network runtime failure"); } };
  await assert.rejects(() => enrichContactsWithCheckpoint(
    { id: "company-system-error", artifacts: [] },
    { buyers: [{ company: "System Error", companyKey: "system error" }] },
    { kind: "netease-contact-enrichment", records: [runtimeRecord] },
    checkpointConfig,
  ), /network runtime failure/);
  const systemCheckpoint = JSON.parse(await fs.readFile(path.join(checkpointRoot, "company-system-error", "checkpoint.json"), "utf8"));
  assert.match(systemCheckpoint.contactProgress.error.reason, /network runtime failure/);
  assert.equal(systemCheckpoint.contactProgress.failedCompanies.length, 0);
} finally {
  await fs.rm(checkpointRoot, { recursive: true, force: true });
}

const validation = validateContacts(enrichment);
assert.equal(validation.people[0].syntaxStatus, "syntax_valid");
assert.equal(validation.people[0].validationStatus, "unverified");
assert.match(validation.limitation, /not_deliverability/);

const draftRequests = [];
const drafting = await draftContacts(
  validation,
  buyers,
  { hsCode: "4903000" },
  {
    senderCompany: "DaKings Printing Company",
    senderName: "Emma",
    senderTitle: "",
    senderEmail: "emma@example.test",
    senderPhone: "",
    senderWebsite: "",
    companyBusiness: "Book printing, binding, packaging, and finishing.",
    productFocus: "",
    draftLimit: 20,
    draftDelayMs: 1500,
  },
  async (request) => {
    draftRequests.push(request);
    return {
      subject: `Printing support for ${request.buyerCompany}`,
      body: `Hi ${request.contactName},\n\nA concise, evidence-based test draft.`,
      model: "gpt-5.6-sol-test",
      wordCount: 6,
      warnings: [],
    };
  },
  async () => {},
);
assert.equal(drafting.drafts.length, 1);
assert.equal(drafting.drafts[0].approvalStatus, "pending_human_review");
assert.equal(draftRequests[0].contactRole, "Purchasing Manager");
assert.equal(draftRequests[0].senderName, "Emma");
assert.deepEqual(draftRequests[0].avoidSubjects, []);
assert.equal(draftRequests[0].templateFamily, "first_touch");
assert.equal(draftRequests[0].templateVariant, 0);
assert.match(draftRequests[0].productFocus, /children's picture/);
assert.match(drafting.limitation, /human_approval/);

const managedDrafting = await draftContacts(
  { people: [validation.people[0], { ...validation.people[0], name: "Bob Buyer", email: "bob@example.test", title: "Editorial Director" }] },
  buyers,
  { hsCode: "4903000", automation: { mode: "managed" } },
  { senderCompany: "DaKings Printing Company", companyBusiness: "DaKings provides book printing, binding, packaging, and finishing services.", productFocus: "", draftLimit: 20, draftDelayMs: 1500 },
  async () => { throw new Error("managed templates must not call AI"); },
  async () => {},
);
assert.equal(managedDrafting.drafts.length, 2);
assert.equal(new Set(managedDrafting.drafts.map((draft) => draft.company)).size, 1);
assert.equal(managedDrafting.drafts[0].model, "managed-template");
assert.equal(managedDrafting.drafts[0].approvalStatus, "central_batch_review_pending");
assert.match(managedDrafting.limitation, /central_batch_review/);
assert.ok(managedDrafting.drafts[0].wordCount >= 80 && managedDrafting.drafts[0].wordCount <= 130);
assert.equal(managedDrafting.templateBatch.maxContactsPerCompany, 4);
assert.equal(workerConfig({ PIPELINE_MANAGED_SEND_COMPANY_THRESHOLD: "120" }).managedSendCompanyThreshold, 120);

const genericDrafting = await draftContacts(
  { people: [], companyContacts: [{ company: "Publisher Inc.", companyKey: "PUBLISHER INC", email: "team@example.test", syntaxStatus: "syntax_valid", title: "" }] },
  { buyers: [{ companyKey: "PUBLISHER INC", company: "Publisher Inc.", country: "US" }] },
  { hsCode: "4903000", automation: { mode: "managed" } },
  { senderCompany: "DaKings Printing Company", companyBusiness: "DaKings provides book printing, binding, packaging, and finishing services.", productFocus: "", draftLimit: 20, draftDelayMs: 1500, draftContactsPerCompany: 1 },
  async () => { throw new Error("generic managed templates must not call AI"); },
);
assert.equal(genericDrafting.drafts[0].contactName, "Purchasing Team");
assert.equal(genericDrafting.drafts[0].contactRole, "Purchasing Team");

console.log(JSON.stringify({ ok: true, buyers: buyers.buyers.length, people: enrichment.people.length, companyContacts: enrichment.companyContacts.length, drafts: drafting.drafts.length, companyResume: 50 }));
