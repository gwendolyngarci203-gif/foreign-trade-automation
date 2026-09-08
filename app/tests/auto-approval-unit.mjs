import assert from "node:assert/strict";
import { evaluateAutoApproval } from "../auto-approval.mjs";

const job = { hsCode: "4903000" };
const valid = {
  schemaVersion: 1, kind: "pipeline-email-drafts", hsCode: "4903000", productFocus: "children's books",
  drafts: [{ company: "Example Co", contactName: "A", contactRole: "Buyer", email: "a@example.com", subject: "Hello", body: "A complete message.", evidenceSources: ["https://example.com"] }],
};

const pass = evaluateAutoApproval(job, valid);
assert.equal(pass.decision, "approved");
assert.deepEqual(pass.hardFails, []);
assert.ok(pass.softWarnings.includes("INCOMPLETE_EVIDENCE"));
assert.ok(pass.softWarnings.includes("UNKNOWN_COMPANY_SIZE"));
for (const [field, expected] of [["email", "MISSING_RECIPIENT"], ["company", "MISSING_COMPANY"], ["subject", "EMPTY_SUBJECT_OR_BODY"]]) {
  const draft = { ...valid.drafts[0], [field]: "" };
  assert.ok(evaluateAutoApproval(job, { ...valid, drafts: [draft] }).hardFails.includes(expected));
}
assert.ok(evaluateAutoApproval(job, { ...valid, drafts: [{ ...valid.drafts[0], body: "TODO" }] }).hardFails.includes("PLACEHOLDER_LEAK"));
assert.ok(evaluateAutoApproval(job, { ...valid, hsCode: "840000" }).hardFails.includes("PRODUCT_MISMATCH"));
assert.ok(evaluateAutoApproval(job, { ...valid, kind: "wrong" }).hardFails.includes("SCHEMA_ERROR"));
console.log("auto approval unit passed");
