import assert from "node:assert/strict";

import { indexValidationResults, selectManagedCompanies, validateManagedPlan } from "../../tools/managed-hscode-plan.mjs";

const plan = validateManagedPlan({
  schemaVersion: 1,
  planId: "managed-test",
  mode: "managed",
  hsCodes: [{ hsCode: "4903000", startPage: 8 }],
  dailyBudgets: { buyerEntries: 1200, emailSends: 999, globalEmailHardCap: 999 },
});
assert.equal(plan.hsCodes[0].startPage, 8);
assert.equal(plan.dailyBudgets.emailSends, 999);
assert.equal(plan.dailyBudgets.globalEmailHardCap, 999);
assert.equal(plan.dailyBudgets.buyerEntries, 2000);
assert.equal(plan.dailyBudgets.companyDetails, 400);
assert.deepEqual(plan.deliveryPolicy, { maxContactsPerCompanyDaily: 2, validEmailCompaniesDaily: 400, draftContactsPerCompany: 4, dailyDraftTarget: 999, reviewMode: "central_batch" });
assert.deepEqual(plan.mandatoryHumanGates, ["captcha", "credential_error", "permission", "mfa"]);

assert.throws(() => validateManagedPlan({ schemaVersion: 1, mode: "managed", planId: "x", hsCodes: [] }), /至少需要一个/);
assert.throws(() => validateManagedPlan({ schemaVersion: 1, mode: "managed", planId: "x", hsCodes: [{ hsCode: "4903000" }, { hsCode: "4903000" }] }), /重复/);

const selected = selectManagedCompanies({
  kind: "netease-customs-discovery",
  source: { query: "4903000" },
  safety: { captcha: false, rateLimited: false, accountError: false },
  records: [
    { company: "Lower", hasContact: true, amountUsd: "100", row: 1 },
    { company: "No contact", hasContact: false, amountUsd: "999", row: 2 },
    { company: "Higher", hasContact: true, amountUsd: "2,000", row: 3 },
  ],
}, { ...plan, dailyBudgets: { ...plan.dailyBudgets, companyDetails: 1 } }, "4903000");
assert.deepEqual(selected.map((item) => item.company), ["Higher"]);
assert.deepEqual(selectManagedCompanies({
  kind: "netease-customs-discovery",
  source: { query: "4903000" },
  safety: {},
  records: [{ company: "Seen Inc.", country: "US", hasContact: true, amountUsd: "10" }, { company: "Fresh Inc.", country: "MX", hasContact: true, amountUsd: "9" }],
}, { ...plan, hsCodes: [{ ...plan.hsCodes[0], countries: ["MX"] }] }, "4903000", new Set(["Seen Inc."])).map((item) => item.company), ["Fresh Inc."]);
assert.throws(() => selectManagedCompanies({ kind: "netease-customs-discovery", source: { query: "4903000" }, safety: { captcha: true }, records: [] }, plan, "4903000"), /安全信号/);
assert.deepEqual(indexValidationResults(["one@example.com", "two@example.com"], [{ status: "domain_valid" }, { status: "unverified" }]), {
  "one@example.com": { status: "domain_valid" },
  "two@example.com": { status: "unverified" },
});

console.log(JSON.stringify({ ok: true, planId: plan.planId, hardCap: plan.dailyBudgets.globalEmailHardCap }));
