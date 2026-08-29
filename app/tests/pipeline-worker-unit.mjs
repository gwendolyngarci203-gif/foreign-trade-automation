import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  draftContacts,
  enrichContacts,
  matchBuyers,
  normalizeTrades,
  validateContacts,
  validateDiscovery,
  workerConfig,
} from "../pipeline-worker.mjs";

const workerSource = await fs.readFile(new URL("../pipeline-worker.mjs", import.meta.url), "utf8");
assert.match(workerSource, /timeoutMs:\s*150_000/, "AI drafting must allow the local API to finish its bounded upstream request");
assert.match(workerSource, /const draftLimit = managed \? 200 : config\.draftLimit/, "managed drafting must target the full 200-message daily batch");
assert.match(workerSource, /daily-batch\?limit=200&central=1/, "managed worker must scan existing central-batch drafts");
assert.match(workerSource, /pipeline\/inventory\?limit=200/, "managed worker must gate sending on combined company inventory");
assert.match(workerSource, /central-batch\/send[\s\S]{0,300}timeoutMs:\s*25\s*\*\s*60_000/, "managed central sending must outlive a full sequential SMTP batch");
assert.match(workerSource, /await runManagedBatchScan\(config\)/, "managed worker must scan before and after claimed work");

const discovery = validateDiscovery({
  kind: "netease-customs-discovery",
  query: "000000",
  normalizedHsCode: "000000",
  pagination: {},
  source: { resultTotal: 31607, pageTotal: 500 },
  records: [
    { rowKey: "a", company: "Buyer Company", country: "美国", hsCode: "0000000000", amountUsd: "10,000.00", transactions: "8", hasContact: true },
    { rowKey: "b", company: "Forward Freight LLC", country: "美国", hsCode: "000000", amountUsd: "未公开", transactions: "2", hasContact: false },
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
    { company: "Buyer Company", name: "Alice Buyer", title: "Purchasing Manager", email: "alice@example.test", source: "visible-detail", evidenceSources: ["https://www.linkedin.com/in/alice-buyer"] },
    { company: "Buyer Company", name: "", email: "info@example.test", phone: "+1 555 0000", source: "company-site" },
    { company: "Unknown Co.", name: "Ignored", email: "ignored@example.test", source: "unmatched" },
  ],
});
assert.equal(enrichment.people.length, 1);
assert.equal(enrichment.companyContacts.length, 1);
assert.equal(enrichment.coverage.coveredBuyers, 1);
assert.equal(enrichment.coverage.uncoveredBuyers, 1);
assert.deepEqual(enrichment.people[0].evidenceSources, ["https://www.linkedin.com/in/alice-buyer"]);

const validation = validateContacts(enrichment);
assert.equal(validation.people[0].syntaxStatus, "syntax_valid");
assert.equal(validation.people[0].validationStatus, "unverified");
assert.match(validation.limitation, /not_deliverability/);

const draftRequests = [];
const drafting = await draftContacts(
  validation,
  buyers,
  { hsCode: "000000" },
  {
    senderCompany: "Your Company",
    senderName: "Emma",
    senderTitle: "",
    senderEmail: "emma@example.test",
    senderPhone: "",
    senderWebsite: "",
    companyBusiness: "Verified manufacturing and fulfillment services.",
    productFocus: "",
    draftLimit: 20,
    draftDelayMs: 1500,
  },
  async (request) => {
    draftRequests.push(request);
    return {
      subject: `A practical option for ${request.buyerCompany}`,
      body: `Hi ${request.contactName},\n\nA concise, evidence-based test draft.`,
      model: "gpt-5.2-test",
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
assert.match(draftRequests[0].productFocus, /internally matched HSCode/);
assert.match(drafting.limitation, /human_approval/);

const managedDrafting = await draftContacts(
  { people: [validation.people[0], { ...validation.people[0], name: "Bob Buyer", email: "bob@example.test", title: "Editorial Director" }] },
  buyers,
  { hsCode: "000000", automation: { mode: "managed" } },
  { senderCompany: "Your Company", companyBusiness: "Your Company provides the products and services in its verified business profile.", productFocus: "", draftLimit: 20, draftDelayMs: 1500 },
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
  { people: [], companyContacts: [{ company: "Buyer Company", companyKey: "BUYER COMPANY", email: "team@example.test", syntaxStatus: "syntax_valid", title: "" }] },
  { buyers: [{ companyKey: "BUYER COMPANY", company: "Buyer Company", country: "US" }] },
  { hsCode: "000000", automation: { mode: "managed" } },
  { senderCompany: "Your Company", companyBusiness: "Your Company provides the products and services in its verified business profile.", productFocus: "", draftLimit: 20, draftDelayMs: 1500, draftContactsPerCompany: 1 },
  async () => { throw new Error("generic managed templates must not call AI"); },
);
assert.equal(genericDrafting.drafts[0].contactName, "Purchasing Team");
assert.equal(genericDrafting.drafts[0].contactRole, "Purchasing Team");

console.log(JSON.stringify({ ok: true, buyers: buyers.buyers.length, people: enrichment.people.length, companyContacts: enrichment.companyContacts.length, drafts: drafting.drafts.length }));
