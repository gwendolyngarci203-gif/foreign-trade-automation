import assert from "node:assert/strict";
import { buildApprovalAdapterResult } from "../services/approval-adapter.mjs";

const job = { id: "pipe_fixture", hsCode: "4903000" };
const baseDraft = { company: "Example Co", contactRole: "Buyer", email: "a@example.com", subject: "Hello", body: "A complete message.", evidenceSources: ["https://example.com", "https://example.org"], companySize: "small" };
const artifact = { schemaVersion: 1, kind: "pipeline-email-drafts", hsCode: "4903000", productFocus: "books", drafts: [baseDraft] };

const approved = buildApprovalAdapterResult({ job, artifact, context: { traceId: "trace_fixture" } });
assert.equal(approved.decision.decision, "approved");
assert.equal(approved.transitionRequest.action, "complete_approval");
assert.equal(approved.transitionRequest.requiresExplicitSend, true);
assert.equal(approved.audit.observability.traceId, "trace_fixture");

const softWarning = buildApprovalAdapterResult({ job, artifact: { ...artifact, drafts: [{ ...baseDraft, contactRole: "", companySize: "" }] } });
assert.equal(softWarning.decision.decision, "approved");
assert.ok(softWarning.decision.softWarnings.length >= 1);

const rejected = buildApprovalAdapterResult({ job, artifact: { ...artifact, drafts: [{ ...baseDraft, body: "TODO" }] } });
assert.equal(rejected.decision.decision, "rejected");
assert.equal(rejected.transitionRequest.action, "record_approval_rejection");
assert.equal(rejected.transitionRequest.nextStage, "approval");

const hardFail = buildApprovalAdapterResult({ job, artifact: { ...artifact, drafts: [{ ...baseDraft, email: "" }] } });
assert.ok(hardFail.decision.hardFails.includes("MISSING_RECIPIENT"));
assert.equal(hardFail.audit.type, "pipeline_auto_approval_rejected");
console.log("approval adapter unit passed");
