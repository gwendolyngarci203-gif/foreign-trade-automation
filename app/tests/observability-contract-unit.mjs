import assert from "node:assert/strict";
import {
  buildClassifiedMetrics,
  createEventEnvelope,
  inheritEventEnvelope,
  legacyClassificationView,
  reconcileMetrics,
  validateEventEnvelope,
} from "../observability.mjs";

const envelope = createEventEnvelope({
  classification: "production",
  origin: "pipeline_job",
  runType: "production",
  isBillableProduction: true,
  createdBy: "service:test",
  traceId: "trace_contract_1",
  createdAt: "2026-09-07T00:00:00.000Z",
});
assert.equal(validateEventEnvelope(envelope).valid, true);
assert.equal(validateEventEnvelope({ ...envelope, traceId: "" }).valid, false);
assert.equal(createEventEnvelope({ classification: "canary", runType: "controlled_canary", isBillableProduction: true }).isBillableProduction, false);
const child = inheritEventEnvelope({ id: "pipe_contract", observability: envelope }, { origin: "pipeline_artifact" });
assert.equal(child.traceId, envelope.traceId);
assert.equal(child.classification, "production");

const jobs = [{
  id: "job-production",
  classification: "production",
  artifacts: [{ stage: "drafting", at: "2026-09-07T01:00:00.000Z", counts: { draftedContacts: 1 } }],
  audit: [{ type: "pipeline_auto_approved", at: "2026-09-07T01:00:01.000Z", draftIndexes: [0] }],
}, {
  id: "job-canary",
  campaignId: "phase12.1-c-system-alert-canary",
  artifacts: [{ stage: "drafting", at: "2026-09-07T01:00:00.000Z", counts: { draftedContacts: 4 } }],
}];
const metrics = buildClassifiedMetrics({
  jobs,
  outboxEntries: [{ id: "out-canary", campaignId: "phase12.1-c-smtp-canary", createdAt: "2026-09-07T01:00:00.000Z", status: "accepted", events: [{ status: "accepted", at: "2026-09-07T01:00:02.000Z" }] }],
  feedbackEvents: [],
  businessDate: "2026-09-07",
  businessDateFor: (date) => date.toISOString().slice(0, 10),
});
assert.equal(metrics.production.draft, 1);
assert.equal(metrics.production.approved, 1);
assert.equal(metrics.canaryTest.canary, 1);
assert.equal(metrics.production.sent, 0);
assert.equal(metrics.recovery.retry, 0);
assert.equal(legacyClassificationView({ kind: "sandbox_event" }, "event").readOnly, true);
const reconciliation = reconcileMetrics({ draftsGenerated: 1, autoApproved: 1, outboxCreated: 0, accepted: 0, failed: 0 }, metrics, { total: metrics.mappingCount });
assert.equal(reconciliation.readOnly, true);
assert.match(reconciliation.mappingRule, /legacy_mapping/);
assert.equal(reconciliation.metricReconciliation.draft.raw, 1);
assert.equal(reconciliation.metricReconciliation.approval.classified, 1);

console.log("observability contract unit passed");
